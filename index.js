/**
 * dsh-token-dashboard — server half
 *
 * Watches the committed session event stream and folds it into per-session token
 * totals + a per-step trend series. On startup, asynchronously backfills the
 * same fold over every durable `.jsonl.zstd` session log under
 * `$DSH_HOME/sessions`, so a fresh dsh web boot shows historical usage for
 * every existing session — not just sessions created live after the plugin
 * loaded.
 *
 * Two data sources, one algorithm: both the live `session/event` stream and the
 * replayed historical events go through {@link foldEvent}, which mirrors the
 * token-meter projection's per-(turn, step) usage deduplication (a later sample
 * for the same (turn, step) replaces the earlier one; a new (turn, step) flushes
 * the previous bucket into the cumulative totals and emits one trend point).
 *
 * Output: `GET /token-dashboard/api` serves the JSON the browser widget polls.
 * An optional `?range=1d|7d|30d|all` query slices the totals + hour-trend series
 * to a trailing window; absent/`all` returns the full historical aggregate.
 *
 * Config (all keys optional):
 *   apiPath          JSON route                         (default "/token-dashboard/api")
 *   seriesSize       max trend samples kept/session    (default 600 — generous across a backfill)
 *   scanRoot         override the durable session root (default $DSH_HOME/sessions)
 *   backfillOnStart  run the historical replay       (default true)
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

/** Resolve $DSH_HOME (explicit env wins over the home default). */
function resolveHome() {
	const fromEnv = typeof process !== "undefined" && process.env.DSH_HOME;
	const trimmed = typeof fromEnv === "string" ? fromEnv.trim() : "";
	if (trimmed !== "") return trimmed;
	return join(homedir(), ".dsh");
}

/** @returns {string} absolute path of the durable session root. */
function resolveScanRoot(config) {
	if (config && typeof config.scanRoot === "string" && config.scanRoot.trim() !== "") return config.scanRoot;
	return join(resolveHome(), "sessions");
}

//#region zstd frame scan (mirrors dsh-session-persistence-jsonl/zstd; inlined to
//       avoid pulling a persistence-internal dependency — same algorithm).
/** Zstandard frame magic 0xFD2FB528 in little-endian. */
const ZSTD_MAGIC = 4247762216;
/**
 * Locate complete zstd frames in a buffer by reading their headers + block
 * lengths, without decoding content. Tails of an incomplete final frame are
 * reported as `tornStart` and must be skipped (the session writer will retry
 * them on the next append).
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

//#region foldEvent — shared folding used by both live subscription and historical replay.
/**
 * Make one fresh, empty per-session state container.
 * @param {string} id
 */
function newSessionState(id) {
	return {
		id,
		totals: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
		lastSample: null,
		series: [],
		/** @type {Map<number, import('./index.js').HourBins>} hour-start-ms → delta bucket */
		hourBins: new Map(),
		/** Fine-grained minute buckets (minute-start-ms → delta bucket). Kept as a
		 *  rolling buffer of the most recent ~25h so the 1h range can render a
		 *  per-minute trend; older minute buckets are pruned lazily on flush. */
		minuteBins: new Map(),
		/** Per-model hourly delta buckets: modelKey ("provider|model") →
		 *  Map<hour-start-ms, { in, cr, cw, out }>. Attributed from the
		 *  `data.message.source.provider/model` of each assistant/message, so the
		 *  模型 tab can slice per-model consumption by the same time ranges. */
		modelHourBins: new Map(),
		stats: null,
		context: null,
		updatedAt: null,
		/** Derived label: first real user message text, else null. */
		title: null,
		/** Agent preset id from the session header (`standard`/`code`/…), if any. */
		preset: null,
		/** createdAt from the session header, if any (ms epoch). */
		createdAt: null,
		/** True once any usage event carried a `cacheWriteTokens` field (the API
		 *  does not always report it; 0 then means "not reported", not "zero"). */
		hasCacheWrite: false,
		/** mtimeMs of the JSONL at the moment we last folded this state. */
		sourceMtime: 0,
	};
}

/**
 * Flush the previous per-(turn, step) sample into the cumulative totals and,
 * optionally, append one per-step trend point to the series.
 * @param {ReturnType<typeof newSessionState>} state
 * @param {number} t - event time (ms epoch) for the trend point.
 * @param {boolean} alsoSeries - emit a trend point (turn change or turn/end).
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
		// No surface fold is available to compute the host's projectedTokens
		// (pressure + surface − sampled surface); pressure is the approximation
		// the whole backfill path relies on, kept in sync on every flush so
		// context occupancy is always computable.
		projectedTokens: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
	};
	// Per-sample deltas — poured into the timing hour bucket regardless of whether
	// a series point is emitted, so the API can slice any time window later.
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
		// The flushed sample belongs to one model (provider|model) — pour the same
		// deltas into that model's hour buckets so the 模型 tab can be sliced by
		// the same time windows. Samples without model info land in 未知|未知 so
		// the model totals always reconcile with the global totals.
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
		// Minute-granularity bucket for the 1h range: same deltas, minute slot.
		// The buffer is rolled: once it exceeds ~25h of slots, stale minutes older
		// than 25h are pruned so backfills of long sessions stay memory-bounded.
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
 * Flatten a model content block array (or legacy plain string) to readable
 * text, collapsing whitespace and capping the length.
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
 * Fold one event into a session state.
 * @param {ReturnType<typeof newSessionState>} state
 * @param {unknown} event
 */
function foldEvent(state, event) {
	if (!event || typeof event !== "object") return;
	const type = event.type;
	const data = event.data;
	if (type === "user/message" && data && typeof data === "object" && state.title === null) {
		// Derive a human-readable label from the first REAL user prompt
		// (source.kind === "user"); plugin-injected context is not a title.
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
		// The generating model rides on data.message.source (older records may
		// carry it on data.source instead). Glob both; missing → "未知" so the
		// model tab still reconciles with the global totals.
		let src = null;
		if (data.message && typeof data.message === "object" && data.message.source && typeof data.message.source === "object") {
			src = data.message.source;
		} else if (data.source && typeof data.source === "object") {
			src = data.source;
		}
		const provider = src && typeof src.provider === "string" ? src.provider : "";
		// Prefer the server-routed model name when the provider reports one:
		// Auto/routing providers (e.g. 火山方舟 ark) attribute tokens to the model
		// that actually served them (replayState.response.responseModel, e.g.
		// kimi-k3), which differs from the requested config name (source.model).
		// Fall back to source.model when no routed name was reported.
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
		// Increment API call counters for this event
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
		// Track contextWindow; keep pressure/projected in sync even when the
		// event arrives after a turn/end flushed lastSample to null.
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

//#region backfill — scan durable session logs and replay every event into the state map.
/**
 * Parse one `.jsonl.zstd` into header + events. Returns null when the file is
 * absent or unreadable / unscannable.
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
		/* fall back to 0 so the next backfill always re-folds */
	}
	return { id: headerId, cwd: headerCwd, preset: headerPreset, createdAt: headerCreatedAt, events: decoded, mtimeMs };
}

/**
 * Fold one durable session log into the state map, but only when the file has
 * changed since we last folded this session (cheap skip on the common case of
 * periodic backfill ticks).
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
 * Walk $DSH_HOME/sessions for `.jsonl.zstd` files and fold every one.
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

//#region time-window aggregation — slice per-session hour buckets by a range.
const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const RANGE_MS = {
	"1h": HOUR_MS,
	"1d": DAY_MS,
	"7d": 7 * DAY_MS,
	"30d": 30 * DAY_MS,
};

/**
 * Map a `?range=` query value to a window length in ms. Anything unknown /
 * absent → `null` meaning "everything".
 * @param {string | null | undefined} range
 * @returns {number | null}
 */
function rangeToMs(range) {
	if (typeof range !== "string") return null;
	return RANGE_MS[range.trim().toLowerCase()] ?? null;
}

/** Upper bound on trend points served to the client; longer windows widen the
 *  per-point step (2h/3h/…) while keeping an even time axis. */
const MAX_TREND_POINTS = 1000;

const MINUTE_MS = 60000;

/**
 * Fold a session's timing buckets that intersect a window into a running
 * aggregate, returning the session's in-window totals and a **continuous**
 * series: every slot from the window start to now is present, empty slots
 * zero-filled, so charts show a uniform time axis instead of only plotting
 * slots that had activity. The granularity is per-hour by default and
 * per-minute for mode "minute" (used by the 1h range, which renders a
 * per-minute trend from minuteBins). Very long windows widen the step
 * (k-slot buckets) instead of truncating history.
 * @param {ReturnType<typeof newSessionState>} state
 * @param {number} start - window start (ms epoch).
 * @param {number} endMs - window end (ms epoch, usually now).
 * @param {"hour" | "minute"} [mode] - bucket granularity (default "hour").
 * @returns {{ totals: { uncached: number, cacheRead: number, cacheWrite: number, output: number, calls: number }, series: Array<{ t: number, in: number, cr: number, cw: number, out: number, calls: number }> }}
 */
function sliceSession(state, start, endMs, mode) {
	const bins = mode === "minute" ? state.minuteBins : state.hourBins;
	const slotMs = mode === "minute" ? MINUTE_MS : HOUR_MS;
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
		for (let hk = t; hk < to; hk += slotMs) {
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
 * Aggregate every session inside a window into per-session + all-session
 * totals and a merged continuous hour-trend series.
 * @param {Map<string, ReturnType<typeof newSessionState>>} sessions
 * @param {number | null} rangeMs - null means all history.
 * @returns {{ start: number, totals: { uncached: number, cacheRead: number, cacheWrite: number, output: number }, series: Array<{ t: number, in: number, cr: number, cw: number, out: number, hitPct: number }>, sessionTotals: Map<string, { uncached: number, cacheRead: number, cacheWrite: number, output: number }>, sessionSeries: Map<string, Array<object>> }}
 */
function aggregateWindow(sessions, rangeMs) {
	const now = Date.now();
	let start = rangeMs == null ? 0 : now - rangeMs;
	// "all": start at the earliest recorded hour rather than 1970. Model hour
	// buckets are always a subset of hourBins in practice, but scan both so an
	// aggregate over model-only states still spans the full history.
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
	// The 1h range renders per-minute; every other range stays per-hour.
	const mode = rangeMs === HOUR_MS ? "minute" : "hour";
	const totals = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
	const hourMap = new Map();
	const sessionTotals = new Map();
	const sessionSeries = new Map();
	for (const [id, state] of sessions) {
		if (state.hourBins.size === 0 && state.minuteBins.size === 0) continue; // never had activity
		const sliced = sliceSession(state, start, now, mode);
		const sTot = sliced.totals;
		if (sTot.uncached + sTot.cacheRead + sTot.cacheWrite + sTot.output > 0) {
			// Only keep sessions that actually contributed within the window.
			sessionTotals.set(id, sTot);
			sessionSeries.set(id, sliced.series);
			totals.uncached += sTot.uncached;
			totals.cacheRead += sTot.cacheRead;
			totals.cacheWrite += sTot.cacheWrite;
			totals.output += sTot.output;
			totals.calls += sTot.calls;
			// All sessions share the same hour grid (identical window), so the
			// merged map naturally stays continuous.
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
 * Aggregate per-model consumption inside a window by summing every session's
 * per-model hour buckets. Model identity is the provider/model pair carried by
 * each assistant/message (unknown pairs fall back to 未知|未知). Share is
 * computed over the model's 总消耗 (uncached input + output only), the same real
 * API-burn definition the charts use. No monetary estimates: token counts are
 * exact from the session logs, money is not (see the DeepSeek balance tab).
 * @param {Map<string, ReturnType<typeof newSessionState>>} sessions
 * @param {number} start - window start (ms epoch).
 * @param {number} endMs - window end (ms epoch, usually now).
 * @returns {Array<{ provider: string, model: string, totals: { uncached: number, cacheRead: number, cacheWrite: number, output: number }, hitPct: number, sharePct: number }>}
 *   sorted by 总消耗 (uncached + output) descending.
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
	const grand = list.reduce((a, r) => a + r.uncached + r.output, 0);
	return list
		.map((r) => {
			const billed = r.uncached + r.cacheRead + r.cacheWrite;
			return {
				provider: r.provider,
				model: r.model,
				totals: { uncached: r.uncached, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, output: r.output, calls: r.calls },
				hitPct: billed > 0 ? Math.round((r.cacheRead / billed) * 10000) / 100 : 0,
				sharePct: grand > 0 ? Math.round(((r.uncached + r.output) / grand) * 10000) / 100 : 0,
			};
		})
		.sort((a, b) => b.totals.uncached + b.totals.output - (a.totals.uncached + a.totals.output));
}
//#endregion

//#region DeepSeek official account balance — fetched from the official API when
//       a key is configured (config `deepseekApiKey` or env `DEEPSEEK_API_KEY`).
//       Official docs: https://api-docs.deepseek.com/api/get-user-balance/
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const DEFAULT_BALANCE_REFRESH_MS = 30 * 60 * 1000;

/**
 * Normalize the official `/user/balance` response into display-friendly numbers.
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
 * Normalize + dedupe a raw sample list into a clean chronological history.
 * Unknown/corrupt entries are dropped; samples are sorted by `t` (ascending)
 * and capped at `max`.
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

/** Default on-disk location for the persisted balance history. */
function defaultBalanceFile() {
	return join(resolveHome(), "dsh-token-dashboard-balance.json");
}

/**
 * Load a persisted balance history file. Returns [] for missing/corrupt files
 * (a fresh start) rather than throwing.
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
		/* missing or unreadable → start empty */
	}
	return [];
}

/**
 * Persist the balance history atomically (write temp + rename). Failures are
 * reported through the optional logger and never break the caller.
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
 * Query the official DeepSeek balance endpoint. `fetchFn` is injectable for
 * tests and defaults to the global fetch.
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

//#region plugin apply
/**
 * Plugin body.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
	const apiPath = typeof config.apiPath === "string" && config.apiPath.trim() !== "" ? config.apiPath : DEFAULT_API_PATH;
	const seriesSize = clampInt(config.seriesSize, 1, 100000, DEFAULT_SERIES_SIZE);
	const backfillOnStart = config.backfillOnStart !== false;
	const scanRoot = resolveScanRoot(config);
	// Official DeepSeek account balance — key from config or env; the key itself
	// is NEVER shipped in the payload, only `configured` and the fetched numbers.
	// Each successful fetch appends a sample to `history`, so the widget can show
	// how much balance was consumed over the last hour / day / week (the only
	// real money signal we have — token logs carry amounts, prices do not).
	const deepseekApiKey =
		(typeof config.deepseekApiKey === "string" && config.deepseekApiKey.trim() !== "" ? config.deepseekApiKey.trim() : "") ||
		(typeof process !== "undefined" && process.env && typeof process.env.DEEPSEEK_API_KEY === "string" ? process.env.DEEPSEEK_API_KEY.trim() : "");
	const balanceRefreshMs = clampInt(config.balanceRefreshMs, 30000, 6 * 24 * 3600000, DEFAULT_BALANCE_REFRESH_MS);
	const balanceFile =
		typeof config.balanceFile === "string" && config.balanceFile.trim() !== "" ? config.balanceFile.trim() : defaultBalanceFile();
	let balance = {
		configured: deepseekApiKey !== "",
		ok: false,
		error: deepseekApiKey === "" ? "未配置 DeepSeek API Key" : null,
		fetchedAt: null,
		is_available: null,
		infos: [],
		/** Ordered recent samples: [{ t, total, granted, topped }], oldest first. */
		history: [],
		/** Balance drop over 1h / 1d / 7d / all (recent sample vs oldest in window). */
		consumed: { h1: null, d1: null, d7: null, all: null },
	};
	const BALANCE_HISTORY_MAX = 4000;
	/** Compute the balance drop over each trailing window from the history. */
	function computeConsumed(now) {
		const hist = balance.history;
		const lookup = (windowMs) => {
			const cur = hist.length > 0 ? hist[hist.length - 1].total : null;
			if (typeof cur !== "number") return null;
			let from = null;
			for (let i = hist.length - 1; i >= 0; i--) {
				if (hist[i].t <= now - windowMs) {
					from = hist[i].total;
					break;
				}
			}
			if (from === null) from = hist.length > 0 ? hist[0].total : null;
			if (typeof from !== "number") return null;
			// Negative → balance went UP (recharge/grant); still report the raw delta.
			return Math.round((cur - from) * 100) / 100;
		};
		return {
			h1: lookup(3600000),
			d1: lookup(86400000),
			d7: lookup(7 * 86400000),
			all: hist.length >= 2 ? Math.round((hist[hist.length - 1].total - hist[0].total) * 100) / 100 : null,
		};
	}
	// Persist across restarts: prior samples are loaded from disk on boot, so the
	// windows and the curve keep their history instead of resetting to zero.
	if (deepseekApiKey !== "") {
		balance.history = loadBalanceHistory(balanceFile, BALANCE_HISTORY_MAX);
		balance.consumed = computeConsumed(Date.now());
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
			balance.consumed = computeConsumed(now);
			// Persist every successful sample so a restart keeps the history.
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
			balance.consumed = computeConsumed(Date.now());
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
		// Live sessions expose creation metadata on the header; capture what
		// backfill would otherwise have to read from disk later.
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
		// Most recently active session (across ALL sessions, not just the range):
		// the one that last produced an event — what the user is talking to.
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
					// In-window totals for the currently selected range.
					totals,
					stats: state.stats,
					context: state.context,
					// Per-hour series within the window for this session.
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
			// True when ANY session ever reported a cacheWriteTokens field —
			// lets the UI show "—" (not reported) instead of a misleading 0.
			hasCacheWrite: [...sessions.values()].some((s) => s.hasCacheWrite),
			config: { apiPath, seriesSize },
			count: list.length,
			backfilled,
			backfillError,
			// Global aggregates across every session within the window.
			totals: agg.totals,
			series: agg.series,
			// Per-model consumption within the window (exact token counts only —
			// monetary estimates were removed: prices change and cannot be
			// queried, so money would be stale guesswork).
			models: aggregateModels(sessions, agg.start, agg.end),
			// Official DeepSeek account balance + consumption-by-balance-drop.
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
							// Parse the `?range=` parameter properly — slicing the raw
							// query string would pass "range=1d" (the whole thing)
							// instead of "1d" and silently fall back to "all".
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

	// Schedule the historical replay after apply returns so it never blocks
	// the fiber's activation audit.
	if (backfillOnStart) {
		setImmediate(() => runBackfill(false));
	}

	// Refresh the backfill every few minutes so new durable sessions written
	// while dsh is running get folded in without a full restart. The backfill
	// is idempotent — sessions with newer JSONL mtime than what we already hold
	// are re-folded; unchanged ones are skipped.
	const refreshTimer = setInterval(() => runBackfill(true), BACKFILL_REFRESH_MS);
	if (typeof refreshTimer.unref === "function") refreshTimer.unref();

	// DeepSeek balance: fetch right after startup, then on the configured cadence.
	if (deepseekApiKey !== "") {
		setImmediate(() => {
			refreshBalance().catch(() => {});
		});
	}
	const balanceTimer = setInterval(() => {
		refreshBalance().catch(() => {});
	}, balanceRefreshMs);
	if (typeof balanceTimer.unref === "function") balanceTimer.unref();

	ctx.effect(
		function* () {
			yield () => {
				clearInterval(refreshTimer);
				clearInterval(balanceTimer);
			};
		},
		"dsh-token-dashboard: lifecycle"
	);
}
//#endregion

//#region test-only exports (NOT for runtime use — keep internals accessible to _selftest.mjs)
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
	defaultBalanceFile,
	flattenContentText,
};
//#endregion