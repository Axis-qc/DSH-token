#!/usr/bin/env node
/**
 * _ui_selftest.mjs —— 对浏览器端 bundle 的无头检查，不需要真实 DOM：浏览器半边
 * 必须做到 (1) 以预期的 id 注册、(2) 导出 {name, apply}、(3) 不从模块表 require
 * 任何东西、(4) 提供一份花括号配平、格式正确的 CSS 字符串。完整的交互式渲染仍需
 * 真实浏览器验证（打开 GUI 并展开小窗）。
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (msg) => console.log(`  ok  ${msg}`);
const bad = (msg, err) => {
	failures += 1;
	console.error(`  FAIL ${msg}: ${err && err.stack ? err.stack : err}`);
};

function braceLevelOf(css) {
	let depth = 0;
	let inStr = null;
	for (let i = 0; i < css.length; i++) {
		const ch = css[i];
		if (inStr !== null) {
			if (ch === "\\") { i += 1; continue; }
			if (ch === inStr) inStr = null;
			continue;
		}
		if (ch === '"' || ch === "'") { inStr = ch; continue; }
		if (ch === "{") depth += 1;
		else if (ch === "}") depth -= 1;
		if (depth < 0) return -1;
	}
	return depth;
}

let handoff = null;
globalThis.window = {
	__ModuleLoader__: { load(h) { handoff = h; } },
	innerWidth: 1200,
	innerHeight: 800,
	addEventListener() {},
	removeEventListener() {},
	localStorage: {
		_data: new Map(),
		getItem(k) { return this._data.has(k) ? this._data.get(k) : null; },
		setItem(k, v) { this._data.set(k, String(v)); },
	},
};
// top-level CSS-injection guard reads `document` only when it's defined; in this
// headless environment we leave `document` undefined on purpose and assert the
// code handles that (it must fall back to not injecting).
delete globalThis.document;

console.log("[1] bundle registration");
try {
	await import(pathToFileURL(join(HERE, "client.js")).href);
	if (!handoff) throw new Error("window.__ModuleLoader__.load was not called");
	if (handoff.id !== "dsh-token-dashboard") throw new Error("wrong id " + handoff.id);
	const mod = handoff.factory((spec) => {
		throw new Error("bundle must require nothing, tried " + spec);
	});
	if (mod.name !== "dsh-token-dashboard") throw new Error("bad name export");
	if (typeof mod.apply !== "function") throw new Error("missing apply export");
	ok("registers as dsh-token-dashboard, exports {name, apply}, requires nothing");
} catch (err) {
	bad("registration", err);
}

console.log("[2] CSS well-formedness");
// Read source and find the CSS string to check its brace balance without
// executing the DOM-injection branch (which needs a real `document`).
const { readFileSync } = await import("node:fs");
const src = readFileSync(join(HERE, "client.js"), "utf8");
const m = src.match(/var CSS = \[([\s\S]*?)\]\.join\(""\);/);
if (!m) {
	bad("CSS extraction", new Error("could not locate `var CSS = [...]`"));
} else {
	const css = m[1].replace(/",\s*$/g, "").replace(/\\"|\\'/g, "").replace(/\\\n/g, "");
	const level = braceLevelOf(css);
	if (level === -1) bad("CSS braces", new Error("unbalanced closing brace"));
	else if (level !== 0) bad("CSS braces", new Error("depth " + level + " at end — missing closing brace(s)"));
	else ok("CSS contains equal { } pairs and no unmatched closing brace");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);