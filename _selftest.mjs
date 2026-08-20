#!/usr/bin/env node
/**
 * _selftest.mjs — offline smoke test for dsh-token-dashboard (not shipped).
 *
 * 1. Loads the browser bundle with a fake window.__ModuleLoader__ and verifies
 *    it registers under the right id and yields a {name, apply} plugin.
 * 2. Applies the server half against a fake cordis ctx, replays a session
 *    event stream through foldEvent, and asserts trend sample math + the JSON
 *    route payload.
 * 3. Calls backfillAll against a copy of a real durable session log under
 *    `$DSH_HOME/sessions` and asserts that the cumulative totals + series
 *    reconcile with the same session event stream.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const here = (name) => pathToFileURL(join(HERE, name)).href;
let failures = 0;
const ok = (label) => console.log(`  ok  ${label}`);
const bad = (label, err) => {
	failures += 1;
	console.error(`  FAIL ${label}: ${err && err.stack ? err.stack : err}`);
};

// ── 1. browser bundle registration ───────────────────────────────────────────
console.log("[1] browser bundle");
{
	let handoff = null;
	globalThis.window = {
		__ModuleLoader__: {
			load: (h) => {
				handoff = h;
			},
		},
	};
	try {
		await import(here("client.js"));
		assert.ok(handoff, "window.__ModuleLoader__.load was called");
		assert.equal(handoff.id, "dsh-token-dashboard");
		const mod = handoff.factory((spec) => {
			throw new Error(`bundle must not require anything, tried ${spec}`);
		});
		assert.equal(mod.name, "dsh-token-dashboard");
		assert.equal(typeof mod.apply, "function");
		ok("factory registers id, exports {name, apply}, requires nothing");
	} catch (err) {
		bad("bundle load", err);
	}
}

// ── 2. server half: foldEvent + HTTP route payload ───────────────────────────
console.log("[2] server half");
{
	const session = { id: "sess-1", events: [] };
	const captured = { on: [], injects: [], effects: [], timers: [] };
	const ctx = {
		logger: { info: () => {}, warn: () => {}, error: () => {} },
		on: (name, cb) => captured.on.push([name, cb]),
		inject: (names, cb) => captured.injects.push([names, cb]),
		effect: (cb, label) => {
			captured.effects.push([cb, label]);
			return () => {};
		},
	};
	const module = await import(here("index.js"));
	assert.equal(module.name, "dsh-token-dashboard");
	assert.ok(module._internal, "internal helpers exported for tests");
	try {
		module.apply(ctx, { seriesSize: 8, backfillOnStart: false });
	} catch (err) {
		bad("apply", err);
		process.exit(1);
	}
	ok("apply ran without throwing");

	const eventCb = captured.on.find(([n]) => n === "session/event")?.[1];
	const injectCb = captured.injects.find(([n]) => n.includes("webServer"))?.[1];
	assert.ok(eventCb, "session/event subscription registered");
	assert.ok(injectCb, "webServer injection registered");

	// All fixture events land 1 minute into the CURRENT hour so the continuous
	// "all" window stays small and deterministic.
	const HOUR_MS = 3600000;
	const T0 = Math.floor((Date.now() - 5 * 60 * 1000) / HOUR_MS) * HOUR_MS + 60000;
	const HKD = Math.floor(T0 / HOUR_MS) * HOUR_MS;

	const fire = (event) => eventCb(session, { seq: 1, ...event });

	try {
		// opening real user message → session title
		fire({ type: "user/message", time: T0 + 0, data: { id: "m0", role: "user", content: [{ type: "text", text: "帮助我看一下这个插件的 token 统计实现" }], source: { kind: "user" } } });
		// plugin-injected context must NOT become the title
		fire({ type: "user/message", time: T0 + 50, data: { id: "m0b", role: "user", content: [{ type: "text", text: "文件已修改：src/foo.ts" }], source: { kind: "plugin", plugin: "dsh-tool-fs" } } });
		// step 1: turn 1, step 1 — usage A (model-1)
		fire({ type: "assistant/message", time: T0 + 100, data: { turn: 1, step: 1, usage: { inputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 200, outputTokens: 300 }, message: { role: "assistant", content: [], source: { kind: "model", provider: "demo-provider", model: "demo-model-1" } } } });
		// step 2: turn 1, step 2 — usage B (new step flushes previous as sample)
		fire({ type: "assistant/message", time: T0 + 110, data: { turn: 1, step: 2, usage: { inputTokens: 2300, cacheReadTokens: 900, cacheWriteTokens: 300, outputTokens: 800 }, message: { role: "assistant", content: [], source: { kind: "model", provider: "demo-provider", model: "demo-model-1" } } } });
		// step 3: turn 1, step 2 REPLACED (same (turn, step)) — usage B' (just replaces, no new sample)
		fire({ type: "assistant/message", time: T0 + 120, data: { turn: 1, step: 2, usage: { inputTokens: 2200, cacheReadTokens: 850, cacheWriteTokens: 250, outputTokens: 750 }, message: { role: "assistant", content: [], source: { kind: "model", provider: "demo-provider", model: "demo-model-1" } } } });
		// turn 1 ends → flushes the current sample as one trend point
		fire({ type: "turn/end", time: T0 + 130, data: { turn: 1, reason: { kind: "completed" } } });
		// turn 2, step 1 — usage C (new (turn, step) flushes turn 1's last step as sample; model-2)
		fire({ type: "assistant/message", time: T0 + 140, data: { turn: 2, step: 1, usage: { inputTokens: 3300, cacheReadTokens: 2200, cacheWriteTokens: 400, outputTokens: 1500 }, message: { role: "assistant", content: [], source: { kind: "model", provider: "demo-provider", model: "demo-model-2" } } } });
		fire({ type: "request/context", time: T0 + 141, data: { provider: "demo", model: "demo", contextWindow: 64000 } });
		fire({ type: "turn/end", time: T0 + 150, data: { turn: 2, reason: { kind: "completed" } } });

		// pull the JSON payload through the registered route handler
		let body = null;
		let status = 0;
		const res = {
			writeHead: (s) => {
				status = s;
			},
			end: (text) => {
				body = JSON.parse(text);
			},
		};
		const req = { method: "GET", url: "/token-dashboard/api" };
		const recorder = { routes: [], effect: (cb) => cb() };
		const fakeInjectCtx = new Proxy(ctx, {
			get(target, prop) {
				if (prop === "webServer") return { register: (route) => recorder.routes.push(route) };
				if (prop === "effect") return (cb) => cb();
				return target[prop];
			},
		});
		injectCb(fakeInjectCtx);
		const route = recorder.routes.find((r) => r.path === "/token-dashboard/api");
		assert.ok(route, "api route registered");
		await route.handler(req, res);
		assert.equal(status, 200);
		assert.equal(body.ok, true);
		assert.equal(body.count, 1);
		// The single session is the most recently active one → follow target.
		assert.equal(body.activeId, "sess-1", "payload exposes the most-recently-active session id");
		const s = body.sessions[0];
		assert.equal(s.id, "sess-1");
		// Title derived from the FIRST real user message; plugin injection ignored.
		assert.equal(s.title, "帮助我看一下这个插件的 token 统计实现", "title from first human user message");
		assert.equal(s.preset, null, "preset null when session header absent");
		assert.equal(s.createdAt, null, "createdAt null when session header absent");
		// Totals should reflect ALL step sample buckets (with replacement):
		//   step 1 (turn 1)  = 1000/500/200/300
		//   step 2 (turn 1)  = REPLACED by B' = 2200/850/250/750   (B never counted)
		//   step 1 (turn 2)  = 3300/2200/400/1500
		// Totals sum:
		assert.deepEqual(s.totals, { uncached: 6500, cacheRead: 3550, cacheWrite: 850, output: 2550, calls: 4 });
		// Global aggregates mirror the single session under "all".
		assert.deepEqual(body.totals, { uncached: 6500, cacheRead: 3550, cacheWrite: 850, output: 2550, calls: 4 });
		// Payload per-session series for the "all" range is DAY-bucketed and
		// CONTINUOUS: all fixture events share the current day, so the window
		// collapses to one (or at most two around a day boundary) daily point
		// carrying the whole sum.
		const ps = s.series;
		assert.ok(ps.length >= 1 && ps.length <= 2, `continuous daily series (${ps.length} point(s))`);
		assert.equal(ps[0].t, Math.floor(HKD / (24 * HOUR_MS)) * (24 * HOUR_MS), "series starts at the session's day slot");
		assert.equal(ps.reduce((a, b) => a + b.in, 0), 6500, "series carries all input");
		assert.equal(ps.reduce((a, b) => a + b.out, 0), 2550, "series carries all output");
		assert.ok(body.series.length >= 1 && body.series.length <= 2, "global series continuous");
		assert.equal(body.range, "all");
		assert.ok(body.hasCacheWrite === true, "usage carried cacheWriteTokens → hasCacheWrite true");
		// No API key configured in this test → balance is reported as unconfigured
		// (and the key itself must never leak into the payload).
		assert.equal(body.balance.configured, false, "balance reports unconfigured without a key");
		assert.equal(body.balance.ok, false, "balance not ok without a key");
		assert.ok(Array.isArray(body.balance.history) && body.balance.history.length === 0, "balance history present and empty");
		assert.deepEqual(Object.keys(body.balance.consumed).sort(), ["all", "d1", "d7", "h1"], "balance consumed windows exposed");
		assert.equal(JSON.stringify(body).includes("sk-"), false, "no API key leaks into the payload");
		// Per-model aggregation: two fixture models, sorted by 总消耗 (入+出) desc.
		//   model-1: A(1000/500/200/300) + B'(2200/850/250/750) → in 3200 cr 1350 cw 450 out 1050
		//   model-2: C(3300/2200/400/1500)                          → in 3300 cr 2200 cw 400 out 1500
		assert.equal(body.models.length, 2, "payload exposes one entry per model");
		assert.equal(body.models[0].model, "demo-model-2", "models sorted by 总消耗 desc (model-2 first)");
		assert.deepEqual(body.models[0].totals, { uncached: 3300, cacheRead: 2200, cacheWrite: 400, output: 1500, calls: 1 });
		assert.equal(body.models[0].hitPct, 37.29, "model-2 hit rate 2200/5900 = 37.29%");
		assert.equal(body.models[0].sharePct, 53.04, "model-2 burn 4800/9050 = 53.04%");
		assert.deepEqual(body.models[1].totals, { uncached: 3200, cacheRead: 1350, cacheWrite: 450, output: 1050, calls: 3 });
		assert.equal(body.models[1].hitPct, 27, "model-1 hit rate 1350/5000 = 27%");
		assert.equal(body.models[1].sharePct, 46.96, "model-1 burn 4250/9050 = 46.96%");
		assert.equal(body.models[0].provider, "demo-provider", "provider carried through");
		// Range query parsing must actually take effect (regression: the raw query
		// string used to be passed as the value, silently falling back to "all").
		status = 0;
		body = null;
		await route.handler({ method: "GET", url: "/token-dashboard/api?range=1d" }, res);
		assert.equal(body.range, "1d", "?range=1d is parsed, not passed through raw");
		assert.deepEqual(body.totals, { uncached: 6500, cacheRead: 3550, cacheWrite: 850, output: 2550, calls: 4 }, "1d window still contains the current-hour fixture");
		status = 0;
		body = null;
		await route.handler({ method: "GET", url: "/token-dashboard/api?range=7d" }, res);
		assert.equal(body.range, "7d");
		status = 0;
		body = null;
		await route.handler({ method: "GET", url: "/token-dashboard/api?range=all" }, res);
		assert.equal(body.range, "all");
		// 1h range serves a PER-MINUTE continuous series (60-61 minute slots). The
		// fixture events use a fixed current-hour slot, which can occasionally fall
		// just outside the sliding 60-minute window, so a 0-point series is legal;
		// the per-minute step is still asserted whenever there are points.
		status = 0;
		body = null;
		await route.handler({ method: "GET", url: "/token-dashboard/api?range=1h" }, res);
		assert.equal(body.range, "1h", "?range=1h is parsed");
		assert.ok(body.series.length >= 0 && body.series.length <= 61, `1h series is per-minute or empty (${body.series.length} points)`);
		if (body.series.length >= 2) {
			assert.equal(body.series[1].t - body.series[0].t, 60000, "1h series steps by exactly 1 minute");
		}
		assert.equal(s.stats.turns, 2);
		assert.equal(s.context.contextWindow, 64000);
		// Last assistant message was C, so pressureTokens = projectedTokens = 3300 + 2200 + 400 = 5900
		assert.equal(s.context.pressureTokens, 5900);
		assert.equal(s.context.projectedTokens, 5900, "projectedTokens always mirrors pressureTokens (occupancy computable)");

		// ── raw per-step fold still dedups exactly as before ──
		const { newSessionState, foldEvent, flushLastSample, rangeToMs, aggregateWindow, aggregateModels, sliceSession, flattenContentText } = module._internal;
		assert.equal(flattenContentText([{ type: "text", text: "  a\n b " }, { type: "text", text: "c" }], 60), "a b c", "flatten joins text blocks");
		assert.equal(flattenContentText([{ type: "text", text: "abcdef" }], 2), "ab…", "flatten caps length");
		const raw = newSessionState("raw");
		const fe = (ev) => foldEvent(raw, { ...ev });
		fe({ type: "user/message", time: T0 + 0, data: { id: "m0", role: "user", content: [{ type: "text", text: "帮助我看一下这个插件的 token 统计实现" }], source: { kind: "user" } } });
		fe({ type: "user/message", time: T0 + 50, data: { id: "m0b", role: "user", content: [{ type: "text", text: "文件已修改" }], source: { kind: "plugin", plugin: "dsh-tool-fs" } } });
		assert.equal(raw.title, "帮助我看一下这个插件的 token 统计实现", "raw fold derives title from first human message");
		fe({ type: "assistant/message", time: T0 + 100, data: { turn: 1, step: 1, usage: { inputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 200, outputTokens: 300 }, message: { role: "assistant", content: [], source: { kind: "model", provider: "demo-provider", model: "demo-model-1" } } } });
		fe({ type: "assistant/message", time: T0 + 110, data: { turn: 1, step: 2, usage: { inputTokens: 2300, cacheReadTokens: 900, cacheWriteTokens: 300, outputTokens: 800 }, message: { role: "assistant", content: [], source: { kind: "model", provider: "demo-provider", model: "demo-model-1" } } } });
		fe({ type: "assistant/message", time: T0 + 120, data: { turn: 1, step: 2, usage: { inputTokens: 2200, cacheReadTokens: 850, cacheWriteTokens: 250, outputTokens: 750 }, message: { role: "assistant", content: [], source: { kind: "model", provider: "demo-provider", model: "demo-model-1" } } } });
		fe({ type: "turn/end", time: T0 + 130, data: { turn: 1, reason: { kind: "completed" } } });
		fe({ type: "assistant/message", time: T0 + 140, data: { turn: 2, step: 1, usage: { inputTokens: 3300, cacheReadTokens: 2200, cacheWriteTokens: 400, outputTokens: 1500 }, message: { role: "assistant", content: [], source: { kind: "model", provider: "demo-provider", model: "demo-model-2" } } } });
		fe({ type: "request/context", time: T0 + 141, data: { provider: "demo", model: "demo", contextWindow: 64000 } });
		fe({ type: "turn/end", time: T0 + 150, data: { turn: 2, reason: { kind: "completed" } } });
		if (raw.lastSample !== null) flushLastSample(raw, raw.updatedAt ?? T0 + 150, false);
		assert.equal(raw.series.length, 3, "raw per-step flushes (A, B', C)");
		// A: bucket contribution (1000, 500, 200, 300), hitPct = 500/(1000+500+200) = 0.29
		assert.deepEqual({ in: raw.series[0].in, cr: raw.series[0].cr, cw: raw.series[0].cw, out: raw.series[0].out, hitPct: raw.series[0].hitPct }, { in: 1000, cr: 500, cw: 200, out: 300, hitPct: 0.29 });
		// B' (turn 1 step 2 replaced B): bucket contribution (2200, 850, 250, 750). hitPct = 850/(2200+850+250) = 0.26
		assert.deepEqual({ in: raw.series[1].in, cr: raw.series[1].cr, cw: raw.series[1].cw, out: raw.series[1].out, hitPct: raw.series[1].hitPct }, { in: 2200, cr: 850, cw: 250, out: 750, hitPct: 0.26 });
		// C: bucket contribution (3300, 2200, 400, 1500). hitPct = 2200/(3300+2200+400) = 0.37
		assert.deepEqual({ in: raw.series[2].in, cr: raw.series[2].cr, cw: raw.series[2].cw, out: raw.series[2].out, hitPct: raw.series[2].hitPct }, { in: 3300, cr: 2200, cw: 400, out: 1500, hitPct: 0.37 });
		assert.deepEqual(raw.totals, { uncached: 6500, cacheRead: 3550, cacheWrite: 850, output: 2550 });
		assert.equal(raw.hasCacheWrite, true, "hasCacheWrite flips when cacheWriteTokens appears");
		assert.equal(raw.context.projectedTokens, 5900, "projectedTokens reflects the last sample after turn/end");
		assert.equal(raw.hourBins.get(HKD).in, 6500, "hour bucket accumulates the window's input");
		// Per-model hour buckets reconcile with the global deltas.
		const mbSum = (key) => {
			const bins = raw.modelHourBins.get(key) || new Map();
			let sum = { in: 0, cr: 0, cw: 0, out: 0 };
			for (const b of bins.values()) {
				sum.in += b.in; sum.cr += b.cr; sum.cw += b.cw; sum.out += b.out;
			}
			return sum;
		};
		assert.deepEqual(mbSum("demo-provider|demo-model-1"), { in: 3200, cr: 1350, cw: 450, out: 1050 }, "model-1 hour buckets");
		assert.deepEqual(mbSum("demo-provider|demo-model-2"), { in: 3300, cr: 2200, cw: 400, out: 1500 }, "model-2 hour buckets");
		// Missing message.source → attributed to 未知|未知 so totals still reconcile.
		const ns = newSessionState("ns");
		foldEvent(ns, { type: "assistant/message", time: T0 + 300, data: { turn: 9, step: 1, usage: { inputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 3 } } });
		if (ns.lastSample !== null) flushLastSample(ns, T0 + 300, false);
		assert.equal(ns.modelHourBins.has("未知|未知"), true, "sample without source lands in 未知|未知");

		// ── hour buckets + range slicing (continuous series) ──
		assert.equal(rangeToMs("1h"), HOUR_MS);
		assert.equal(rangeToMs("1d"), 24 * HOUR_MS);
		assert.equal(rangeToMs("7d"), 7 * 24 * HOUR_MS);
		assert.equal(rangeToMs("30d"), 30 * 24 * HOUR_MS);
		assert.equal(rangeToMs("bogus"), null);
		assert.equal(rangeToMs(undefined), null);
		const H = HOUR_MS;
		const now = Date.now();
		const hk = (ageMs) => Math.floor((now - ageMs) / H) * H;
		const ru = newSessionState("r1");
		ru.hourBins.set(hk(2 * H), { in: 100, cr: 0, cw: 0, out: 10 });   // 2 hours ago → 1d/7d/30d/all
		ru.hourBins.set(hk(3 * 24 * H), { in: 200, cr: 0, cw: 0, out: 20 }); // 3 days ago → 7d/30d/all
		ru.hourBins.set(hk(40 * 24 * H), { in: 300, cr: 0, cw: 0, out: 30 }); // 40 days ago → all only
		const map = new Map([["r1", ru]]);
		const out = (range) => aggregateWindow(map, rangeToMs(range)).totals.output;
		assert.equal(out("1d"), 10, "1d window keeps only 2h bucket");
		assert.equal(out("7d"), 30, "7d window keeps 2h + 3d buckets");
		assert.equal(out("30d"), 30, "30d window keeps 2h + 3d buckets");
		assert.equal(out("all"), 60, "all window keeps every bucket");
		assert.equal(out(undefined), 60, "no range = all");
		const s1 = aggregateWindow(map, rangeToMs("1d")).series;
		assert.ok(s1.length >= 24 && s1.length <= 26, `1d series continuous (~25 hourly points, got ${s1.length})`);
		assert.equal(s1.reduce((a, b) => a + b.out, 0), 10, "1d series sums to window output");
		assert.equal(s1[1].t - s1[0].t, H, "1d series steps by exactly 1 hour (no gaps/jumps)");
		const s7 = aggregateWindow(map, rangeToMs("7d")).series;
		assert.ok(s7.length >= 167 && s7.length <= 170, `7d series stays hourly (${s7.length} points)`);
		assert.equal(s7[1].t - s7[0].t, H, "7d series steps by exactly 1 hour");
		const s30 = aggregateWindow(map, rangeToMs("30d")).series;
		assert.ok(s30.length >= 29 && s30.length <= 32, `30d series is daily (${s30.length} points)`);
		assert.equal(s30[1].t - s30[0].t, 24 * H, "30d series steps by exactly 1 day");
		assert.equal(s30.reduce((a, b) => a + b.out, 0), 30, "30d daily series sums to window output");
		const all2 = aggregateWindow(map, null).series;
		assert.ok(all2.length >= 39 && all2.length <= 42, `all series spans the full range in days (${all2.length} points)`);
		assert.equal(all2.reduce((a, b) => a + b.out, 0), 60, "all series sums every bucket");
		for (let i = 1; i < all2.length; i++) {
			assert.equal(all2[i].t - all2[i - 1].t, 24 * H, "uniform day step across the whole series");
		}
		// ── per-model aggregation window slicing ──
		// Buckets carry `calls` exactly like the ones foldEvent builds; omitting it
		// would make the aggregate's call sum NaN and silently drop every model.
		const rm = newSessionState("rm");
		rm.modelHourBins.set("prov-a|m-x", new Map([
			[hk(2 * H), { in: 100, cr: 10, cw: 0, out: 10, calls: 2 }],   // 2h ago → all windows
			[hk(3 * 24 * H), { in: 200, cr: 0, cw: 0, out: 20, calls: 3 }], // 3d ago → 7d/30d/all
			[hk(40 * 24 * H), { in: 300, cr: 0, cw: 0, out: 30, calls: 4 }], // 40d ago → all only
		]));
		rm.modelHourBins.set("prov-b|m-y", new Map([
			[hk(2 * H), { in: 50, cr: 0, cw: 0, out: 5, calls: 1 }],
		]));
		const mmap = new Map([["rm", rm]]);
		const agg1d = aggregateWindow(mmap, rangeToMs("1d"));
		const models1d = aggregateModels(mmap, agg1d.start, agg1d.end);
		assert.equal(models1d.length, 2, "1d model window keeps only in-window buckets");
		const mx = models1d.find((m) => m.model === "m-x");
		const my = models1d.find((m) => m.model === "m-y");
		assert.deepEqual(mx.totals, { uncached: 100, cacheRead: 10, cacheWrite: 0, output: 10, calls: 2 }, "m-x 1d totals");
		assert.deepEqual(my.totals, { uncached: 50, cacheRead: 0, cacheWrite: 0, output: 5, calls: 1 }, "m-y 1d totals");
		assert.equal(mx.sharePct, 66.67, "m-x burn 110/165 = 66.67%");
		assert.equal(my.sharePct, 33.33, "m-y burn 55/165 = 33.33%");
		assert.equal(mx.hitPct, 9.09, "m-x hit 10/110 = 9.09%");
		assert.equal(my.hitPct, 0, "m-y hit 0/50 = 0%");
		assert.equal(models1d[0].model, "m-x", "models sorted by burn desc");
		const aggAll = aggregateWindow(mmap, null);
		const modelsAll = aggregateModels(mmap, aggAll.start, aggAll.end);
		assert.deepEqual(modelsAll.find((m) => m.model === "m-x").totals, { uncached: 600, cacheRead: 10, cacheWrite: 0, output: 60, calls: 9 }, "all-window m-x sums every bucket");
		assert.deepEqual(modelsAll.find((m) => m.model === "m-y").totals, { uncached: 50, cacheRead: 0, cacheWrite: 0, output: 5, calls: 1 }, "all-window m-y");
		// Monetary estimates were removed (prices change and cannot be queried):
		// model entries must NOT carry price/cost fields anymore.
		assert.equal("price" in modelsAll[0], false, "no price field on model entries");
		assert.equal("costUsd" in modelsAll[0], false, "no costUsd field on model entries");
		assert.equal("costCny" in modelsAll[0], false, "no costCny field on model entries");
		// ── DeepSeek official balance fetch + parse ──
		const { parseBalanceJson, fetchDeepseekBalance } = module._internal;
		assert.deepEqual(
			parseBalanceJson({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "110.50", granted_balance: "10.20", topped_up_balance: "100.30" }] }),
			{ is_available: true, infos: [{ currency: "CNY", total: 110.5, granted: 10.2, topped: 100.3 }] },
			"balance JSON normalizes string amounts to numbers"
		);
		assert.equal(parseBalanceJson(null), null, "balance null payload → null");
		assert.deepEqual(parseBalanceJson({ is_available: false, balance_infos: [] }), { is_available: false, infos: [] }, "empty balance infos ok");
		const balOk = await fetchDeepseekBalance("test-key", async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "1.00", granted_balance: "0.50", topped_up_balance: "0.50" }] }),
		}));
		assert.deepEqual(balOk.infos[0], { currency: "CNY", total: 1, granted: 0.5, topped: 0.5 }, "injected fetch success path parses");
		const balErr = await fetchDeepseekBalance("k", async () => ({ ok: false, status: 401, statusText: "Unauthorized" }))
			.then(() => null, (e) => String(e && e.message ? e.message : e));
		assert.ok(balErr !== null && balErr.includes("401"), `HTTP error surfaces (got ${balErr})`);
		const balBad = await fetchDeepseekBalance("k", async () => ({ ok: true, status: 200, text: async () => "not json" }))
			.then(() => null, (e) => String(e && e.message ? e.message : e));
		assert.ok(balBad !== null && /json/i.test(balBad), `invalid JSON surfaces (got ${balBad})`);
		// ── balance history persistence (survives restarts) ──
		const { normalizeBalanceHistory, loadBalanceHistory, saveBalanceHistory } = module._internal;
		assert.deepEqual(normalizeBalanceHistory(null, 10), [], "null history → []");
		assert.deepEqual(normalizeBalanceHistory([{ t: 2, total: 20 }, { t: 1, total: 10 }, { t: 1, total: 99 }, { junk: 1 }, { t: "x", total: 1 }], 10),
			[{ t: 1, total: 10, granted: 0, topped: 0 }, { t: 2, total: 20, granted: 0, topped: 0 }],
			"history normalizes: sorted, deduped by t, corrupt dropped");
		const tmpFile = join(HERE, ".balance-fixture.json");
		const samples = [{ t: 100, total: 50, granted: 1, topped: 49 }, { t: 200, total: 40, granted: 0, topped: 40 }];
		saveBalanceHistory(tmpFile, samples, console);
		assert.deepEqual(loadBalanceHistory(tmpFile, 10), samples, "save → load round-trip preserves samples");
		writeFileSync(tmpFile, "{ not json");
		assert.deepEqual(loadBalanceHistory(tmpFile, 10), [], "corrupt file → [] without throwing");
		rmSync(tmpFile, { force: true });
		// ── 1h range: per-minute granularity from minuteBins ──
		const mn = newSessionState("mn");
		const M = 60000;
		const mhk = (ageMs) => Math.floor((Date.now() - ageMs) / M) * M;
		mn.minuteBins.set(mhk(1 * M), { in: 5, cr: 0, cw: 0, out: 1 });     // 1 min ago
		mn.minuteBins.set(mhk(30 * M), { in: 10, cr: 0, cw: 0, out: 2 });   // 30 min ago
		mn.minuteBins.set(mhk(5 * 3600000), { in: 20, cr: 0, cw: 0, out: 3 }); // 5h ago → outside 1h
		const mmap2 = new Map([["mn", mn]]);
		const agg1h = aggregateWindow(mmap2, rangeToMs("1h"));
		assert.equal(agg1h.totals.output, 3, "1h window keeps only last-60min minute buckets");
		assert.ok(agg1h.series.length >= 60 && agg1h.series.length <= 61, `1h series is continuous per-minute (${agg1h.series.length} points)`);
		assert.equal(agg1h.series[1].t - agg1h.series[0].t, 60000, "1h series steps by exactly 1 minute");
		assert.equal(agg1h.series.reduce((a, b) => a + b.out, 0), 3, "1h series sums the window output");
		// 30d on the same state still uses hour bins → minuteBins ignored.
		assert.equal(aggregateWindow(mmap2, rangeToMs("30d")).totals.output, 0, "day/hour windows ignore minute bins");
		assert.equal(sliceSession(mn, agg1h.start, agg1h.end, "minute").totals.output, 3, "sliceSession minute mode sums minute bins");
		ok("foldEvent replaces same (turn, step), continuous hour series + range slicing + per-model aggregation + 1h/minute granularity work");
	} catch (err) {
		bad("server logic", err);
	}
}

// ── 3. backfill: replay a real durable session log ───────────────────────────
console.log("[3] backfill against a real session log");
try {
	const liveHome = join(homedir(), ".dsh");
	const liveSessions = join(liveHome, "sessions");
	if (!existsSync(liveSessions)) {
		console.log("  skip (no $DSH_HOME/sessions directory)");
	} else {
		// Pick the smallest non-empty session file so the test stays fast.
		const { readdirSync, statSync } = await import("node:fs");
		const projects = readdirSync(liveSessions, { withFileTypes: true }).filter((e) => e.isDirectory());
		let smallest = null;
		for (const p of projects) {
			const pDir = join(liveSessions, p.name);
			for (const s of readdirSync(pDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
				const f = join(pDir, s.name, "session.jsonl.zstd");
				try {
					const sz = statSync(f).size;
					if (sz <= 0) continue;
					if (smallest === null || sz < smallest.size) smallest = { file: f, size: sz };
				} catch { /* skip */ }
			}
		}
		if (smallest === null) {
			console.log("  skip (no non-empty session.jsonl.zstd in $DSH_HOME)");
		} else {
			const tmpRoot = join(HERE, ".backfill-fixture");
			if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
			mkdirSync(join(tmpRoot, "proj", "sess-fixture"), { recursive: true });
			cpSync(smallest.file, join(tmpRoot, "proj", "sess-fixture", "session.jsonl.zstd"));
			const module = await import(here("index.js"));
			const sessions = new Map();
			const t0 = Date.now();
			module._internal.backfillAll(sessions, tmpRoot, 600, { info: () => {}, warn: () => {} });
			const ms = Date.now() - t0;
			assert.equal(sessions.size, 1, "backfill picked up the one fixture session");
			const state = [...sessions.values()][0];
			assert.ok(state.id && typeof state.id === "string", "session id extracted from header");
			assert.ok(state.totals.uncached >= 0 && state.totals.output >= 0, "totals numeric");
			// The smallest session file may legitimately have no assistant messages
			// (no usage at all), so an empty series is allowed; if there IS usage,
			// the series and per-model stats must be present and reconcile.
			const hadUsage = state.totals.uncached + state.totals.cacheRead + state.totals.cacheWrite + state.totals.output > 0;
			if (hadUsage) {
				assert.ok(state.series.length >= 1, `series has ${state.series.length} samples`);
				// Real logs carry data.message.source.provider/model → per-model stats.
				const bmodels = module._internal.aggregateModels(sessions, 0, Date.now());
				assert.ok(bmodels.length >= 1, "backfilled session yields per-model entries");
				assert.ok(typeof bmodels[0].provider === "string" && typeof bmodels[0].model === "string", "model entries carry provider + model");
				const modelSum = bmodels.reduce((a, m) => a + m.totals.uncached + m.totals.cacheRead + m.totals.cacheWrite + m.totals.output, 0);
				assert.equal(modelSum, state.totals.uncached + state.totals.cacheRead + state.totals.cacheWrite + state.totals.output, "per-model totals reconcile with session totals");
				// Sanity: cached cumulative should equal sum of deltas.
				if (state.series.length >= 1) {
					const last = state.series[state.series.length - 1];
					assert.equal(state.totals.uncached + state.totals.cacheRead + state.totals.cacheWrite, last.cuInput, "cumulative input reconciles");
					assert.equal(state.totals.output, last.cuOut, "cumulative output reconciles");
				}
			}
			ok(`backfill parsed ${state.series.length} samples / totals ${state.totals.uncached}/${state.totals.cacheRead}/${state.totals.cacheWrite}/${state.totals.output} in ${ms}ms`);
			rmSync(tmpRoot, { recursive: true, force: true });
		}
	}
} catch (err) {
	bad("backfill", err);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);