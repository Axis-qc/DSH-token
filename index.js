/**
 * dsh-token-dashboard — 服务端半边
 *
 * 监听已提交的会话事件流，折叠为每个会话的 token 总量
 * 与按 step 的走势序列。启动时异步回填同样的折叠结果：
 * 对 `$DSH_HOME/sessions` 下每个持久化的 `.jsonl.zstd`
 * 会话日志回放历史事件，这样 dsh web 全新启动即可
 * 看到每个既有会话的历史用量——而不只是插件加载后
 * 实时新建的会话。
 *
 * 两个数据源，同一套算法：实时 `session/event` 流与回放的
 * 历史事件都经过 {@link foldEvent}，它镜像了 token-meter 投影
 * 中每次 (turn, step) 的用量去重逻辑（同一 (turn, step) 的较新
 * 采样会替换较早采样；新的 (turn, step) 会把上一桶冲刷进
 * 累计总量并产出一个走势点）。
 *
 * 输出：`GET /token-dashboard/api` 提供浏览器组件轮询所需的 JSON。
 * 可选的 `?range=1d|7d|30d|all` 查询会把总量 + 小时趋势序列
 * 裁剪到末尾时间窗口；缺省/`all` 返回完整的历史聚合。
 *
 * 配置（所有键均可选）：
 *   apiPath          JSON 路由                         (默认 "/token-dashboard/api")
 *   seriesSize       每个会话保留的最大趋势采样数    (默认 600 — 回填时也足够宽裕)
 *   scanRoot         覆盖持久化会话根目录 (默认 $DSH_HOME/sessions)
 *   backfillOnStart  是否执行历史回放       (默认 true)
 *
 * @module dsh-token-dashboard
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { decodeStorageRecord } from "@deepseek-ai/dsh-session";
import "@deepseek-ai/cordis";

export const name = "dsh-token-dashboard";

const DEFAULT_API_PATH = "/token-dashboard/api";
const DEFAULT_SERIES_SIZE = 600;
const BACKFILL_REFRESH_MS = 5 * 60 * 1000;

/** @param {unknown} value */
function clampInt(value, min, max, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 解析 $DSH_HOME（显式环境变量优先于家目录默认值）。 */
function resolveHome() {
	const fromEnv = typeof process !== "undefined" && process.env.DSH_HOME;
	const trimmed = typeof fromEnv === "string" ? fromEnv.trim() : "";
	if (trimmed !== "") return trimmed;
	return join(homedir(), ".dsh");
}

/** @returns {string} 持久化会话根目录的绝对路径。 */
function resolveScanRoot(config) {
	if (config && typeof config.scanRoot === "string" && config.scanRoot.trim() !== "") return config.scanRoot;
	return join(resolveHome(), "sessions");
}

//#region zstd 帧扫描（镜像 dsh-session-persistence-jsonl/zstd；内联是为了
//       避免引入持久化内部依赖——算法相同）。
/** Zstandard 帧魔数 0xFD2FB528（小端序）。 */
const ZSTD_MAGIC = 4247762216;
/**
 * 通过读取帧头 + 块长度来定位缓冲区中的完整 zstd 帧，无需解码内容。
 * 不完整末帧的尾部会以 `tornStart` 上报并必须跳过（会话写入器会在
 * 下一次追加时重试它们）。
 * @param {Buffer} buffer
 * @returns {{ frames: Array<{ start: number, end: number }>, tornStart?: number }}
 */
function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return { frames, tornStart: start };
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
			return { frames, tornStart: start };
		}
		offset += 4;
		if (offset === buffer.length) return { frames, tornStart: start };
		const desc = buffer.readUInt8(offset);
		offset += 1;
		if ((desc & 24) !== 0) return { frames, tornStart: start };
		const contentSizeFlag = desc >>> 6;
		const singleSegment = (desc & 32) !== 0;
		const checksum = (desc & 4) !== 0;
		const dictionaryFlag = desc & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return { frames, tornStart: start };
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) return { frames, tornStart: start };
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return { frames, tornStart: start };
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return { frames };
}
//#endregion

//#region foldEvent —— 实时订阅与历史回放共用的折叠逻辑。
/**
 * 新建一个空的会话状态容器。
 * @param {string} id
 */
function newSessionState(id) {
	return {
		id,
		totals: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
		lastSample: null,
		series: [],
		/** @type {Map<number, import('./index.js').HourBins>} 小时起始时刻（ms）→ 增量桶 */
		hourBins: new Map(),
		/** 细粒度分钟桶（minute-start-ms → 增量桶）：以滚动缓冲保留最近
		 *  约 25 小时的分钟槽，使 1h 范围能渲染每分钟的趋势；
		 *  更旧的分钟桶会在冲刷时惰性清理。 */
		minuteBins: new Map(),
		/** 每个模型的每小时增量桶：modelKey（"provider|model"）→
		 *  Map<hour-start-ms, { in, cr, cw, out }>。归属依据来自每条
		 *  `data.message.source.provider/model` 的 `assistant/message`，这样
		 *  模型 tab 就能按相同的时间范围切分各模型的消耗。 */
		modelHourBins: new Map(),
		stats: null,
		context: null,
		updatedAt: null,
		/** 派生标签：第一条真实用户消息的文本，否则为 null。 */
		title: null,
		/** 会话头部中的 agent preset id（`standard`/`code`/…），若有。 */
		preset: null,
		/** 会话头部中的 createdAt，若有（ms 时间戳）。 */
		createdAt: null,
		/** 只要任一用量事件携带过 `cacheWriteTokens` 字段即为 true（API
		 *  并非总会上报该字段；此时 0 表示"未上报"，而不是"为零"）。 */
		hasCacheWrite: false,
		/** 上次折叠该状态时 JSONL 的 mtimeMs。 */
		sourceMtime: 0,
	};
}

/**
 * 把上一个 (turn, step) 采样冲刷进累计总量，并可选地
 * 向序列追加一个按 step 的走势点。
 * @param {ReturnType<typeof newSessionState>} state
 * @param {number} t - 走势点对应的事件时间（ms 时间戳）。
 * @param {boolean} alsoSeries - 是否产出一个走势点（turn 变化或 turn/end 时）。
 */
function flushLastSample(state, t, alsoSeries) {
	const last = state.lastSample;
	if (last === null) return;
	const u = last.usage;
	const prev = { ...state.totals };
	state.totals.uncached += u.inputTokens ?? 0;
	state.totals.cacheRead += u.cacheReadTokens ?? 0;
	state.totals.cacheWrite += u.cacheWriteTokens ?? 0;
	state.totals.output += u.outputTokens ?? 0;
	state.context = {
		...(state.context ?? {}),
		pressureTokens: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
		// 没有 surface 折叠可用以计算宿主的 projectedTokens
		// （pressure + surface − sampled surface）；pressure 是整条回填
		// 路径所依赖的近似值，在每次冲刷时保持同步，以便
		// 上下文占用始终可计算。
		projectedTokens: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
	};
	// 每次采样的增量——无论是否产出走势点，都会倒入对应时刻的
	// 小时桶，这样 API 之后可以按任意时间窗口切片。
	const dIn = state.totals.uncached - prev.uncached;
	const dCr = state.totals.cacheRead - prev.cacheRead;
	const dCw = state.totals.cacheWrite - prev.cacheWrite;
	const dOut = state.totals.output - prev.output;
	if (typeof t === "number" && Number.isFinite(t)) {
		const hk = Math.floor(t / 3600000) * 3600000;
		let hb = state.hourBins.get(hk);
		if (!hb) {
			hb = { in: 0, cr: 0, cw: 0, out: 0, calls: 0 };
			state.hourBins.set(hk, hb);
		}
		hb.in += dIn;
		hb.cr += dCr;
		hb.cw += dCw;
		hb.out += dOut;
		// 被冲刷的采样属于某个模型（provider|model）——把相同的增量
		// 倒入该模型的小时桶，这样 模型 tab 就能按相同的时间窗口切分。
		// 没有模型信息的采样会归入 未知|未知，从而
		// 模型总量始终与全局总量对得上。
		const mk = last.modelKey;
		if (mk) {
			let mb = state.modelHourBins.get(mk);
			if (!mb) {
				mb = new Map();
				state.modelHourBins.set(mk, mb);
			}
			let mhb = mb.get(hk);
			if (!mhb) {
				mhb = { in: 0, cr: 0, cw: 0, out: 0, calls: 0 };
				mb.set(hk, mhb);
			}
			mhb.in += dIn;
			mhb.cr += dCr;
			mhb.cw += dCw;
			mhb.out += dOut;
		}
		// 1h 范围使用的分钟粒度桶：同样的增量，放入分钟槽。
		// 缓冲区是滚动的：一旦超过约 25 小时的槽位，就修剪早于
		// 25 小时的旧分钟，使长会话的回填保持内存有界。
		const mk2 = Math.floor(t / 60000) * 60000;
		let mb2 = state.minuteBins.get(mk2);
		if (!mb2) {
			mb2 = { in: 0, cr: 0, cw: 0, out: 0, calls: 0 };
			state.minuteBins.set(mk2, mb2);
		}
		mb2.in += dIn;
		mb2.cr += dCr;
		mb2.cw += dCw;
		mb2.out += dOut;
		if (state.minuteBins.size > 1500) {
			const cutoff = Date.now() - 25 * 3600000;
			for (const k of state.minuteBins.keys()) {
				if (k < cutoff) state.minuteBins.delete(k);
			}
		}
	}
	if (alsoSeries) {
		const billed = dIn + dCr + dCw;
		state.series.push({
			t,
			in: Math.max(0, dIn),
			cr: Math.max(0, dCr),
			cw: Math.max(0, dCw),
			out: Math.max(0, dOut),
			hitPct: billed > 0 ? Math.round((dCr / billed) * 100) / 100 : 0,
			cuInput: state.totals.uncached + state.totals.cacheRead + state.totals.cacheWrite,
			cuOut: state.totals.output,
		});
	}
}

/**
 * 把模型的 content 块数组（或遗留的纯字符串）展平为可读文本，
 * 折叠空白并限制长度。
 * @param {unknown} content
 * @param {number} max
 * @returns {string}
 */
function flattenContentText(content, max) {
	let text = "";
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		const parts = [];
		for (const block of content) {
			if (block && typeof block === "object" && typeof block.text === "string") parts.push(block.text);
		}
		text = parts.join(" ");
	}
	text = text.replace(/\s+/g, " ").trim();
	return text.length > max ? text.slice(0, max) + "…" : text;
}

/**
 * 把单个事件折叠进会话状态。
 * @param {ReturnType<typeof newSessionState>} state
 * @param {unknown} event
 */
function foldEvent(state, event) {
	if (!event || typeof event !== "object") return;
	const type = event.type;
	const data = event.data;
	if (type === "user/message" && data && typeof data === "object" && state.title === null) {
		// 从第一条真实的用户提示中派生人类可读的标签
		// （source.kind === "user"）；插件注入的上下文不算标题。
		const src = data.source;
		const isHuman = !src || (typeof src === "object" && (src.kind === "user" || src.kind === undefined));
		if (isHuman) {
			const flat = flattenContentText(data.content, 60);
			if (flat !== "") state.title = flat;
		}
		return;
	}
	if (type === "assistant/message" && data && typeof data === "object" && data.usage) {
		const u = data.usage;
		const turn = typeof data.turn === "number" ? data.turn : 0;
		const step = typeof data.step === "number" ? data.step : 0;
		if (!state.hasCacheWrite && typeof u === "object" && u !== null && "cacheWriteTokens" in u && u.cacheWriteTokens !== undefined) {
			state.hasCacheWrite = true;
		}
		// 生成模型位于 data.message.source 上（更旧的记录可能放在
		// data.source 上）。两者都检查；缺失时归入 "未知"，使
		// 模型 tab 仍能与全局总量对得上。
		let src = null;
		if (data.message && typeof data.message === "object" && data.message.source && typeof data.message.source === "object") {
			src = data.message.source;
		} else if (data.source && typeof data.source === "object") {
			src = data.source;
		}
		const provider = src && typeof src.provider === "string" ? src.provider : "";
		// 当 provider 上报了服务端路由的模型名时优先使用它：
		// 自动/路由类 provider（如 火山方舟 ark）会把 token 归到实际
		// 提供服务的模型上（replayState.response.responseModel，例如
		// kimi-k3），这与请求时配置的名称（source.model）不同。
		// 未上报路由名时回退到 source.model。
		let model = src && typeof src.model === "string" ? src.model : "";
		const routedModel = src && typeof src === "object" && src.replayState && typeof src.replayState === "object" && src.replayState.response && typeof src.replayState.response === "object" && typeof src.replayState.response.responseModel === "string"
			? src.replayState.response.responseModel
			: "";
		if (routedModel !== "") model = routedModel;
		const modelKey = (provider !== "") || (model !== "") ? (provider || "未知") + "|" + (model || "未知") : "未知|未知";
		if (state.lastSample !== null && (state.lastSample.turn !== turn || state.lastSample.step !== step)) {
			flushLastSample(state, event.time, true);
		}
		state.lastSample = { turn, step, usage: u, provider, model, modelKey };
		// 为该事件累加 API 调用计数
		const eventTime = typeof event.time === "number" ? event.time : Date.now();
		const minuteSlot = Math.floor(eventTime / 60000) * 60000;
		const hourSlot = Math.floor(eventTime / 3600000) * 3600000;
		// minuteBins
		let minuteBucket = state.minuteBins.get(minuteSlot);
		if (!minuteBucket) {
			minuteBucket = { in: 0, cr: 0, cw: 0, out: 0, calls: 0 };
			state.minuteBins.set(minuteSlot, minuteBucket);
		}
		minuteBucket.calls += 1;
		// hourBins
		let hourBucket = state.hourBins.get(hourSlot);
		if (!hourBucket) {
			hourBucket = { in: 0, cr: 0, cw: 0, out: 0, calls: 0 };
			state.hourBins.set(hourSlot, hourBucket);
		}
		hourBucket.calls += 1;
		// modelHourBins
		if (modelKey) {
			let modelMap = state.modelHourBins.get(modelKey);
			if (!modelMap) {
				modelMap = new Map();
				state.modelHourBins.set(modelKey, modelMap);
			}
			let modelBucket = modelMap.get(hourSlot);
			if (!modelBucket) {
				modelBucket = { in: 0, cr: 0, cw: 0, out: 0, calls: 0 };
				modelMap.set(hourSlot, modelBucket);
			}
			modelBucket.calls += 1;
		}
		if (typeof event.time === "number") state.updatedAt = event.time;
		return;
	}
	if (type === "turn/end") {
		flushLastSample(state, event.time, true);
		state.lastSample = null;
		if (!state.stats) state.stats = { turns: 0, steps: 0 };
		state.stats.turns += 1;
		if (typeof event.time === "number") state.updatedAt = event.time;
		return;
	}
	if (type === "step/end" && data) {
		if (!state.stats) state.stats = { turns: 0, steps: 0 };
		state.stats.steps += 1;
		if (typeof event.time === "number") state.updatedAt = event.time;
		return;
	}
	if (type === "request/context" && data && typeof data === "object" && typeof data.contextWindow === "number") {
		// 记录 contextWindow；即使事件在 turn/end 把 lastSample 冲刷为
		// null 之后才到达，也保持 pressure/projected 同步。
		const pressure = state.context?.pressureTokens ?? 0;
		state.context = {
			...(state.context ?? {}),
			contextWindow: data.contextWindow,
			pressureTokens: pressure,
			projectedTokens: pressure,
		};
		if (typeof event.time === "number") state.updatedAt = event.time;
	}
}
//#endregion

//#region 回填——扫描持久化会话日志，把每个事件回放进状态映射。
/**
 * 把单个 `.jsonl.zstd` 解析为头部 + 事件。当文件缺失、不可读或
 * 无法扫描时返回 null。
 * @returns {{ id: string, cwd: string | undefined, events: Array<object>, mtimeMs: number } | null}
 */
function readHeaderAndEvents(filePath, logger) {
	let buffer;
	try {
		buffer = readFileSync(filePath);
	} catch {
		return null;
	}
	const { frames } = scanZstdFrames(buffer);
	if (frames.length === 0) return null;
	const decoded = [];
	let headerId = null;
	let headerCwd;
	let headerPreset;
	let headerCreatedAt;
	for (let i = 0; i < frames.length; i++) {
		const f = frames[i];
		try {
			const text = zstdDecompressSync(buffer.subarray(f.start, f.end)).toString("utf8");
			for (const line of text.split("\n")) {
				if (line.length === 0) continue;
				let parsed;
				try {
					parsed = JSON.parse(line);
				} catch {
					continue;
				}
				const events = decodeStorageRecord(parsed);
				for (const ev of events) {
					if (ev && typeof ev === "object" && ev.type === "session" && typeof ev.id === "string") {
						headerId = ev.id;
						headerCwd = typeof ev.cwd === "string" ? ev.cwd : undefined;
						headerPreset = typeof ev.agentPreset === "string" ? ev.agentPreset : undefined;
						headerCreatedAt = typeof ev.createdAt === "number" ? ev.createdAt : undefined;
					} else if (ev && typeof ev === "object") {
						decoded.push(ev);
					}
				}
			}
		} catch (error) {
			logger?.warn?.(`dsh-token-dashboard: decoding frame ${i} of ${filePath} failed: ${String(error)}`);
			break;
		}
	}
	if (headerId === null) return null;
	let mtimeMs = 0;
	try {
		mtimeMs = statSync(filePath).mtimeMs;
	} catch {
		/* 回退为 0，这样下次回填总会重新折叠 */
	}
	return { id: headerId, cwd: headerCwd, preset: headerPreset, createdAt: headerCreatedAt, events: decoded, mtimeMs };
}

/**
 * 把一个持久化会话日志折叠进状态映射，但仅当文件自上次折叠该会话后
 * 发生变化时才执行（周期回填的常见情况下可廉价跳过）。
 * @param {Map<string, ReturnType<typeof newSessionState>>} sessions
 * @param {string} filePath
 * @param {number} seriesSize
 * @param {{ warn?: (s: string) => void }} logger
 * @returns {{ folded: boolean, samples: number, errored: boolean }}
 */
function backfillOne(sessions, filePath, seriesSize, logger) {
	const parsed = readHeaderAndEvents(filePath, logger);
	if (parsed === null) return { folded: false, samples: 0, errored: true };
	const existing = sessions.get(parsed.id);
	if (existing !== undefined && existing.sourceMtime >= parsed.mtimeMs) {
		return { folded: false, samples: existing.series.length, errored: false };
	}
	const state = newSessionState(parsed.id);
	state.cwd = parsed.cwd;
	state.preset = parsed.preset ?? null;
	state.createdAt = parsed.createdAt ?? null;
	state.sourceMtime = parsed.mtimeMs;
	for (const ev of parsed.events) foldEvent(state, ev);
	if (state.lastSample !== null) flushLastSample(state, state.updatedAt ?? Date.now(), false);
	if (state.series.length > seriesSize) state.series.splice(0, state.series.length - seriesSize);
	sessions.set(parsed.id, state);
	return { folded: true, samples: state.series.length, errored: false };
}

/**
 * 遍历 $DSH_HOME/sessions 下的 `.jsonl.zstd` 文件并逐一折叠。
 * @param {Map<string, ReturnType<typeof newSessionState>>} sessions
 * @param {string} root
 * @param {number} seriesSize
 * @param {{ warn?: (s: string) => void, info?: (s: string) => void }} logger
 */
function backfillAll(sessions, root, seriesSize, logger) {
	const stats = { sessions: 0, samples: 0, files: 0, errors: 0, skipped: 0 };
	const t0 = Date.now();
	let dirEntries;
	try {
		dirEntries = readdirSync(root, { withFileTypes: true });
	} catch (error) {
		logger?.warn?.(`dsh-token-dashboard: backfill could not read ${root}: ${String(error)}`);
		return stats;
	}
	for (const project of dirEntries) {
		if (!project.isDirectory()) continue;
		const projectPath = join(root, project.name);
		let sessionDirs;
		try {
			sessionDirs = readdirSync(projectPath, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const sess of sessionDirs) {
			if (!sess.isDirectory()) continue;
			const file = join(projectPath, sess.name, "session.jsonl.zstd");
			stats.files += 1;
			const r = backfillOne(sessions, file, seriesSize, logger);
			if (r.errored) stats.errors += 1;
			else if (r.folded) {
				stats.sessions += 1;
				stats.samples += r.samples;
			} else stats.skipped += 1;
		}
	}
	logger?.info?.(
		`dsh-token-dashboard: backfilled ${stats.sessions} session(s) (+${stats.skipped} skipped) / ${stats.samples} sample(s) / ${stats.errors} error(s) in ${Date.now() - t0}ms`
	);
}
//#endregion

//#region 时间窗口聚合——按范围切分每个会话的小时桶。
const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const RANGE_MS = {
	"1h": HOUR_MS,
	"1d": DAY_MS,
	"7d": 7 * DAY_MS,
	"30d": 30 * DAY_MS,
};

/**
 * 把 `?range=` 查询值映射为以 ms 计的时间窗口长度。未知/缺省
 * 值 → `null`，表示"全部"。
 * @param {string | null | undefined} range
 * @returns {number | null}
 */
function rangeToMs(range) {
	if (typeof range !== "string") return null;
	return RANGE_MS[range.trim().toLowerCase()] ?? null;
}

/** 返回给客户端的走势点数量上限；窗口更长时按每点加宽步长
 *  （2h/3h/…），同时保持时间轴均匀。 */
const MAX_TREND_POINTS = 1000;

const MINUTE_MS = 60000;

/**
 * 把某个会话中与窗口相交的计时桶折叠进运行中的聚合结果，返回该会话
 * 窗口内的总量和一条**连续**序列：从窗口起点到当前时刻的每个槽位
 * 都存在，空槽位以 0 填充，因此图表显示均匀的时间轴，而不是只绘制
 * 有活动的槽位。粒度默认为小时，mode 为 "minute" 时按分钟（用于
 * 1h 范围，它从 minuteBins 渲染每分钟趋势），"day" 时按天（从
 * hourBins 折叠每天的 24 小时为一天，用于 30d/全部 范围）。很长的
 * 窗口会加宽步长（k 槽位桶），而不是截断历史。
 * @param {ReturnType<typeof newSessionState>} state
 * @param {number} start - 窗口起点（ms 时间戳）。
 * @param {number} endMs - 窗口终点（ms 时间戳，通常为当前时刻）。
 * @param {"hour" | "minute" | "day"} [mode] - 桶粒度（默认 "hour"）。
 * @returns {{ totals: { uncached: number, cacheRead: number, cacheWrite: number, output: number, calls: number }, series: Array<{ t: number, in: number, cr: number, cw: number, out: number, calls: number }> }}
 */
function sliceSession(state, start, endMs, mode) {
	const bins = mode === "minute" ? state.minuteBins : state.hourBins;
	const binStepMs = mode === "minute" ? MINUTE_MS : HOUR_MS;
	const slotMs = mode === "day" ? DAY_MS : binStepMs;
	const totals = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
	const startSlot = Math.floor(start / slotMs) * slotMs;
	const endSlot = Math.floor(endMs / slotMs) * slotMs;
	const rawSlots = Math.max(1, Math.floor((endSlot - startSlot) / slotMs) + 1);
	const step = rawSlots > MAX_TREND_POINTS ? Math.ceil(rawSlots / MAX_TREND_POINTS) : 1;
	const stepMs = step * slotMs;
	const series = [];
	for (let t = startSlot; t <= endSlot; t += stepMs) {
		const b = { in: 0, cr: 0, cw: 0, out: 0, calls: 0 };
		const to = Math.min(t + stepMs, endSlot + slotMs);
		for (let hk = t; hk < to; hk += binStepMs) {
			const hb = bins.get(hk);
			if (hb) {
				b.in += hb.in;
				b.cr += hb.cr;
				b.cw += hb.cw;
				b.out += hb.out;
				b.calls += hb.calls;
			}
		}
		totals.uncached += b.in;
		totals.cacheRead += b.cr;
		totals.cacheWrite += b.cw;
		totals.output += b.out;
		totals.calls += b.calls;
		series.push({ t, in: b.in, cr: b.cr, cw: b.cw, out: b.out, calls: b.calls });
	}
	return { totals, series };
	return { totals, series };
}

/**
 * 把窗口内每个会话聚合成"按会话" + "全会话"的总量，
 * 以及合并后的连续小时趋势序列。
 * @param {Map<string, ReturnType<typeof newSessionState>>} sessions
 * @param {number | null} rangeMs - null 表示全部历史。
 * @returns {{ start: number, totals: { uncached: number, cacheRead: number, cacheWrite: number, output: number }, series: Array<{ t: number, in: number, cr: number, cw: number, out: number, hitPct: number }>, sessionTotals: Map<string, { uncached: number, cacheRead: number, cacheWrite: number, output: number }>, sessionSeries: Map<string, Array<object>> }}
 */
function aggregateWindow(sessions, rangeMs) {
	const now = Date.now();
	let start = rangeMs == null ? 0 : now - rangeMs;
	// "all"：从最早记录的小时开始，而不是 1970 年。模型小时桶
	// 在实践中总是 hourBins 的子集，但两者都扫描，以便
	// 对仅含模型状态聚合时仍能覆盖完整历史。
	if (start <= 0) {
		let earliest = Infinity;
		for (const state of sessions.values()) {
			for (const hk of state.hourBins.keys()) if (hk < earliest) earliest = hk;
			for (const bins of state.modelHourBins.values()) {
				for (const hk of bins.keys()) if (hk < earliest) earliest = hk;
			}
		}
		start = earliest === Infinity ? now : earliest;
	}
	// 1h 范围按分钟渲染；30d 与全部（null）按天渲染；其余按小时。
	const mode = rangeMs === HOUR_MS ? "minute" : rangeMs == null || rangeMs >= 30 * DAY_MS ? "day" : "hour";
	const totals = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
	const hourMap = new Map();
	const sessionTotals = new Map();
	const sessionSeries = new Map();
	for (const [id, state] of sessions) {
		if (state.hourBins.size === 0 && state.minuteBins.size === 0) continue; // 从未有过活动
		const sliced = sliceSession(state, start, now, mode);
		const sTot = sliced.totals;
		if (sTot.uncached + sTot.cacheRead + sTot.cacheWrite + sTot.output > 0) {
			// 只保留在窗口内确实有贡献的会话。
			sessionTotals.set(id, sTot);
			sessionSeries.set(id, sliced.series);
			totals.uncached += sTot.uncached;
			totals.cacheRead += sTot.cacheRead;
			totals.cacheWrite += sTot.cacheWrite;
			totals.output += sTot.output;
			totals.calls += sTot.calls;
			// 所有会话共享相同的小时网格（窗口一致），因此
			// 合并后的映射天然保持连续。
			for (const pt of sliced.series) {
				const hb = hourMap.get(pt.t) ?? { in: 0, cr: 0, cw: 0, out: 0, calls: 0 };
				hb.in += pt.in;
				hb.cr += pt.cr;
				hb.cw += pt.cw;
				hb.out += pt.out;
				hb.calls += pt.calls;
				hourMap.set(pt.t, hb);
			}
		}
	}
	const entries = [...hourMap.entries()].sort((a, b) => a[0] - b[0]);
	const series = entries.map(([t, hb]) => {
		const billed = hb.in + hb.cr + hb.cw;
		return {
			t,
			in: hb.in,
			cr: hb.cr,
			cw: hb.cw,
			out: hb.out,
			calls: hb.calls,
			hitPct: billed > 0 ? Math.round((hb.cr / billed) * 100) / 100 : 0,
		};
	});
	return { start, end: now, totals, series, sessionTotals, sessionSeries };
}

/**
 * 对窗口内的每个模型消耗做聚合：累加每个会话的按模型小时桶。
 * 模型身份由每条 assistant/message 携带的 provider/model 对构成
 * （未知对回退到 未知|未知）。占比基于模型的 总消耗 计算
 * （API 整体消耗：uncached 输入 + 缓存读取 + 缓存写入 + 输出），
 * 这与图表使用的整体消耗定义一致。
 * 不提供货币估算：token 数来自会话日志是精确的，金额则不是
 * （参见 DeepSeek 余额 tab）。
 * @param {Map<string, ReturnType<typeof newSessionState>>} sessions
 * @param {number} start - 窗口起点（ms 时间戳）。
 * @param {number} endMs - 窗口终点（ms 时间戳，通常为当前时刻）。
 * @returns {Array<{ provider: string, model: string, totals: { uncached: number, cacheRead: number, cacheWrite: number, output: number }, hitPct: number, sharePct: number }>}
 *   按 总消耗（整体，含缓存）降序排列。
 */
function aggregateModels(sessions, start, endMs) {
	const picked = new Map();
	for (const state of sessions.values()) {
		for (const [mk, bins] of state.modelHourBins) {
			let rec = picked.get(mk);
			if (!rec) {
				const sep = mk.indexOf("|");
				rec = {
					provider: sep === -1 ? mk : mk.slice(0, sep),
					model: sep === -1 ? "" : mk.slice(sep + 1),
					uncached: 0,
					cacheRead: 0,
					cacheWrite: 0,
					output: 0,
					calls: 0,
				};
				picked.set(mk, rec);
			}
			for (const [hk, b] of bins) {
				if (hk < start || hk > endMs) continue;
				rec.uncached += b.in;
				rec.cacheRead += b.cr;
				rec.cacheWrite += b.cw;
				rec.output += b.out;
				rec.calls += b.calls;
			}
		}
	}
	const list = [...picked.values()].filter((r) => r.uncached + r.cacheRead + r.cacheWrite + r.output + r.calls > 0);
	// 兼容两种形状：聚合前的原始记录（字段平铺）与映射后的条目（字段在 .totals）。
	const overallOf = (r) => {
		const t = r.totals || r;
		return t.uncached + t.cacheRead + t.cacheWrite + t.output;
	};
	const grand = list.reduce((a, r) => a + overallOf(r), 0);
	return list
		.map((r) => {
			const billed = r.uncached + r.cacheRead + r.cacheWrite;
			const ov = overallOf(r);
			return {
				provider: r.provider,
				model: r.model,
				totals: { uncached: r.uncached, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, output: r.output, calls: r.calls },
				hitPct: billed > 0 ? Math.round((r.cacheRead / billed) * 10000) / 100 : 0,
				sharePct: grand > 0 ? Math.round((ov / grand) * 10000) / 100 : 0,
			};
		})
		.sort((a, b) => overallOf(b) - overallOf(a));
}
//#endregion

//#region DeepSeek 官方账户余额——配置了 key 时从官方 API 获取
//       （config `deepseekApiKey` 或环境变量 `DEEPSEEK_API_KEY`）。
//       官方文档：https://api-docs.deepseek.com/api/get-user-balance/
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
// 官方 DeepSeek 账户余额的拉取间隔固定为 30 分钟，对齐本地时间
// 的整点与半点（:00 / :30）。

/**
 * 把官方 `/user/balance` 响应规范化为便于展示的数字。
 * @param {unknown} json
 * @returns {{ is_available: boolean, infos: Array<{ currency: string, total: number, granted: number, topped: number }> } | null}
 */
function parseBalanceJson(json) {
	if (!json || typeof json !== "object") return null;
	const infos = Array.isArray(json.balance_infos)
		? json.balance_infos
			.filter((i) => i && typeof i === "object")
			.map((i) => ({
				currency: String(i.currency ?? "CNY"),
				total: Number(i.total_balance ?? NaN),
				granted: Number(i.granted_balance ?? NaN),
				topped: Number(i.topped_up_balance ?? NaN),
			}))
		: [];
	return { is_available: json.is_available !== false, infos };
}

/**
 * 把原始采样列表规范化并去重为干净的时间序历史。
 * 未知/损坏的条目会被丢弃；采样按 `t`（升序）排序，
 * 并截断到 `max` 条。
 * @param {unknown} raw
 * @param {number} max
 * @returns {Array<{ t: number, total: number, granted: number, topped: number }>}
 */
function normalizeBalanceHistory(raw, max) {
	if (!Array.isArray(raw)) return [];
	const seen = new Set();
	const out = [];
	for (const s of raw) {
		if (!s || typeof s !== "object") continue;
		const t = Number(s.t);
		const total = Number(s.total);
		if (!Number.isFinite(t) || !Number.isFinite(total)) continue;
		if (seen.has(t)) continue;
		seen.add(t);
		out.push({
			t,
			total,
			granted: Number.isFinite(Number(s.granted)) ? Number(s.granted) : 0,
			topped: Number.isFinite(Number(s.topped)) ? Number(s.topped) : 0,
		});
	}
	out.sort((a, b) => a.t - b.t);
	if (out.length > max) out.splice(0, out.length - max);
	return out;
}

/** 持久化余额历史的默认磁盘位置。 */
function defaultBalanceFile() {
	return join(resolveHome(), "dsh-token-dashboard-balance.json");
}

/**
 * 加载持久化的余额历史文件。文件缺失/损坏时返回 []（重新开始），
 * 而不是抛异常。
 * @param {string} filePath
 * @param {number} max
 * @returns {Array<{ t: number, total: number, granted: number, topped: number }>}
 */
function loadBalanceHistory(filePath, max) {
	try {
		const parsed = JSON.parse(readFileSync(filePath, { encoding: "utf8" }));
		if (parsed && typeof parsed === "object" && Array.isArray(parsed.samples)) {
			return normalizeBalanceHistory(parsed.samples, max);
		}
	} catch {
		/* 缺失或不可读 → 从空开始 */
	}
	return [];
}

/**
 * 原子化持久化余额历史（写入临时文件 + 重命名）。失败会通过可选
 * logger 上报，绝不影响调用方。
 * @param {string} filePath
 * @param {Array<{ t: number, total: number, granted: number, topped: number }>} samples
 * @param {{ warn?: (s: string) => void }} [logger]
 */
function saveBalanceHistory(filePath, samples, logger) {
	try {
		const tmp = filePath + ".tmp";
		const text = JSON.stringify({ version: 1, samples }, null, 0);
		writeFileSync(tmp, text, { encoding: "utf8" });
		renameSync(tmp, filePath);
	} catch (error) {
		logger?.warn?.(`dsh-token-dashboard: could not persist balance history to ${filePath}: ${String(error)}`);
	}
}

/**
 * 计算各末尾时间窗口内的「余额下降量累计」（消耗的余额信号近似）：
 * 遍历相邻采样对，余额下降（prev.total > cur.total）记为消耗，余额上升
 * （充值/赠送到账）的那一段记 0；窗口边界跨段时按时间占比折算。
 * 因此：
 *  - 结果永不为负——充值/赠送不会产生"负消耗"；
 *  - h1/d1/d7/all 是嵌套累计窗口，必然满足 h1 ≤ d1 ≤ d7 ≤ all
 *    （各窗口只是同一批下降段在不同时间范围上的累加，不再是互相独立的
 *    余额差）；
 *  - 仍是真实余额信号（不是 token×定价的估算）。
 * 局限：同一采样段（默认 30 分钟）内既充值又消耗时，该段的消耗会被
 * 充值掩盖而漏计；赠送余额过期导致的余额下降会被计为消耗。
 * @param {Array<{ t: number, total: number, granted: number, topped: number }>} hist
 * @param {number} now - 窗口末端（ms 时间戳）。
 * @returns {{ h1: number|null, d1: number|null, d7: number|null, all: number|null }}
 */
function computeConsumed(hist, now) {
	if (!Array.isArray(hist) || hist.length === 0) return { h1: null, d1: null, d7: null, all: null };
	const consumedIn = (windowMs) => {
		const start = now - windowMs;
		let total = 0;
		for (let i = 0; i + 1 < hist.length; i++) {
			const a = hist[i];
			const b = hist[i + 1];
			const segStart = Math.max(a.t, start);
			const segEnd = Math.min(b.t, now);
			if (segEnd <= segStart) continue;
			const span = b.t - a.t;
			const drop = Math.max(0, a.total - b.total);
			total += span > 0 ? (drop * (segEnd - segStart)) / span : drop;
		}
		return Math.round(total * 100) / 100;
	};
	return {
		h1: consumedIn(3600000),
		d1: consumedIn(86400000),
		d7: consumedIn(7 * 86400000),
		all: consumedIn(Number.POSITIVE_INFINITY),
	};
}

/**
 * 查询官方 DeepSeek 余额接口。`fetchFn` 可注入以便测试，
 * 默认使用全局 fetch。
 * @param {string} apiKey
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<ReturnType<typeof parseBalanceJson>>}
 */
async function fetchDeepseekBalance(apiKey, fetchFn) {
	const httpFetch = fetchFn || (typeof globalThis !== "undefined" ? globalThis.fetch : undefined);
	if (typeof httpFetch !== "function") throw new Error("no fetch available in this runtime");
	const timeoutSignal =
		typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
			? AbortSignal.timeout(15000)
			: undefined;
	const res = await httpFetch(DEEPSEEK_BALANCE_URL, {
		method: "GET",
		headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" },
		signal: timeoutSignal,
	});
	if (!res || typeof res.ok !== "boolean") throw new Error("unexpected balance response");
	if (!res.ok) {
		const detail = typeof res.statusText === "string" && res.statusText !== "" ? " " + res.statusText : "";
		throw new Error("HTTP " + res.status + detail);
	}
	const text = typeof res.text === "function" ? await res.text() : String(res.body ?? "");
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error("invalid JSON from balance endpoint");
	}
	const parsed = parseBalanceJson(json);
	if (parsed === null) throw new Error("unexpected balance payload shape");
	return parsed;
}
//#endregion

//#region 插件 apply
/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
	const apiPath = typeof config.apiPath === "string" && config.apiPath.trim() !== "" ? config.apiPath : DEFAULT_API_PATH;
	const seriesSize = clampInt(config.seriesSize, 1, 100000, DEFAULT_SERIES_SIZE);
	const backfillOnStart = config.backfillOnStart !== false;
	const scanRoot = resolveScanRoot(config);
	// 官方 DeepSeek 账户余额——key 来自 config 或环境变量；key 本身
	// 绝不出现在 payload 中，只有 `configured` 与拉取到的数字。
	// 每次成功拉取都会向 `history` 追加一个采样，让组件能展示
	// 过去一小时/一天/一周消耗了多少余额（这是我们仅有的真实
	// 资金信号——token 日志带数量，但不带价格）。
	const deepseekApiKey =
		(typeof config.deepseekApiKey === "string" && config.deepseekApiKey.trim() !== "" ? config.deepseekApiKey.trim() : "") ||
		(typeof process !== "undefined" && process.env && typeof process.env.DEEPSEEK_API_KEY === "string" ? process.env.DEEPSEEK_API_KEY.trim() : "");
	const balanceFile =
		typeof config.balanceFile === "string" && config.balanceFile.trim() !== "" ? config.balanceFile.trim() : defaultBalanceFile();
	let balance = {
		configured: deepseekApiKey !== "",
		ok: false,
		error: deepseekApiKey === "" ? "未配置 DeepSeek API Key" : null,
		fetchedAt: null,
		is_available: null,
		infos: [],
		/** 有序的近期采样：[{ t, total, granted, topped }]，最早的在前。 */
		history: [],
		/** 1h / 1d / 7d / all 各窗口内的余额下降量累计（逐段累计，充值段记 0）。 */
		consumed: { h1: null, d1: null, d7: null, all: null },
	};
	const BALANCE_HISTORY_MAX = 4000;
	// 跨重启持久化：启动时从磁盘加载既有采样，这样
	// 各窗口与曲线都能保留历史，而不是清零。
	if (deepseekApiKey !== "") {
		balance.history = loadBalanceHistory(balanceFile, BALANCE_HISTORY_MAX);
		balance.consumed = computeConsumed(balance.history, Date.now());
	}
	async function refreshBalance() {
		if (deepseekApiKey === "") {
			balance = { ...balance, configured: false, ok: false, error: "未配置 DeepSeek API Key", fetchedAt: null, is_available: null, infos: [], history: [], consumed: { h1: null, d1: null, d7: null, all: null } };
			return;
		}
		try {
			const parsed = await fetchDeepseekBalance(deepseekApiKey);
			const now = Date.now();
			const cur = parsed.infos.length > 0 ? parsed.infos[0] : null;
			const hist = balance.history.slice();
			if (cur && typeof cur.total === "number" && Number.isFinite(cur.total)) {
				hist.push({ t: now, total: cur.total, granted: cur.granted, topped: cur.topped });
				if (hist.length > BALANCE_HISTORY_MAX) hist.splice(0, hist.length - BALANCE_HISTORY_MAX);
			}
			balance = { configured: true, ok: true, error: null, fetchedAt: now, is_available: parsed.is_available, infos: parsed.infos, history: hist, consumed: { h1: null, d1: null, d7: null, all: null } };
			balance.consumed = computeConsumed(balance.history, now);
			// 持久化每个成功采样，使重启后仍保留历史。
			saveBalanceHistory(balanceFile, balance.history, ctx.logger);
		} catch (error) {
			balance = {
				...balance,
				configured: true,
				ok: false,
				error: String(error && error.message ? error.message : error),
				fetchedAt: Date.now(),
				is_available: null,
				infos: [],
			};
			balance.consumed = computeConsumed(balance.history, Date.now());
		}
	}

	/** @type {Map<string, ReturnType<typeof newSessionState>>} */
	const sessions = new Map();
	let backfilled = false;
	let backfillError = null;

	function ensureSession(id) {
		let state = sessions.get(id);
		if (state === undefined) {
			state = newSessionState(id);
			sessions.set(id, state);
		}
		return state;
	}

	ctx.on("session/event", (session, event) => {
		if (!session || typeof session.id !== "string" || !event || typeof event !== "object") return;
		const state = ensureSession(session.id);
		// 实时会话会在头部暴露创建元数据；这里捕获
		// 否则回填稍后还得从磁盘读取的内容。
		const header = session.header;
		if (header && typeof header === "object") {
			if (typeof header.cwd === "string") state.cwd = header.cwd;
			if (typeof header.agentPreset === "string") state.preset = header.agentPreset;
			if (typeof header.createdAt === "number") state.createdAt = header.createdAt;
		}
		foldEvent(state, event);
		if (state.series.length > seriesSize) state.series.splice(0, state.series.length - seriesSize);
	});

	function buildPayload(rangeQuery) {
		const rangeMs = rangeToMs(rangeQuery);
		const agg = aggregateWindow(sessions, rangeMs);
		// 最近活跃的会话（在所有会话中查找，而不仅限于当前范围）：
		// 即最后一个产生事件的会话——也就是用户正在对话的那个。
		let activeId = null;
		let latest = -1;
		for (const state of sessions.values()) {
			if (typeof state.updatedAt === "number" && state.updatedAt > latest) {
				latest = state.updatedAt;
				activeId = state.id;
			}
		}
		const list = [...sessions.values()]
			.map((state) => {
				const totals = agg.sessionTotals.get(state.id);
				if (totals === undefined) return null;
				return {
					id: state.id,
					cwd: state.cwd,
					title: state.title,
					preset: state.preset,
					createdAt: state.createdAt,
					// 当前所选范围内的窗口内总量。
					totals,
					stats: state.stats,
					context: state.context,
					// 该会话在窗口内的小时序列。
					series: agg.sessionSeries.get(state.id) || [],
					updatedAt: state.updatedAt,
				};
			})
			.filter((item) => item !== null)
			.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
		return {
			ok: true,
			now: Date.now(),
			range: rangeQuery?.trim() || "all",
			activeId,
			// 只要任一会话上报过 cacheWriteTokens 字段即为 true——
			// 让 UI 显示"—"（未上报）而不是误导性的 0。
			hasCacheWrite: [...sessions.values()].some((s) => s.hasCacheWrite),
			config: { apiPath, seriesSize },
			count: list.length,
			backfilled,
			backfillError,
			// 窗口内所有会话的全局聚合。
			totals: agg.totals,
			series: agg.series,
			// 窗口内按模型的消耗（仅精确 token 数——
			// 已移除货币估算：价格会变动且无法查询，
			// 所以金额只会是过时的猜测）。
			models: aggregateModels(sessions, agg.start, agg.end),
			// 官方 DeepSeek 账户余额 + 按余额下降计算的消耗。
			balance,
			sessions: list,
		};
	}

	function sendJson(res, status, body) {
		const text = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-cache",
		});
		res.end(text);
	}

	ctx.inject(["webServer"], (injected) => {
		injected.effect(
			() =>
				injected.webServer.register({
					kind: "exact",
					path: apiPath,
					handler: async (req, res) => {
						try {
							// 正确解析 `?range=` 参数——直接切分原始查询字符串
							// 会把 "range=1d"（整个字符串）当作值，
							// 而不是 "1d"，并静默回退到 "all"。
							let rangeQuery = null;
							const rawUrl = req && typeof req.url === "string" ? req.url : "";
							try {
								rangeQuery = new URL(rawUrl, "http://localhost").searchParams.get("range");
							} catch {
								const qi = rawUrl.indexOf("?");
								if (qi !== -1) {
									let q = rawUrl.slice(qi + 1);
									const m = /(?:^|&)range=([^&]+)/.exec(q);
									rangeQuery = m ? decodeURIComponent(m[1]) : null;
								}
							}
							sendJson(res, 200, buildPayload(rangeQuery));
						} catch (error) {
							sendJson(res, 500, { ok: false, error: String(error) });
						}
					},
				}),
			"dsh-token-dashboard: api route"
		);
	});

	function runBackfill(silent) {
		try {
			backfillAll(sessions, scanRoot, seriesSize, {
				info: silent ? () => {} : (msg) => ctx.logger?.info?.(msg),
				warn: (msg) => ctx.logger?.warn?.(msg),
			});
			backfilled = true;
			backfillError = null;
		} catch (error) {
			backfillError = String(error);
			ctx.logger?.warn?.(`dsh-token-dashboard: backfill failed: ${String(error)}`);
		}
	}

	// 在 apply 返回后再调度历史回放，这样它绝不会阻塞
	// fiber 的激活审计。
	if (backfillOnStart) {
		setImmediate(() => runBackfill(false));
	}

	// 每隔几分钟刷新一次回填，这样 dsh 运行期间写入的新持久化会话
	// 无需完全重启即可被折叠进来。回填是幂等的——
	// JSONL mtime 比已持有的更新时会重新折叠；
	// 未变化的会话会被跳过。
	const refreshTimer = setInterval(() => runBackfill(true), BACKFILL_REFRESH_MS);
	if (typeof refreshTimer.unref === "function") refreshTimer.unref();

	// DeepSeek 余额：启动后立即拉取一次，之后用 setTimeout 链对齐到
	// 本地时间的整点与半点（:00 / :30）拉取，每半小时一次，
	// 采样时刻始终整齐（不再从插件启动时刻起算）。
	if (deepseekApiKey !== "") {
		setImmediate(() => {
			refreshBalance().catch(() => {});
			scheduleBalanceTick();
		});
	}
	let balanceTimer = null;
	function scheduleBalanceTick() {
		const now = new Date();
		const targetMinute = now.getMinutes() < 30 ? 30 : 60;
		const delay = targetMinute * 60000 - now.getMinutes() * 60000 - now.getSeconds() * 1000 - now.getMilliseconds();
		balanceTimer = setTimeout(() => {
			refreshBalance().catch(() => {});
			scheduleBalanceTick();
		}, delay);
		if (typeof balanceTimer.unref === "function") balanceTimer.unref();
	}

	ctx.effect(
		function* () {
			yield () => {
				clearInterval(refreshTimer);
				clearTimeout(balanceTimer);
			};
		},
		"dsh-token-dashboard: lifecycle"
	);
}
//#endregion

//#region 仅供测试的导出（非运行时使用——保持内部接口对 _selftest.mjs 可访问）
/** @internal */
export const _internal = {
	newSessionState,
	foldEvent,
	flushLastSample,
	scanZstdFrames,
	readHeaderAndEvents,
	backfillOne,
	backfillAll,
	rangeToMs,
	sliceSession,
	aggregateWindow,
	aggregateModels,
	fetchDeepseekBalance,
	parseBalanceJson,
	normalizeBalanceHistory,
	loadBalanceHistory,
	saveBalanceHistory,
	computeConsumed,
	defaultBalanceFile,
	flattenContentText,
};
//#endregion