#!/usr/bin/env node
/**
 * install.mjs — idempotent installer for dsh-token-dashboard.
 *
 * Copies the plugin package into the web profile's node_modules, registers it
 * in the profile package.json dependencies, and appends the loader row to the
 * profile cordis.patch.yml. Safe to re-run (skips everything already in place;
 * re-copies sources so edits are redeployed).
 *
 * NOTE: this copies source → profile in ONE direction and overwrites whatever is
 * deployed. The source tree is the single source of truth and is version-
 * controlled on GitHub, so recovery is a git checkout rather than a local
 * backup. Edit the plugin HERE, never directly inside the profile.
 *
 * Usage:
 *   node _plugins/dsh-token-dashboard/install.mjs [profile-dir]
 *
 * profile-dir defaults to $DSH_HOME/profiles/web (or ~/.dsh/profiles/web).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));
const FILES = ["package.json", "index.js", "client.js", "types.d.ts", "README.md"];
const ROW_ID = "token-dashboard";
const BLOCK_MARKER = `# dsh-token-dashboard: collapsible token/cache usage widget (installed by _plugins/dsh-token-dashboard/install.mjs)`;
const NEW_BLOCK = `${BLOCK_MARKER}
- insert:
    - id: ${ROW_ID}
      name: 'dsh-token-dashboard'
      config:
        apiPath: /token-dashboard/api
        seriesSize: 600
`;

function resolveProfileDir(argv) {
	if (argv[0]) return resolve(argv[0]);
	const envHome = process.env.DSH_HOME;
	const home = envHome && String(envHome).trim() !== "" ? String(envHome).trim() : join(homedir(), ".dsh");
	return join(home, "profiles", "web");
}

function patchPackageJson(profileDir) {
	const file = join(profileDir, "package.json");
	if (!existsSync(file)) throw new Error(`profile package.json not found: ${file}`);
	const pkg = JSON.parse(readFileSync(file, "utf8"));
	const deps = (pkg.dependencies ??= {});
	if (deps[`dsh-token-dashboard`] === undefined) {
		deps[`dsh-token-dashboard`] = "file:node_modules/dsh-token-dashboard";
		writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
		return true;
	}
	return false;
}

function upsertPatchRow(profileDir) {
	const file = join(profileDir, "cordis.patch.yml");
	if (!existsSync(file)) throw new Error(`cordis.patch.yml not found: ${file}`);
	const existing = readFileSync(file, "utf8");
	const markerIdx = existing.indexOf(BLOCK_MARKER);
	if (markerIdx === -1) {
		// Fresh install — append the new block.
		const sep = existing.endsWith("\n") ? "" : "\n";
		writeFileSync(file, existing + sep + "\n" + NEW_BLOCK);
		return { changed: true, mode: "appended" };
	}
	// Upgrade: locate the block bounds (from marker to next blank line + a non-marker line).
	// The block ends at the first line that is empty or whitespace-only followed by a
	// different entry; the simplest robust choice is to scan forward from the marker
	// and cut at the next "# dsh-token-dashboard" / "- " / blank-line-then-non-block
	// boundary. The previous block is exactly our marker + a `- insert:` until a blank
	// line (then `\n# dsh-token-dashboard...` would start the next block, but we only
	// have one). So we scan until a blank line OR end-of-file.
	const start = markerIdx;
	const afterMarker = existing.indexOf("\n", start) + 1;
	let end = existing.length;
	for (let i = afterMarker; i < existing.length; i++) {
		// Cut at the first blank line (a line consisting only of whitespace).
		if (existing[i] === "\n" && (i + 1 === existing.length || existing[i + 1] === "\n")) {
			end = i;
			break;
		}
	}
	const block = existing.slice(start, end);
	// If the block already carries the base config keys, KEEP it verbatim —
	// users may have added extra keys (e.g. deepseekApiKey / balanceRefreshMs /
	// balanceFile) that a full template rewrite would silently wipe.
	if (block.includes("apiPath:") && block.includes("seriesSize:")) {
		return { changed: false, mode: "kept (user config preserved)" };
	}
	const before = existing.slice(0, start);
	const after = existing.slice(end);
	const sep = before.endsWith("\n") ? "" : "\n";
	const writeBack = before + NEW_BLOCK + after;
	writeFileSync(file, writeBack);
	return { changed: true, mode: "updated" };
}

function copyPackage(profileDir) {
	const target = join(profileDir, "node_modules", "dsh-token-dashboard");
	mkdirSync(target, { recursive: true });
	for (const file of FILES) {
		const from = join(SRC, file);
		if (!existsSync(from)) throw new Error(`source file missing: ${from}`);
		cpSync(from, join(target, file));
	}
	return target;
}

const profileDir = resolveProfileDir(process.argv.slice(2));
if (!existsSync(join(profileDir, "package.json")) || !existsSync(join(profileDir, "cordis.patch.yml"))) {
	console.error(`[install] not a dsh profile directory: ${profileDir}`);
	process.exit(1);
}

const copied = copyPackage(profileDir);
const depsChanged = patchPackageJson(profileDir);
const rowResult = upsertPatchRow(profileDir);

console.log(`[install] profile:      ${profileDir}`);
console.log(`[install] package:      ${copied}`);
console.log(`[install] sources:      ${FILES.join(", ")}`);
console.log(`[install] package.json: ${depsChanged ? "registered dependency" : "already registered"}`);
console.log(`[install] patch row:    ${rowResult.mode}`);
console.log("");
console.log("[install] done. Restart dsh web for the plugin to load:");
console.log("           - in the start-web console window type: restart");
console.log("           - or re-run start-web.bat");
