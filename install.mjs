#!/usr/bin/env node
/**
 * install.mjs —— dsh-token-dashboard 的幂等安装脚本。
 *
 * 把插件包复制到 web profile 的 node_modules，在 profile 的 package.json
 * 依赖中注册它，并把加载行追加到 profile 的 cordis.patch.yml。可安全地重复
 * 执行（已就位的内容会跳过；源码会重新复制，因此改动能被重新部署）。
 *
 * 注意：这是源码 → profile 的单向复制，会覆盖已部署的任何内容。源码树是唯一
 * 可信来源，且已在 GitHub 上纳入版本控制，因此恢复手段是 git 检出而非本地
 * 备份。请始终在源码树中修改插件，绝不要直接改 profile 里的副本。
 *
 * 用法：
 *   node _plugins/dsh-token-dashboard/install.mjs [profile-dir]
 *
 * profile-dir 默认为 $DSH_HOME/profiles/web（或 ~/.dsh/profiles/web）。
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
		// 全新安装 —— 直接追加新的配置块。
		const sep = existing.endsWith("\n") ? "" : "\n";
		writeFileSync(file, existing + sep + "\n" + NEW_BLOCK);
		return { changed: true, mode: "appended" };
	}
	// 升级场景：定位配置块的边界（从标记行到下一个空行）。
	// 配置块在第一个空行处结束。最稳妥的做法是从标记行往后扫描，在下一个空行
	// 处截断。原有配置块的结构正好是「标记行 + 一个 `- insert:` 直到空行」
	// （若有下一个块则以 `\n# dsh-token-dashboard...` 开头，但这里只会有一个）。
	// 因此扫描到空行或文件末尾即可。
	const start = markerIdx;
	const afterMarker = existing.indexOf("\n", start) + 1;
	let end = existing.length;
	for (let i = afterMarker; i < existing.length; i++) {
		// 在第一个空行处截断（整行只含空白字符）。
		if (existing[i] === "\n" && (i + 1 === existing.length || existing[i + 1] === "\n")) {
			end = i;
			break;
		}
	}
	const block = existing.slice(start, end);
	// 如果该配置块已包含基础配置键，就原样保留 —— 用户可能额外加了其他的
	// 键（例如 deepseekApiKey / balanceRefreshMs / balanceFile），用模板整体
	// 重写会把它们静默抹掉。
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
