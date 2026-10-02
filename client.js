/*!
 * dsh-token-dashboard — 浏览器端（自包含 bundle）
 *
 * 一个可折叠的悬浮小窗，用于 DSH Web GUI。它轮询服务端
 * (`GET /token-dashboard/api`) 并渲染 token 总量、缓存命中率、上下文
 * 占用率以及逐轮用量趋势。它刻意不依赖客户端模块表中的任何其他东西
 * （无 React、无 slots、无主题套件）：单一经典 <script> 风格工厂，
 * 唯一的浏览器依赖是 `fetch`。
 *
 * 小窗可拖拽、可沿四边/四角手动拉伸（pointer 事件），在 localStorage 中
 * 记住折叠状态、位置与自定义尺寸，标签页隐藏时暂停轮询，插件 fiber 被
 * 销毁时会将其完全移除（HMR 刷新安全）。
 */
window.__ModuleLoader__.load({
	id: "dsh-token-dashboard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region 样式（只注入一次；归本插件所有，便于 HMR 记账）
		// 一组内联为 background-mask URL 的小型 SVG 图标。它们按当前字体颜色渲染，
		// 因此仅凭 `mask` + `background: currentColor` 这对组合
		// 就能得到带色调、抗锯齿的图形，无需打包额外资源。
		var ICONS = {
			in: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M9.5 1.5l3.5 3.5H10v2h2.5l-3 3-1.06-1.06L10.94 8 8.5 5.56 9.5 4.5l3 3V3.5h-3V1.5zm-7 13h11v-2h-11v2z'/></svg>",
			out: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M6.5 14.5L3 11l3.5-3.5L8 9 5.06 11.94 7.5 14.5l-3 3V14h3v-.5zm-1-9V3h-2L0 0v-.5l3 3h-1V2z' transform='='translate(3,1)'/></svg>",
			cr: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M8 1a7 7 0 1 0 7 7h-2a5 5 0 1 1-5-5V1zm6 .5L13 2l-3.5 3.5L8 4v2l1.5-1.5L13 8l1.5-1.5L13 5v-.5h2V1.5h-1z'/></svg>",
			cw: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M2 4a4 4 0 0 1 4-4v2a2 2 0 0 0-2 2H2zm0 8a4 4 0 0 0 4 4v-2a2 2 0 0 1-2-2H2zm12-8a4 4 0 0 0-4-4v2a2 2 0 0 1 2 2h2zm0 8a4 4 0 0 1-4 4v-2a2 2 0 0 0 2-2h2zM4 8a2 2 0 1 1 4 0 2 2 0 0 1-4 0z'/></svg>",
			hit: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M8 1a7 7 0 1 0 7 7h-2a5 5 0 1 1-5-5c.55 0 1.08.09 1.59.25L8.84 1.4A7.05 7.05 0 0 0 8 1zm4.5 1.5L8 6l-1-1L13.5 1l-1 1.5z'/></svg>",
			ctx: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 2a5 5 0 0 1 5 5h-2a3 3 0 0 0-3-3V3z'/></svg>",
			calls: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M1 13h2V7H1v6zm4 0h2V3H5v10zm4 0h2V5H9v8zm4 0h2V9h-2v4z'/></svg>",
			chevron: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M4 6l4 4 4-4z'/></svg>",
			reset: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M8 3a5 5 0 1 1-4.546 2.914l-1.061 1.06A7 7 0 1 0 8 1v2zm5-2v3h-3V2h1.586L11.5 1.086l.707.707L11.5 2.5H13z'/></svg>",
			refresh: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z'/><path d='M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z'/></svg>",
		};
		var ICON_DATA_URI = function (svg) {
			return "url(\"data:image/svg+xml;utf8," + svg.replace(/"/g, "'") + "\")";
		};

		var CSS = [
			// ── 设计变量 ─────────────────────────────────────────────────
			":host,dsh-token-dashboard{",
			"  --tdb-font: var(--dsw-font-family, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif);",
			"  --tdb-mono: var(--ds-font-family-code, ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace);",
			"  --tdb-radius-sm: 6px;",
			"  --tdb-radius-md: 10px;",
			"  --tdb-radius-lg: 14px;",
			"  --tdb-pad-x: 14px;",
			"  --tdb-pad-y: 12px;",
			"  --tdb-gap: 10px;",
			// 颜色/字体全部优先取 DSH 设计令牌（--dsw-*/--shiki-token-*），随 DSH 主题
			// （body[data-ds-dark-theme]）在浅色/深色/跟随系统之间自动切换；var() 的
			// fallback 保留原配色，保证主题样式表缺席时仍可读。
			"  --tdb-bg: var(--dsw-alias-bg-layer-1, rgba(22, 22, 28, .82));",
			"  --tdb-bg-elev: var(--dsw-alias-bg-module-platform, rgba(255, 255, 255, .045));",
			"  --tdb-bg-cell: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .04));",
			"  --tdb-bg-cell-hover: var(--dsw-alias-interactive-bg-hover-solid, rgba(255, 255, 255, .07));",
			"  --tdb-bg-chart: var(--dsw-alias-bg-mask-2, rgba(255, 255, 255, .03));",
			"  --tdb-border: var(--dsw-alias-border-l1, rgba(255, 255, 255, .08));",
			"  --tdb-border-strong: var(--dsw-alias-border-l2, rgba(255, 255, 255, .14));",
			"  --tdb-fg: var(--dsw-alias-label-primary, #e9eaee);",
			"  --tdb-fg-muted: var(--dsw-alias-label-secondary, rgba(233, 234, 238, .55));",
			"  --tdb-fg-faint: var(--dsw-alias-label-tertiary, rgba(233, 234, 238, .35));",
			"  --tdb-shadow: var(--dsw-shadow-lv3, 0 10px 32px rgba(0, 0, 0, .35), 0 2px 6px rgba(0, 0, 0, .25));",
			"  --tdb-accent-in: var(--dsw-static-deepseek-400, #7aa2ff);",
			"  --tdb-accent-out: var(--shiki-token-function, #b8a5ff);",
			"  --tdb-accent-cr: var(--dsw-alias-state-success-primary, #3fb950);",
			"  --tdb-accent-cw: var(--dsw-alias-state-warn-primary, #d29922);",
			"  --tdb-accent-hit: var(--dsw-alias-state-success-secondary, #3fb950);",
			"  --tdb-accent-ctx: var(--shiki-token-keyword, #f778ba);",
			"  --tdb-accent-calls: var(--shiki-token-link, #56d4dd);",
			"  --tdb-accent-ok: var(--dsw-alias-state-success-primary, #3fb950);",
			"  --tdb-accent-warn: var(--dsw-alias-state-warn-primary, #d29922);",
			"  --tdb-accent-err: var(--dsw-alias-state-error-primary, #f85149);",
			"}",
			// ── 根容器 ─────────────────────────────────────────────────
			// `position: fixed` 让元素脱离任何祖先 flex/grid 布局流，因此面板
			// 永远不会被拉伸到整个视口（即「贴到底部 / 撑大页面」的症状）。
			// `width/height: max-content` 让盒子的尺寸正好等于内容大小，
			// `pointer-events: none` 让点击完全穿透该元素——只有面板子元素
			// （它重新启用了 pointer 事件）是可交互的，因此不会有任何不可见区域
			// 挡住下方的 DSH UI。
			"dsh-token-dashboard{",
			// 不再用 all: initial 隔离——DSH GUI 样式全按类名作用域（已核实无裸元素/
			// 通配规则），放开继承后 --dsw-* 令牌才沿继承链生效；插件自身的规则仍
			// 全部以 dsh-token-dashboard 前缀作用域，布局依旧完全受控。
			"  display: block; position: fixed;",
			"  right: 16px; bottom: 16px; z-index: 2147483000;",
			"  width: max-content; height: max-content; max-width: 90vw; max-height: 90vh;",
			"  pointer-events: none;",
			"  color-scheme: light; font-family: var(--tdb-font); font-size: 12px; line-height: 1.5;",
			"  color: var(--tdb-fg); user-select: none; -webkit-user-select: none;",
			"  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;",
			"}",
			"body[data-ds-dark-theme] dsh-token-dashboard{ color-scheme: dark; }",
			"dsh-token-dashboard *{{ box-sizing: border-box; margin: 0; padding: 0; }}",
			// ── 面板外壳 ──────────────────────────────────────────────────
			"dsh-token-dashboard .tdb-panel{",
			"  pointer-events: auto; position: relative;",
			"  display: flex; flex-direction: column;",
			"  min-width: 300px; max-width: calc(100vw - 32px); width: 440px;",
			"  border: 1px solid var(--tdb-border); border-radius: var(--tdb-radius-md);",
			"  background: var(--tdb-bg); backdrop-filter: blur(20px) saturate(1.4); -webkit-backdrop-filter: blur(20px) saturate(1.4);",
			"  box-shadow: var(--tdb-shadow); overflow: hidden;",
			"  transition: border-color .15s ease, box-shadow .2s ease;",
			"}",
			"dsh-token-dashboard .tdb-panel:hover{ border-color: var(--tdb-border-strong); }",
			// ── 迷你胶囊（折叠态） ────────────────────────────────────────
			// 收起时整个面板隐藏，只留一个紧凑胶囊，展示当前时间窗口内
			// 全部会话汇总的 6 项核心指标（总消耗/输入/输出/缓存读取/
			// 命中率/API 调用次数），点击展开完整面板，可拖拽移动，
			// 连接失败时显示红色「连接失败」。
			"dsh-token-dashboard[aria-collapsed='true'] .tdb-panel{ display: none !important; }",
			"dsh-token-dashboard .tdb-mini{",
			"  pointer-events: auto; display: none; align-items: center; gap: 6px;",
			"  height: 36px; padding: 0 10px; border-radius: 999px;",
			"  border: 1px solid var(--tdb-border); background: var(--tdb-bg);",
			"  backdrop-filter: blur(20px) saturate(1.4); -webkit-backdrop-filter: blur(20px) saturate(1.4);",
			"  box-shadow: var(--tdb-shadow); cursor: grab; user-select: none;",
			"  transition: border-color .15s ease, box-shadow .2s ease;",
			"}",
			"dsh-token-dashboard[aria-collapsed='true'] .tdb-mini{ display: inline-flex; }",
			"dsh-token-dashboard .tdb-mini:hover{ border-color: var(--tdb-border-strong); }",
			"dsh-token-dashboard .tdb-mini:active{ cursor: grabbing; }",
			"dsh-token-dashboard .tdb-mini .tdb-mc{",
			"  display: inline-flex; align-items: baseline; gap: 3px;",
			"  padding: 2px 7px; border-radius: 7px; white-space: nowrap;",
			"  background: var(--tdb-bg-cell); border: 1px solid var(--tdb-border);",
			"}",
			"dsh-token-dashboard .tdb-mini .tdb-mc b{",
			"  font-family: var(--tdb-mono); font-size: 12px; font-weight: 600;",
			"  font-variant-numeric: tabular-nums; color: var(--tdb-fg); line-height: 1.2;",
			"}",
			"dsh-token-dashboard .tdb-mini .tdb-mc .tdb-ml{ font-size: 9.5px; color: var(--tdb-fg-muted); }",
			"dsh-token-dashboard .tdb-mini .tdb-mc-total b{ color: var(--tdb-accent-ctx); }",
			"dsh-token-dashboard .tdb-mini .tdb-mc-total b.tdb-mv-balance{ color: var(--dsw-alias-state-success-primary, #2ecc71); font-weight: 700; }",
			"dsh-token-dashboard .tdb-mini .tdb-mc-in b{ color: var(--tdb-accent-in); }",
			"dsh-token-dashboard .tdb-mini .tdb-mc-out b{ color: var(--tdb-accent-out); }",
			"dsh-token-dashboard .tdb-mini .tdb-mc-cr b{ color: var(--tdb-accent-cr); }",
			"dsh-token-dashboard .tdb-mini .tdb-mc-hit b{ color: var(--tdb-accent-hit); }",
			"dsh-token-dashboard .tdb-mini .tdb-mc-calls b{ color: var(--tdb-accent-calls); }",
			"dsh-token-dashboard .tdb-mini .tdb-m-err{",
			"  display: none; font-size: 11px; font-weight: 600;",
			"  color: var(--tdb-accent-err); padding: 0 4px; white-space: nowrap;",
			"}",
			"dsh-token-dashboard .tdb-mini.err .tdb-m-err{ display: inline; }",
			"dsh-token-dashboard .tdb-mini.err .tdb-mc{ display: none; }",
			// ── 边缘/角落拉伸手柄 ────────────────────────────────────────
			// 四个边条 + 四个角块，悬停时以强调色淡显，方便发现。
			"dsh-token-dashboard .tdb-rsz{ position: absolute; z-index: 3; touch-action: none; transition: background .12s ease; }",
			"dsh-token-dashboard .tdb-rsz:hover, dsh-token-dashboard .tdb-rsz:active{ background: var(--tdb-accent-in); opacity: .25; }",
			"dsh-token-dashboard .tdb-rsz-n{ top: 0; left: 10px; right: 10px; height: 6px; cursor: ns-resize; }",
			"dsh-token-dashboard .tdb-rsz-s{ bottom: 0; left: 10px; right: 10px; height: 6px; cursor: ns-resize; }",
			"dsh-token-dashboard .tdb-rsz-e{ right: 0; top: 10px; bottom: 10px; width: 6px; cursor: ew-resize; }",
			"dsh-token-dashboard .tdb-rsz-w{ left: 0; top: 10px; bottom: 10px; width: 6px; cursor: ew-resize; }",
			"dsh-token-dashboard .tdb-rsz-ne{ top: 0; right: 0; width: 14px; height: 14px; cursor: nesw-resize; }",
			"dsh-token-dashboard .tdb-rsz-nw{ top: 0; left: 0; width: 14px; height: 14px; cursor: nwse-resize; }",
			"dsh-token-dashboard .tdb-rsz-se{ bottom: 0; right: 0; width: 14px; height: 14px; cursor: nwse-resize; }",
			"dsh-token-dashboard .tdb-rsz-sw{ bottom: 0; left: 0; width: 14px; height: 14px; cursor: nesw-resize; }",
			// ── 头部 ────────────────────────────────────────────────────────
			"dsh-token-dashboard .tdb-head{",
			"  display: flex; align-items: center; gap: 10px; flex: none;",
			"  padding: 10px 12px; cursor: grab; user-select: none;",
			"  border-bottom: 1px solid var(--tdb-border); background: var(--tdb-bg-elev);",
			"}",
			"dsh-token-dashboard .tdb-head:active{ cursor: grabbing; }",
			"dsh-token-dashboard .tdb-title{",
			"  font-weight: 600; font-size: 13px; letter-spacing: .2px;",
			"  display: flex; align-items: center; gap: 8px; white-space: nowrap; flex: 0 0 auto;",
			"}",
			"dsh-token-dashboard .tdb-dot{",
			"  width: 8px; height: 8px; border-radius: 50%; background: var(--tdb-accent-cr); flex: none",
			"  box-shadow: 0 0 8px var(--tdb-accent-cr); transition: background .3s ease, box-shadow .3s ease;",
			"}",
			"dsh-token-dashboard .tdb-dot.idle{ background: var(--tdb-fg-faint); box-shadow: none; }",
			// 头部中折叠后的摘要
			"dsh-token-dashboard .tdb-summary{",
			"  flex: 1; text-align: right;",
			"  font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;",
			"  display: flex; gap: 10px; align-items: center; justify-content: flex-end;",
			"  font-size: 12px;",
			"}",
			"dsh-token-dashboard .tdb-summary .tdb-s-chip{",
			"  display: inline-flex; align-items: baseline; gap: 3px; padding: 1px 7px;",
			"  border-radius: 999px; background: var(--tdb-bg-cell);",
			"  border: 1px solid var(--tdb-border); color: var(--tdb-fg-muted);",
			"  font-size: 11px;",
			"}",
			"dsh-token-dashboard .tdb-summary .tdb-s-chip b{",
			"  color: var(--tdb-fg); font-weight: 600; font-size: 12px;",
			"}",
			"dsh-token-dashboard .tdb-summary .tdb-s-hit{ border-color: transparent; background: color-mix(in srgb, var(--tdb-accent-cr) 12%, transparent); color: var(--tdb-accent-cr); }",
			"dsh-token-dashboard .tdb-summary .tdb-s-hit b{ color: var(--tdb-accent-cr); }",
			"dsh-token-dashboard .tdb-summary .tdb-s-ctx{ border-color: transparent; background: color-mix(in srgb, var(--tdb-accent-ctx) 10%, transparent); color: var(--tdb-accent-ctx); }",
			"dsh-token-dashboard .tdb-summary .tdb-s-ctx b{ color: var(--tdb-accent-ctx); }",
			// 图标式按钮
			"dsh-token-dashboard .tdb-btns{ display: flex; gap: 4px; flex: none; }",
			"dsh-token-dashboard .tdb-btn{",
			"  all: unset; cursor: pointer; width: 24px; height: 24px; border-radius: var(--tdb-radius-sm);",
			"  display: inline-flex; align-items: center; justify-content: center; color: var(--tdb-fg-muted);",
			"  transition: background .12s ease, color .12s ease, transform .15s ease;",
			"}",
			"dsh-token-dashboard .tdb-btn:hover{ background: var(--tdb-bg-cell-hover); color: var(--tdb-fg); }",
			"dsh-token-dashboard .tdb-btn:active{ transform: scale(.92); }",
			"dsh-token-dashboard .tdb-btn::before{",
			"  content: ''; width: 14px; height: 14px; display: block;",
			"  background: currentColor; -webkit-mask-position: center; mask-position: center;",
			"  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; -webkit-mask-size: contain; mask-size: contain;",
			"}",
			"dsh-token-dashboard .tdb-btn.tdb-toggle::before{",
			"  -webkit-mask-image: " + ICON_DATA_URI(ICONS.chevron) + "; mask-image: " + ICON_DATA_URI(ICONS.chevron) + ";",
			"  transition: transform .2s ease;",
			"}",
			"dsh-token-dashboard .tdb-btn.tdb-refresh::before{",
			"  -webkit-mask-image: " + ICON_DATA_URI(ICONS.refresh) + "; mask-image: " + ICON_DATA_URI(ICONS.refresh) + ";",
			"}",
			"@keyframes tdb-spin{ to { transform: rotate(360deg); } }",
			"dsh-token-dashboard .tdb-btn.tdb-refresh.loading::before{ animation: tdb-spin .7s linear infinite; }",
			"dsh-token-dashboard[aria-collapsed='true'] .tdb-toggle::before{ transform: rotate(-90deg); }",
			// 主体
			"dsh-token-dashboard .tdb-body[hidden]{ display: none !important; }",
			"dsh-token-dashboard .tdb-body{",
			"  padding: var(--tdb-pad-y) var(--tdb-pad-x);",
			"  display: flex; flex-direction: column; gap: var(--tdb-gap);",
			"  flex: 1 1 auto; min-height: 0;",
			"  max-height: min(60vh, 520px); overflow-y: auto;",
			"  scrollbar-width: thin; scrollbar-color: var(--tdb-border-strong) transparent;",
			"}",
			"dsh-token-dashboard .tdb-body::-webkit-scrollbar{ width: 6px; }",
			"dsh-token-dashboard .tdb-body::-webkit-scrollbar-thumb{ background: var(--tdb-border-strong); border-radius: 3px; }",
			// 总量网格
			"dsh-token-dashboard .tdb-grid{ display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }",
			// API 调用计数器是三列总量网格下方的一整行
			"dsh-token-dashboard .tdb-grid .tdb-c-calls{",
			"  grid-column: 1 / -1;",
			"  flex-direction: row; align-items: baseline; justify-content: space-between; gap: 8px;",
			"}",
			"dsh-token-dashboard .tdb-grid .tdb-c-calls span{ font-size: 10px; }",
			// 时间窗口筛选（总量网格上方的分段控件）
			"dsh-token-dashboard .tdb-range{",
			"  display: flex; align-items: center; gap: 4px;",
			"  background: var(--tdb-bg-cell); border: 1px solid var(--tdb-border); border-radius: var(--tdb-radius-sm);",
			"  padding: 2px; flex: none; align-self: flex-start;",
			"}",
			"dsh-token-dashboard .tdb-range button{",
			"  all: unset; cursor: pointer; padding: 2px 9px; border-radius: 4px;",
			"  font-size: 11px; color: var(--tdb-fg-muted); white-space: nowrap; line-height: 1.4;",
			"  transition: background .12s ease, color .12s ease;",
			"}",
			"dsh-token-dashboard .tdb-range button:hover{ color: var(--tdb-fg); }",
			"dsh-token-dashboard .tdb-range button.active{",
			"  background: var(--tdb-fg); color: var(--tdb-bg); font-weight: 600;",
			"}",
			// 总量网格
			"dsh-token-dashboard .tdb-cell{",
			"  background: var(--tdb-bg-cell); border-radius: var(--tdb-radius-sm);",
			"  padding: 8px 10px; display: flex; flex-direction: column; gap: 2px;",
			"  border-left: 2px solid var(--tdb-border);",
			"  transition: background .15s ease, border-color .15s ease, transform .15s ease;",
			"}",
			"dsh-token-dashboard .tdb-cell:hover{ background: var(--tdb-bg-cell-hover); }",
			"dsh-token-dashboard .tdb-cell b{",
			"  font-family: var(--tdb-mono); font-size: 16px; font-weight: 600;",
			"  font-variant-numeric: tabular-nums; letter-spacing: -0.2px;",
			"  color: var(--tdb-fg); white-space: nowrap; line-height: 1.2;",
			"}",
			"dsh-token-dashboard .tdb-cell span{",
			"  font-size: 10.5px; color: var(--tdb-fg-muted);",
			"  display: inline-flex; align-items: center; gap: 4px;",
			"  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;",
			"}",
			"dsh-token-dashboard .tdb-cell .tdb-i{",
			"  width: 10px; height: 10px; flex: none; display: inline-block;",
			"  background: currentColor; -webkit-mask-position: center; mask-position: center;",
			"  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;",
			"  -webkit-mask-size: contain; mask-size: contain; opacity: .8;",
			"}",
			"dsh-token-dashboard .tdb-cell.tdb-c-in{ border-left-color: var(--tdb-accent-in); }",
			"dsh-token-dashboard .tdb-cell.tdb-c-in .tdb-i{ -webkit-mask-image: " + ICON_DATA_URI(ICONS.in) + "; mask-image: " + ICON_DATA_URI(ICONS.in) + "; color: var(--tdb-accent-in); }",
			"dsh-token-dashboard .tdb-cell.tdb-c-out{ border-left-color: var(--tdb-accent-out); }",
			"dsh-token-dashboard .tdb-cell.tdb-c-out .tdb-i{ -webkit-mask-image: " + ICON_DATA_URI(ICONS.out) + "; mask-image: " + ICON_DATA_URI(ICONS.out) + "; color: var(--tdb-accent-out); }",
			"dsh-token-dashboard .tdb-cell.tdb-c-cr{ border-left-color: var(--tdb-accent-cr); }",
			"dsh-token-dashboard .tdb-cell.tdb-c-cr .tdb-i{ -webkit-mask-image: " + ICON_DATA_URI(ICONS.cr) + "; mask-image: " + ICON_DATA_URI(ICONS.cr) + "; color: var(--tdb-accent-cr); }",
			"dsh-token-dashboard .tdb-cell.tdb-c-cw{ border-left-color: var(--tdb-accent-cw); }",
			"dsh-token-dashboard .tdb-cell.tdb-c-cw .tdb-i{ -webkit-mask-image: " + ICON_DATA_URI(ICONS.cw) + "; mask-image: " + ICON_DATA_URI(ICONS.cw) + "; color: var(--tdb-accent-cw); }",
			"dsh-token-dashboard .tdb-cell.tdb-c-hit{ border-left-color: var(--tdb-accent-hit); }",
			"dsh-token-dashboard .tdb-cell.tdb-c-hit .tdb-i{ -webkit-mask-image: " + ICON_DATA_URI(ICONS.hit) + "; mask-image: " + ICON_DATA_URI(ICONS.hit) + "; color: var(--tdb-accent-hit); }",
			"dsh-token-dashboard .tdb-cell.tdb-c-ctx{ border-left-color: var(--tdb-accent-ctx); }",
			"dsh-token-dashboard .tdb-cell.tdb-c-ctx .tdb-i{ -webkit-mask-image: " + ICON_DATA_URI(ICONS.ctx) + "; mask-image: " + ICON_DATA_URI(ICONS.ctx) + "; color: var(--tdb-accent-ctx); }",
			"dsh-token-dashboard .tdb-cell.tdb-c-calls{ border-left-color: var(--tdb-accent-calls); }",
			"dsh-token-dashboard .tdb-cell.tdb-c-calls .tdb-i{ -webkit-mask-image: " + ICON_DATA_URI(ICONS.calls) + "; mask-image: " + ICON_DATA_URI(ICONS.calls) + "; color: var(--tdb-accent-calls); }",
			"dsh-token-dashboard .tdb-cell.tdb-c-calls b{ color: var(--tdb-accent-calls); }",
			// 图表指标选择器（图表标签行内的分段控件）
			"dsh-token-dashboard .tdb-mpick{ display: inline-flex; align-items: center; gap: 2px; }",
			"dsh-token-dashboard .tdb-mpick button{",
			"  all: unset; cursor: pointer; padding: 1px 7px; border-radius: 4px;",
			"  font-size: 10px; color: var(--tdb-fg-muted); white-space: nowrap; line-height: 1.5;",
			"  text-transform: none; letter-spacing: 0;",
			"  transition: background .12s ease, color .12s ease;",
			"}",
			"dsh-token-dashboard .tdb-mpick button:hover{ color: var(--tdb-fg); background: var(--tdb-bg-cell-hover); }",
			"dsh-token-dashboard .tdb-mpick button.active{ background: var(--tdb-fg); color: var(--tdb-bg); font-weight: 600; }",
			// 图表
			"dsh-token-dashboard .tdb-chart{",
			"  display: flex; flex-direction: column; gap: 6px;",
			"  background: var(--tdb-bg-chart); border-radius: var(--tdb-radius-sm);",
			"  padding: 10px 10px 8px;",
			"}",
			"dsh-token-dashboard .tdb-clabel{",
			"  font-size: 10.5px; color: var(--tdb-fg-muted);",
			"  display: flex; justify-content: space-between; align-items: baseline; gap: 6px;",
			"  letter-spacing: .3px; text-transform: uppercase;",
			"}",
			"dsh-token-dashboard .tdb-clabel .tdb-c-legend { font-family: var(--tdb-mono); text-transform: none; letter-spacing: 0; opacity: .8; }",
			"dsh-token-dashboard .tdb-chart-wrap{ position: relative; }",
			"dsh-token-dashboard svg.tdb-svg{",
			"  display: block; width: 100%; height: 56px; border-radius: 6px;",
			"  background: var(--tdb-bg-elev);",
			"}",
			"dsh-token-dashboard .tdb-empty{ text-align: center; color: var(--tdb-fg-faint); padding: 18px 0; font-size: 11.5px; }",
			"dsh-token-dashboard .tdb-tip{",
			"  position: absolute; top: 0; pointer-events: none;",
			"  background: var(--tdb-bg); border: 1px solid var(--tdb-border-strong);",
			"  border-radius: var(--tdb-radius-sm); padding: 6px 8px; font-size: 11px;",
			"  color: var(--tdb-fg); font-variant-numeric: tabular-nums; line-height: 1.4;",
			"  box-shadow: var(--dsw-shadow-lv2, 0 4px 12px rgba(0, 0, 0, .25));",
			"  opacity: 0; transition: opacity .12s ease; z-index: 2;",
			"  max-width: 200px;",
			"}",
			"dsh-token-dashboard .tdb-tip.show{ opacity: 1; }",
			"dsh-token-dashboard .tdb-tip b{ color: var(--tdb-fg); font-weight: 600; margin-right: 4px; }",
			"dsh-token-dashboard .tdb-tip .tdb-tip-time { color: var(--tdb-fg-muted); font-size: 10px; display: block; }",
			"dsh-token-dashboard .tdb-tip .tdb-tip-detail { color: var(--tdb-fg-muted); font-size: 10px; display: block; font-variant-numeric: tabular-nums; }",
			"dsh-token-dashboard svg.tdb-svg .tdb-cursor{ stroke: var(--tdb-fg-muted); stroke-width: 1; stroke-dasharray: 2 2; opacity: 0; transition: opacity .12s ease; }",
			"dsh-token-dashboard svg.tdb-svg .tdb-cursor.show{ opacity: .5; }",
			// 页脚
			"dsh-token-dashboard .tdb-selrow{ display: flex; flex: none; }",
			"dsh-token-dashboard .tdb-tabs{",
			"  display: flex; gap: 4px; flex: none; align-self: flex-start;",
			"  background: var(--tdb-bg-cell); border: 1px solid var(--tdb-border); border-radius: var(--tdb-radius-sm);",
			"  padding: 2px;",
			"}",
			"dsh-token-dashboard .tdb-tabs button{",
			"  all: unset; cursor: pointer; padding: 2px 12px; border-radius: 4px;",
			"  font-size: 11px; color: var(--tdb-fg-muted); white-space: nowrap; line-height: 1.4;",
			"  transition: background .12s ease, color .12s ease;",
			"}",
			"dsh-token-dashboard .tdb-tabs button:hover{ color: var(--tdb-fg); }",
			"dsh-token-dashboard .tdb-tabs button.active{ background: var(--tdb-fg); color: var(--tdb-bg); font-weight: 600; }",
			"dsh-token-dashboard .tdb-pane{ display: flex; flex-direction: column; gap: var(--tdb-gap); }",
			"dsh-token-dashboard .tdb-pane[hidden]{ display: none !important; }",
			// 模型面板：搜索/筛选 + 可折叠提供商分组 + 紧凑模型行
			"dsh-token-dashboard .tdb-mcontrols{ display: flex; align-items: center; gap: 6px; }",
			"dsh-token-dashboard .tdb-msearch{",
			"  display: flex; align-items: center; gap: 5px; flex: 1; min-width: 0;",
			"  height: 26px; padding: 0 7px; background: var(--tdb-bg-cell);",
			"  border: 1px solid var(--tdb-border); border-radius: var(--tdb-radius-sm);",
			"  color: var(--tdb-fg-muted);",
			"}",
			"dsh-token-dashboard .tdb-msearch::before{ content: '⌕'; font-size: 16px; line-height: 1; color: var(--tdb-fg-faint); }",
			"dsh-token-dashboard .tdb-msearch:focus-within{ border-color: var(--tdb-border-strong); background: var(--tdb-bg-cell-hover); }",
			"dsh-token-dashboard .tdb-msearch input{",
			"  all: unset; min-width: 0; width: 100%; font-size: 10.5px; color: var(--tdb-fg);",
			"}",
			"dsh-token-dashboard .tdb-msearch input::placeholder{ color: var(--tdb-fg-faint); }",
			"dsh-token-dashboard .tdb-mfilter{",
			"  flex: 0 0 112px; min-width: 0; height: 26px; padding: 3px 6px;",
			"  background: var(--tdb-bg-cell); color: var(--tdb-fg); border: 1px solid var(--tdb-border);",
			"  border-radius: var(--tdb-radius-sm); font-size: 10.5px; cursor: pointer;",
			"}",
			"dsh-token-dashboard .tdb-mfilter:hover{ background: var(--tdb-bg-cell-hover); }",
			"dsh-token-dashboard .tdb-mfilter option{ background: var(--tdb-bg); color: var(--tdb-fg); }",
			"dsh-token-dashboard .tdb-mcount{ flex: none; font-size: 9.5px; color: var(--tdb-fg-faint); white-space: nowrap; }",
			"dsh-token-dashboard .tdb-mlist{ display: flex; flex-direction: column; gap: 5px; }",
			"dsh-token-dashboard .tdb-mgroup{",
			"  margin-top: 3px; border: 1px solid var(--tdb-border); border-radius: var(--tdb-radius-sm);",
			"  background: color-mix(in srgb, var(--tdb-bg-cell) 55%, transparent); overflow: hidden;",
			"}",
			"dsh-token-dashboard .tdb-mgroup:first-child{ margin-top: 0; }",
			"dsh-token-dashboard .tdb-mgroup > summary{",
			"  display: flex; align-items: baseline; gap: 7px; min-width: 0; padding: 6px 8px;",
			"  cursor: pointer; list-style: none; user-select: none; background: var(--tdb-bg-elev);",
			"}",
			"dsh-token-dashboard .tdb-mgroup > summary::-webkit-details-marker{ display: none; }",
			"dsh-token-dashboard .tdb-mgroup > summary::before{",
			"  content: ''; width: 11px; height: 11px; flex: none; margin-top: 1px;",
			"  background: var(--tdb-fg-muted); -webkit-mask: " + ICON_DATA_URI(ICONS.chevron) + " center / contain no-repeat; mask: " + ICON_DATA_URI(ICONS.chevron) + " center / contain no-repeat;",
			"  transition: transform .15s ease;",
			"}",
			"dsh-token-dashboard .tdb-mgroup[open] > summary::before{ transform: rotate(180deg); }",
			"dsh-token-dashboard .tdb-mgroup > summary:hover{ background: var(--tdb-bg-cell-hover); }",
			"dsh-token-dashboard .tdb-mg-name{",
			"  font-family: var(--tdb-mono); font-size: 11.5px; font-weight: 700; color: var(--tdb-fg);",
			"  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;",
			"}",
			"dsh-token-dashboard .tdb-mg-total{",
			"  font-size: 9.5px; color: var(--tdb-fg-muted); flex: 1; min-width: 0;",
			"  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;",
			"}",
			"dsh-token-dashboard .tdb-mg-pct{ font-family: var(--tdb-mono); font-size: 10.5px; color: var(--tdb-accent-in); white-space: nowrap; }",
			"dsh-token-dashboard .tdb-mgroup-body{ display: flex; flex-direction: column; padding: 0 6px 5px; }",
			"dsh-token-dashboard .tdb-mcard{",
			"  display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 6px 2px 5px;",
			"  border-top: 1px solid var(--tdb-border);",
			"}",
			"dsh-token-dashboard .tdb-mgroup-body .tdb-mcard:first-child{ border-top: 0; }",
			"dsh-token-dashboard .tdb-mtop{ display: flex; align-items: baseline; gap: 7px; min-width: 0; }",
			"dsh-token-dashboard .tdb-mname{",
			"  font-family: var(--tdb-mono); font-size: 11.5px; font-weight: 600; color: var(--tdb-fg);",
			"  min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;",
			"}",
			"dsh-token-dashboard .tdb-mtotal{ margin-left: auto; font-family: var(--tdb-mono); font-size: 11.5px; color: var(--tdb-accent-ctx); white-space: nowrap; }",
			"dsh-token-dashboard .tdb-mpct{ font-family: var(--tdb-mono); font-size: 10.5px; color: var(--tdb-accent-in); white-space: nowrap; }",
			"dsh-token-dashboard .tdb-mstats{ display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; min-width: 0; }",
			"dsh-token-dashboard .tdb-mstat{ display: flex; align-items: baseline; gap: 3px; min-width: 0; overflow: hidden; white-space: nowrap; }",
			"dsh-token-dashboard .tdb-mstat i{ font-style: normal; font-size: 9px; color: var(--tdb-fg-muted); flex: none; }",
			"dsh-token-dashboard .tdb-mstat b{ font-family: var(--tdb-mono); font-size: 10.5px; font-weight: 600; color: var(--tdb-fg); overflow: hidden; text-overflow: ellipsis; }",
			"dsh-token-dashboard .tdb-ms-in i{ color: var(--tdb-accent-in); }",
			"dsh-token-dashboard .tdb-ms-cr i{ color: var(--tdb-accent-cr); }",
			"dsh-token-dashboard .tdb-ms-cw i{ color: var(--tdb-accent-cw); }",
			"dsh-token-dashboard .tdb-ms-out i{ color: var(--tdb-accent-out); }",
			"dsh-token-dashboard .tdb-ms-calls i{ color: var(--tdb-accent-calls); }",
			"dsh-token-dashboard .tdb-mbar{ height: 2px; background: var(--tdb-bg-chart); border-radius: 2px; overflow: hidden; }",
			"dsh-token-dashboard .tdb-mbar i{",
			"  display: block; height: 100%; background: linear-gradient(90deg, var(--tdb-accent-in), var(--tdb-accent-out));",
			"  border-radius: 2px;",
			"}",
			// 汇总面板：四个滚动窗口卡 + 按日期柱状图
			"dsh-token-dashboard .tdb-wsum{ display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }",
			"dsh-token-dashboard .tdb-wsum .tdb-cell{ min-width: 0; padding: 6px 8px; gap: 1px; }",
			"dsh-token-dashboard .tdb-wsum .tdb-cell b{ font-size: 13px; }",
			"dsh-token-dashboard .tdb-wsum .tdb-cell span{ font-size: 9px; }",
			"dsh-token-dashboard .tdb-wsum .tdb-cell.tdb-w-all b{ color: var(--tdb-accent-ctx); }",
			"dsh-token-dashboard .tdb-wsum .tdb-cell.tdb-w-d30 b{ color: var(--tdb-accent-in); }",
			"dsh-token-dashboard .tdb-wsum .tdb-cell.tdb-w-d7 b{ color: var(--tdb-accent-cr); }",
			"dsh-token-dashboard .tdb-wsum .tdb-cell.tdb-w-d1 b{ color: var(--tdb-accent-out); }",
			// 按日期柱状图：竖条 + 悬停高亮；容器横跨整个面板宽度，柱宽自适应
			// （min-width: 0 让超长历史（数百天）也能均分压进容器内，不会裁掉最近的数据）。
			// 柱列是纵向 flex：单段（总量模式）一根 <i>，堆叠（按模型模式）多段
			// <i> 自底向上叠放，各段高度按占当日总量比例分配。
			"dsh-token-dashboard .tdb-bars{",
			"  display: flex; align-items: flex-end; gap: 1px;",
			"  height: 84px; padding: 4px 4px 0;",
			"  background: var(--tdb-bg-elev); border-radius: 6px;",
			"}",
			"dsh-token-dashboard .tdb-bars .tdb-empty{ width: 100%; }",
			// 高密度槽位（12h 逐分钟约 721 格）下取消柱间距，否则 1px × 槽数
			// 早已超过容器宽度，每根柱都会被压成 0 宽。
			"dsh-token-dashboard .tdb-bars.tdb-dense{ gap: 0; }",
			"dsh-token-dashboard .tdb-bars.tdb-dense .tdb-bcol i{ min-height: 0; }",
			"dsh-token-dashboard .tdb-bars .tdb-bcol{",
			"  flex: 1 1 0; min-width: 0; height: 100%;",
			"  display: flex; flex-direction: column; justify-content: flex-end; align-items: stretch; cursor: default;",
			"}",
			"dsh-token-dashboard .tdb-bars .tdb-bcol i{",
			"  display: block; width: 100%; min-height: 1px;",
			"  background: linear-gradient(180deg, var(--tdb-accent-in), var(--tdb-accent-ctx));",
			"  opacity: .82;",
			"  transition: opacity .1s ease, filter .1s ease;",
			"}",
			"dsh-token-dashboard .tdb-bars .tdb-bcol:hover i{ opacity: 1; filter: brightness(1.25); }",
			// 汇总图表标题行：标签 + 视图切换按钮组（复用 .tdb-mpick 样式）；
			// 右侧 tdb-bleg 常驻统计文字（N 个天有消耗 · 峰值），模型图例不在此显示
			"dsh-token-dashboard .tdb-bhead{ display: inline-flex; align-items: center; gap: 8px; min-width: 0; }",
			"dsh-token-dashboard .tdb-blabel{ white-space: nowrap; }",
			// DeepSeek 余额面板
			"dsh-token-dashboard .tdb-ds-note{",
			"  font-size: 11px; color: var(--tdb-fg-muted); padding: 10px 8px;",
			"  border: 1px dashed var(--tdb-border-strong); border-radius: var(--tdb-radius-sm);",
			"  background: var(--tdb-bg-chart); line-height: 1.5;",
			"}",
			"dsh-token-dashboard .tdb-ds-note.err{ color: var(--tdb-accent-err); border-color: var(--tdb-accent-err); }",
			"dsh-token-dashboard .tdb-ds-note.ok{ color: var(--tdb-accent-ok); border-color: color-mix(in srgb, var(--tdb-accent-ok) 45%, transparent); }",
			"dsh-token-dashboard .tdb-pane-deepseek .tdb-ds-note{",
			"  padding: 6px 8px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;",
			"}",
			"dsh-token-dashboard .tdb-ds-balances, dsh-token-dashboard .tdb-ds-consumed{ display: grid; gap: 6px; }",
			"dsh-token-dashboard .tdb-ds-balances{ grid-template-columns: repeat(3, minmax(0, 1fr)); }",
			"dsh-token-dashboard .tdb-ds-consumed{ grid-template-columns: repeat(5, minmax(0, 1fr)); }",
			"dsh-token-dashboard .tdb-ds-balances .tdb-cell, dsh-token-dashboard .tdb-ds-consumed .tdb-cell{",
			"  min-width: 0; padding: 6px 8px; gap: 1px;",
			"}",
			"dsh-token-dashboard .tdb-ds-balances .tdb-cell b, dsh-token-dashboard .tdb-ds-consumed .tdb-cell b{ font-size: 13px; }",
			"dsh-token-dashboard .tdb-ds-consumed .tdb-cell span{ font-size: 9px; }",
			"dsh-token-dashboard .tdb-pane-deepseek .tdb-chart{ gap: 4px; padding: 7px 8px 6px; }",
			"dsh-token-dashboard .tdb-pane-deepseek .tdb-clabel{ font-size: 9.5px; }",
			"dsh-token-dashboard .tdb-pane-deepseek svg.tdb-svg{ height: 56px; }",
			"dsh-token-dashboard .tdb-ds-meta{ font-size: 10.5px; color: var(--tdb-fg-faint); text-align: right; }",
			"dsh-token-dashboard .tdb-mlist .tdb-empty{ padding: 22px 0; }",
			"dsh-token-dashboard .tdb-selrow .tdb-select{",
			"  pointer-events: auto; flex: 1; min-width: 0; background: var(--tdb-bg-cell); color: var(--tdb-fg);",
			"  border: 1px solid var(--tdb-border); border-radius: var(--tdb-radius-sm);",
			"  font-size: 10.5px; padding: 3px 6px; cursor: pointer;",
			"  font-variant-numeric: tabular-nums;",
			"}",
			"dsh-token-dashboard .tdb-selrow .tdb-select:hover{ background: var(--tdb-bg-cell-hover); }",
			"dsh-token-dashboard .tdb-selrow .tdb-select option{ background: var(--tdb-bg); color: var(--tdb-fg); }",
			// 会话面板：当前时间范围内按会话消耗排名（只读展示，不可点击）。
			// 明细行复用汇总页的 .tdb-mstats/.tdb-mstat 与颜色语义，视觉保持一致。
			"dsh-token-dashboard .tdb-rank{ display: flex; flex-direction: column; gap: 5px; }",
			"dsh-token-dashboard .tdb-rleg{ font-size: 9.5px; color: var(--tdb-fg-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
			"dsh-token-dashboard .tdb-rlist{ display: flex; flex-direction: column; gap: 5px; }",
			"dsh-token-dashboard .tdb-ritem{",
			"  display: flex; flex-direction: column; gap: 4px; min-width: 0; cursor: default;",
			"  padding: 6px 6px 5px; border: 1px solid var(--tdb-border); border-radius: var(--tdb-radius-sm);",
			"  background: color-mix(in srgb, var(--tdb-bg-cell) 55%, transparent);",
			"}",
			"dsh-token-dashboard .tdb-rtop{ display: flex; align-items: baseline; gap: 7px; min-width: 0; }",
			"dsh-token-dashboard .tdb-rrank{",
			"  flex: none; min-width: 22px; font-family: var(--tdb-mono); font-size: 10.5px; font-weight: 700;",
			"  color: var(--tdb-fg-faint); font-variant-numeric: tabular-nums;",
			"}",
			"dsh-token-dashboard .tdb-ritem:first-child .tdb-rrank{ color: var(--tdb-accent-in); }",
			"dsh-token-dashboard .tdb-rname{",
			"  font-family: var(--tdb-mono); font-size: 11.5px; font-weight: 600; color: var(--tdb-fg);",
			"  min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;",
			"}",
			"dsh-token-dashboard .tdb-rtotal{ margin-left: auto; font-family: var(--tdb-mono); font-size: 11.5px; color: var(--tdb-accent-ctx); white-space: nowrap; }",
			"dsh-token-dashboard .tdb-rpct{ font-family: var(--tdb-mono); font-size: 10.5px; color: var(--tdb-accent-in); white-space: nowrap; }",
			"dsh-token-dashboard .tdb-rbar{ height: 2px; background: var(--tdb-bg-chart); border-radius: 2px; overflow: hidden; }",
			"dsh-token-dashboard .tdb-rbar i{",
			"  display: block; height: 100%; background: linear-gradient(90deg, var(--tdb-accent-in), var(--tdb-accent-out));",
			"  border-radius: 2px;",
			"}",
			"dsh-token-dashboard .tdb-rlist .tdb-empty{ padding: 18px 0; }",
			"dsh-token-dashboard .tdb-foot{",
			"  display: flex; align-items: center; gap: 8px; font-size: 10.5px; color: var(--tdb-fg-muted);",
			"  border-top: 1px solid var(--tdb-border); padding-top: 10px; margin-top: 2px; flex-wrap: wrap;",
			"}",
			"dsh-token-dashboard .tdb-status{",
			"  flex: none; padding: 1px 7px; border-radius: 999px; font-size: 10px; letter-spacing: .2px;",
			"  border: 1px solid currentColor; background: color-mix(in srgb, currentColor 10%, transparent);",
			"}",
			"dsh-token-dashboard .tdb-status-pending{ color: var(--tdb-accent-warn); }",
			"dsh-token-dashboard .tdb-status-ok{ color: var(--tdb-accent-ok); }",
			"dsh-token-dashboard .tdb-status-err{ color: var(--tdb-accent-err); }",
			"dsh-token-dashboard .tdb-empty-state{ text-align: center; color: var(--tdb-fg-faint); padding: 18px 4px; font-size: 12px; }",
			"dsh-token-dashboard .tdb-empty-state b{ display: block; color: var(--tdb-fg); font-size: 13px; margin-bottom: 4px; }",
			"@keyframes tdb-fadein{ from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: translateY(0); } }",
			"dsh-token-dashboard .tdb-body:not([hidden]) .tdb-grid, dsh-token-dashboard .tdb-body:not([hidden]) .tdb-chart, dsh-token-dashboard .tdb-body:not([hidden]) .tdb-foot{ animation: tdb-fadein .2s ease; }",
		].join("");
		// CSS 注入是 factory 期唯一的 DOM 副作用，document.head 在异常时机
		// （脚本在 <head> 解析完成前执行等）可能不可用；注入失败只应让面板
		// 失去样式，绝不能让整个 bundle 的 factory 抛错。
		try {
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"dsh-token-dashboard/panel.css\"]") === null) {
				var tag = document.createElement("style");
				tag.dataset.plugin = "dsh-token-dashboard";
				tag.dataset.pluginCss = "dsh-token-dashboard/panel.css";
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
		} catch (err) {
			try {
				console.warn("[dsh-token-dashboard] CSS injection failed:", err);
			} catch { /* 控制台不可用时静默 */ }
		}
		//#endregion

		//#region 辅助函数
		/** 转义文本中的 HTML 元字符（防御性；反正所有数据都是数值）。 */
		function esc(value) {
			return String(value).replace(/[&<>"']/g, function (c) {
				return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
			});
		}
		/** API 整体消耗 = 全部 token（uncached 输入 + 缓存读取 + 缓存写入 + 输出）。
		 *  不再按计费口径折算——未计费环境下直接统计整体流量。 */
		function overall(t) {
			return (t.uncached || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0) + (t.output || 0);
		}
		/** 紧凑的 token 格式化：1.2K / 3.4M / 517。 */
		function fmt(n) {
			var v = typeof n === "number" && Number.isFinite(n) ? n : 0;
			var abs = Math.abs(v);
			var sign = v < 0 ? "-" : "";
			if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
			if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
			return sign + Math.round(abs) + "";
		}
		/** 保留 1 位小数的百分比字符串（null → "—"）。 */
		function pct(value, digits) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			return value.toFixed(digits == null ? 1 : digits) + "%";
		}
		function clock(ms) {
			var d = new Date(ms);
			var p = function (x) { return (x < 10 ? "0" : "") + x; };
			return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
		}
		/** 按小时的时间戳："M/D HH时"。 */
		function dtHour(ms) {
			var d = new Date(ms);
			var p = function (x) { return (x < 10 ? "0" : "") + x; };
			return (d.getMonth() + 1) + "/" + d.getDate() + " " + p(d.getHours()) + "时";
		}
		/** 按分钟的时间戳："HH:MM"（用于 1h 时间范围的逐分钟序列）。 */
		function dtMin(ms) {
			var d = new Date(ms);
			var p = function (x) { return (x < 10 ? "0" : "") + x; };
			return p(d.getHours()) + ":" + p(d.getMinutes());
		}
		/** 按天的时间戳："M/D"（用于 30d 与全部范围的按天序列）。 */
		function dtDay(ms) {
			var d = new Date(ms);
			return (d.getMonth() + 1) + "/" + d.getDate();
		}
		/** 限制在视口内，保证拖拽的小窗永远不会被拖出屏幕外。 */
		function clampRect(rect) {
			rect.x = Math.max(4, Math.min(rect.x, (window.innerWidth || 1200) - 60));
			rect.y = Math.max(4, Math.min(rect.y, (window.innerHeight || 800) - 40));
			return rect;
		}
		function readStore(key, fallback) {
			try {
				var raw = window.localStorage.getItem("dsh-token-dashboard:" + key);
				return raw === null ? fallback : raw;
			} catch {
				return fallback;
			}
		}
		function writeStore(key, value) {
			try {
				window.localStorage.setItem("dsh-token-dashboard:" + key, String(value));
			} catch { /* 存储不可用——忽略 */ }
		}
		//#endregion

		//#region 图表
		/**
		 * 用跨整个序列的均匀采样把数据点降到最多 64 个（首尾保留），
		 * 然后构建 polyline 的 "d" 路径。均匀采样能让较长的连续小时序列
		 * 呈现完整趋势，而不只是最新的尾部。平坦/空序列渲染为中位线，
		 * 这样图表永远不会出现除零。
		 */
		function sparkPath(values, width, height, pad, baseline) {
			var pts = values.map(function (v) { return typeof v === "number" && Number.isFinite(v) ? v : 0; });
			if (pts.length > 64) {
				var sampled = [];
				var n = pts.length;
				for (var si = 0; si < 64; si++) {
					sampled.push(pts[Math.round((si * (n - 1)) / 63)]);
				}
				pts = sampled;
			}
			if (pts.length < 2) return { d: "", area: "" };
			var min = Math.min.apply(null, pts);
			var max = Math.max.apply(null, pts);
			if (max === min) {
				max = min + 1;
				min = min - 1;
			}
			var innerW = width - pad * 2;
			var innerH = height - pad * 2;
			var out = [];
			for (var i = 0; i < pts.length; i++) {
				var x = pad + (innerW * i) / (pts.length - 1);
				var y = pad + innerH * (1 - (pts[i] - min) / (max - min));
				out.push((i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1));
			}
			var line = out.join(" ");
			var base = Math.min(height - pad, Math.max(pad, pad + innerH * (1 - (baseline - min) / (max - min))));
			var area = line + " L" + (pad + innerW).toFixed(1) + " " + base.toFixed(1) + " L" + pad.toFixed(1) + " " + base.toFixed(1) + " Z";
			return { d: line, area: area };
		}
		/** 单个 sparkline 的 SVG HTML（折线 + 可选的半透明面积）。 */
		function sparkSvg(values, opts) {
			var W = 320, H = 46, P = 3, base = opts && opts.baseline;
			var path = sparkPath(values, W, H, P, base);
			var color = (opts && opts.color) || "var(--dsw-static-deepseek-400, #58a6ff)";
			var parts = [];
			parts.push("<svg class=\"tdb-svg\" viewBox=\"0 0 " + W + " " + H + "\" preserveAspectRatio=\"none\" aria-hidden=\"true\">");
			if (path.area) parts.push("<path d=\"" + path.area + "\" fill=\"" + color + "\" opacity=\"0.15\"/>");
			if (path.d) parts.push("<path d=\"" + path.d + "\" fill=\"none\" stroke=\"" + color + "\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" vector-effect=\"non-scaling-stroke\"/>");
			parts.push("</svg>");
			return parts.join("");
		}
		//#endregion

		/**
		 * 插件 apply——在客户端根上下文上构建小窗。
		 * @param {import('@deepseek-ai/cordis').Context} ctx
		 * @param {Record<string, unknown>} [config]
		 */
		function apply(ctx, config) {
			// 崩溃防护：前端半边同样不允许把异常抛回宿主。静态 client 插件的
			// apply 由 cordis 客户端 loader 激活，抛错会让这个插件变成失败条目；
			// 包一层 try/catch 后，本插件最多「不出现」，不会影响页面与其他插件。
			try {
				applyInner(ctx, config);
			} catch (err) {
				try {
					console.warn("[dsh-token-dashboard] disabled after an activation error:", err);
				} catch { /* 控制台不可用时静默 */ }
				// applyInner 可能已经把 <dsh-token-dashboard> 挂进了 body，
				// 半挂载的面板会留下一个死控件；这里按标签名清理。
				try {
					if (typeof document !== "undefined") {
						var stale = document.querySelectorAll("dsh-token-dashboard");
						for (var si = 0; si < stale.length; si++) {
							if (stale[si].parentNode) stale[si].parentNode.removeChild(stale[si]);
						}
					}
				} catch { /* 清理失败不再抛 */ }
			}
		}

		/** 前端真实主体（由 {@link apply} 包一层崩溃防护后调用）。 */
		function applyInner(ctx, config) {
			config = config || {};
			var apiPath = typeof config.apiPath === "string" && config.apiPath !== "" ? config.apiPath : "/token-dashboard/api";
			var refreshMs = Number(config.refreshMs) > 0 ? Number(config.refreshMs) : 2500;

			var data = null;        // 最近一次成功的 payload
			var error = null;       // 最近一次 fetch 的错误文本
			var collapsed = readStore("collapsed", "1") === "1";
			var range = readStore("range", "all");
			if (["all", "30d", "7d", "1d", "12h", "1h"].indexOf(range) === -1) range = "all";
			var pos = null;         // 拖拽位置 {x,y}；null → 默认角落
			try {
				var rawPos = readStore("pos", "");
				if (rawPos) pos = clampRect(JSON.parse(rawPos));
			} catch { pos = null; }

			// ── 构建 DOM 骨架 ─────────────────────────────────────────
			var root = document.createElement("dsh-token-dashboard");
			root.innerHTML = [
				"<div class=\"tdb-panel\">",
				"  <div class=\"tdb-head\" title=\"拖动移动 · 单击空白处展开/收起 · 边缘可拉伸\">",
				"    <span class=\"tdb-dot\"></span>",
				"    <span class=\"tdb-title\">Token 面板</span>",
				"    <span class=\"tdb-status\"></span>",
				"    <span class=\"tdb-summary\"></span>",
				"    <span class=\"tdb-btns\">",
				"      <button type=\"button\" class=\"tdb-btn tdb-refresh\" title=\"刷新数据 (R)\" aria-label=\"刷新数据\"></button>",
				"      <button type=\"button\" class=\"tdb-btn tdb-toggle\" title=\"展开/收起 ([ / ])\" aria-label=\"展开/收起\"></button>",
				"    </span>",
				"  </div>",
				"  <div class=\"tdb-body\" hidden=\"\">",
				"    <div class=\"tdb-range\" role=\"tablist\" aria-label=\"时间范围\">",
				"      <button type=\"button\" class=\"tdb-rag\" data-range=\"all\">全部</button>",
				"      <button type=\"button\" class=\"tdb-rag\" data-range=\"30d\">1月</button>",
				"      <button type=\"button\" class=\"tdb-rag\" data-range=\"7d\">1周</button>",
				"      <button type=\"button\" class=\"tdb-rag\" data-range=\"1d\">1天</button>",
				"      <button type=\"button\" class=\"tdb-rag\" data-range=\"12h\">12小时</button>",
				"      <button type=\"button\" class=\"tdb-rag\" data-range=\"1h\">1小时</button>",
				"    </div>",
				"    <div class=\"tdb-tabs\" role=\"tablist\" aria-label=\"视图\">",
				"      <button type=\"button\" class=\"tdb-tab\" data-tab=\"summary\">汇总</button>",
				"      <button type=\"button\" class=\"tdb-tab\" data-tab=\"session\">会话</button>",
				"      <button type=\"button\" class=\"tdb-tab\" data-tab=\"deepseek\">DeepSeek</button>",
				"    </div>",
				"    <div class=\"tdb-pane tdb-pane-summary\" hidden=\"\">",
				"      <div class=\"tdb-wsum\">",
				"        <div class=\"tdb-cell tdb-w-all\" title=\"\"><b class=\"tdb-wv-all\">—</b><span>累计总消耗</span></div>",
				"        <div class=\"tdb-cell tdb-w-d30\" title=\"\"><b class=\"tdb-wv-d30\">—</b><span>最近一月</span></div>",
				"        <div class=\"tdb-cell tdb-w-d7\" title=\"\"><b class=\"tdb-wv-d7\">—</b><span>最近一周</span></div>",
				"        <div class=\"tdb-cell tdb-w-d1\" title=\"\"><b class=\"tdb-wv-d1\">—</b><span>最近一日</span></div>",
				"      </div>",
				"      <div class=\"tdb-chart\">",
				"        <div class=\"tdb-clabel\"><span class=\"tdb-bhead\"><span class=\"tdb-blabel\">每日总消耗</span><span class=\"tdb-mpick tdb-bpick\" role=\"tablist\" aria-label=\"柱状图模式\">",
				"          <button type=\"button\" data-bmode=\"stack\">按模型</button>",
				"          <button type=\"button\" data-bmode=\"total\">总量</button>",
				"        </span></span><span class=\"tdb-bleg\"></span></div>",
				"        <div class=\"tdb-chart-wrap\"><div class=\"tdb-bars\"><div class=\"tdb-empty\">暂无消耗数据</div></div><div class=\"tdb-tip\" role=\"tooltip\"></div></div>",
				"      </div>",
				"      <div class=\"tdb-mcontrols\">",
				"        <label class=\"tdb-msearch\" title=\"搜索模型或提供商\"><input class=\"tdb-msearch-input\" type=\"search\" placeholder=\"搜索模型或提供商\" aria-label=\"搜索模型或提供商\"></label>",
				"        <select class=\"tdb-mfilter\" aria-label=\"筛选提供商\"></select>",
				"        <span class=\"tdb-mcount\"></span>",
				"      </div>",
				"      <div class=\"tdb-mlist tdb-smlist\"><div class=\"tdb-empty\">暂无模型数据</div></div>",
				"    </div>",
				"    <div class=\"tdb-pane tdb-pane-session\" hidden=\"\">",
				"      <div class=\"tdb-selrow\">",
				"        <select class=\"tdb-select\" aria-label=\"选择会话\"></select>",
				"      </div>",
				"      <div class=\"tdb-grid\">",
				"        <div class=\"tdb-cell tdb-c-in\"><b class=\"tdb-v-in\">—</b><span><i class=\"tdb-i\"></i>输入 · 未缓存</span></div>",
				"        <div class=\"tdb-cell tdb-c-out\"><b class=\"tdb-v-out\">—</b><span><i class=\"tdb-i\"></i>输出</span></div>",
				"        <div class=\"tdb-cell tdb-c-cr\"><b class=\"tdb-v-cr\">—</b><span><i class=\"tdb-i\"></i>缓存读取</span></div>",
				"        <div class=\"tdb-cell tdb-c-hit\"><b class=\"tdb-v-hit\">—</b><span><i class=\"tdb-i\"></i>缓存命中率</span></div>",
				"        <div class=\"tdb-cell tdb-c-cw\"><b class=\"tdb-v-cw\">—</b><span><i class=\"tdb-i\"></i>缓存写入</span></div>",
				"        <div class=\"tdb-cell tdb-c-ctx\"><b class=\"tdb-v-ctx\">—</b><span><i class=\"tdb-i\"></i>上下文占用</span></div>",
				"        <div class=\"tdb-cell tdb-c-calls\"><b class=\"tdb-v-calls\">—</b><span><i class=\"tdb-i\"></i>API 调用次数 · 本会话</span></div>",
				"      </div>",
				"      <div class=\"tdb-chart\">",
				"        <div class=\"tdb-clabel\"><span class=\"tdb-mpick tdb-spick\" role=\"tablist\" aria-label=\"图表数据\">",
				"          <button type=\"button\" data-metric=\"out\">输出</button>",
				"          <button type=\"button\" data-metric=\"in\">输入</button>",
				"          <button type=\"button\" data-metric=\"cr\">缓存读取</button>",
				"          <button type=\"button\" data-metric=\"total\">总消耗</button>",
				"          <button type=\"button\" data-metric=\"calls\">调用次数</button>",
				"        </span><span class=\"tdb-c1-legend\"></span></div>",
				"        <div class=\"tdb-chart-wrap\"><div class=\"tdb-c1\"><div class=\"tdb-empty\">暂无趋势数据</div></div><div class=\"tdb-tip\" role=\"tooltip\"></div></div>",
				"        <div class=\"tdb-clabel\"><span class=\"tdb-c2-label\">每小时总消耗</span><span class=\"tdb-c2-legend\"></span></div>",
				"        <div class=\"tdb-chart-wrap\"><div class=\"tdb-c2\"><div class=\"tdb-empty\">暂无消耗数据</div></div><div class=\"tdb-tip\" role=\"tooltip\"></div></div>",
				"      </div>",
				"      <div class=\"tdb-rank\">",
				"        <div class=\"tdb-clabel\"><span>会话消耗排名</span><span class=\"tdb-rleg\"></span></div>",
				"        <div class=\"tdb-rlist\"><div class=\"tdb-empty\">暂无会话数据</div></div>",
				"      </div>",
				"    </div>",
				"    <div class=\"tdb-pane tdb-pane-deepseek\" hidden=\"\">",
				"      <div class=\"tdb-ds-note\"></div>",
				"      <div class=\"tdb-ds-balances\">",
				"        <div class=\"tdb-cell tdb-c-ctx\"><b class=\"tdb-ds-total\">—</b><span>总余额</span></div>",
				"        <div class=\"tdb-cell tdb-c-cr\"><b class=\"tdb-ds-granted\">—</b><span>赠送余额</span></div>",
				"        <div class=\"tdb-cell tdb-c-in\"><b class=\"tdb-ds-topped\">—</b><span>充值余额</span></div>",
				"      </div>",
				"      <div class=\"tdb-ds-consumed\">",
				"        <div class=\"tdb-cell tdb-c-cr\" title=\"近1小时余额消耗\"><b class=\"tdb-ds-c-h1\">—</b><span>1小时</span></div>",
				"        <div class=\"tdb-cell tdb-c-cw\" title=\"近12小时余额消耗\"><b class=\"tdb-ds-c-h12\">—</b><span>12小时</span></div>",
				"        <div class=\"tdb-cell tdb-c-in\" title=\"近24小时余额消耗\"><b class=\"tdb-ds-c-d1\">—</b><span>24小时</span></div>",
				"        <div class=\"tdb-cell tdb-c-out\" title=\"近7天余额消耗\"><b class=\"tdb-ds-c-d7\">—</b><span>7天</span></div>",
				"        <div class=\"tdb-cell tdb-c-ctx\" title=\"自监控以来余额消耗\"><b class=\"tdb-ds-c-all\">—</b><span>累计</span></div>",
				"      </div>",
				"      <div class=\"tdb-chart\">",
				"        <div class=\"tdb-clabel\"><span>余额走势</span><span class=\"tdb-ds-leg\"></span></div>",
				"        <div class=\"tdb-chart-wrap\"><div class=\"tdb-ds-chart\"><div class=\"tdb-empty\">暂无余额样本</div></div><div class=\"tdb-tip\" role=\"tooltip\"></div></div>",
				"      </div>",
				"      <div class=\"tdb-ds-meta\">—</div>",
				"    </div>",
				"    <div class=\"tdb-foot\">",
				"      <span class=\"tdb-fupdated\">—</span>",
				"    </div>",
				"  </div>",
				"  <i class=\"tdb-rsz tdb-rsz-n\" data-rsz=\"n\" title=\"拉伸上边缘\"></i>",
				"  <i class=\"tdb-rsz tdb-rsz-s\" data-rsz=\"s\" title=\"拉伸下边缘\"></i>",
				"  <i class=\"tdb-rsz tdb-rsz-e\" data-rsz=\"e\" title=\"拉伸右边缘\"></i>",
				"  <i class=\"tdb-rsz tdb-rsz-w\" data-rsz=\"w\" title=\"拉伸左边缘\"></i>",
				"  <i class=\"tdb-rsz tdb-rsz-ne\" data-rsz=\"ne\" title=\"拉伸右上角\"></i>",
				"  <i class=\"tdb-rsz tdb-rsz-nw\" data-rsz=\"nw\" title=\"拉伸左上角\"></i>",
				"  <i class=\"tdb-rsz tdb-rsz-se\" data-rsz=\"se\" title=\"拉伸右下角\"></i>",
				"  <i class=\"tdb-rsz tdb-rsz-sw\" data-rsz=\"sw\" title=\"拉伸左下角\"></i>",
				"</div>",
				"<div class=\"tdb-mini\" title=\"点击展开\">",
				"  <span class=\"tdb-m-err\">连接失败</span>",
				"  <span class=\"tdb-mc tdb-mc-total\"><b class=\"tdb-mv-total\">—</b><span class=\"tdb-ml\">总计</span></span>",
				"  <span class=\"tdb-mc tdb-mc-in\"><b class=\"tdb-mv-in\">—</b><span class=\"tdb-ml\">输入</span></span>",
				"  <span class=\"tdb-mc tdb-mc-out\"><b class=\"tdb-mv-out\">—</b><span class=\"tdb-ml\">输出</span></span>",
				"  <span class=\"tdb-mc tdb-mc-cr\"><b class=\"tdb-mv-cr\">—</b><span class=\"tdb-ml\">缓存</span></span>",
				"  <span class=\"tdb-mc tdb-mc-hit\"><b class=\"tdb-mv-hit\">—</b><span class=\"tdb-ml\">命中</span></span>",
				"  <span class=\"tdb-mc tdb-mc-calls\"><b class=\"tdb-mv-calls\">—</b><span class=\"tdb-ml\">调用</span></span>",
				"</div>"
			].join("");
			document.body.appendChild(root);

			var panel = root.querySelector(".tdb-panel");
			var miniEl = root.querySelector(".tdb-mini");
			var dot = root.querySelector(".tdb-dot");
			var summary = root.querySelector(".tdb-summary");
			var bodyEl = root.querySelector(".tdb-body");
			var toggleBtn = root.querySelector(".tdb-toggle");
			var refreshBtn = root.querySelector(".tdb-refresh");
			var fUpdated = root.querySelector(".tdb-fupdated");
			var statusEl = root.querySelector(".tdb-status");
			var selEl = root.querySelector(".tdb-select");
			var rangeBtns = root.querySelectorAll(".tdb-rag");
			var els = {};
			[["in", ".tdb-v-in"], ["out", ".tdb-v-out"], ["cr", ".tdb-v-cr"], ["hit", ".tdb-v-hit"], ["cw", ".tdb-v-cw"], ["ctx", ".tdb-v-ctx"], ["calls", ".tdb-v-calls"]].forEach(function (p) { els[p[0]] = root.querySelector(p[1]); });
			var c1 = root.querySelector(".tdb-c1");
			var c2 = root.querySelector(".tdb-c2");
			var c1Wrap = c1.parentElement;
			var c2Wrap = c2.parentElement;
			var c1Tip = c1Wrap.querySelector(".tdb-tip");
			var c2Tip = c2Wrap.querySelector(".tdb-tip");
			var c1leg = root.querySelector(".tdb-c1-legend");
			var c2leg = root.querySelector(".tdb-c2-legend");
			var rListEl = root.querySelector(".tdb-pane-session .tdb-rlist");
			var rLegEl = root.querySelector(".tdb-pane-session .tdb-rleg");
			var selId = readStore("session", "");
			/** 自动跟随最近活动的会话（默认开启）。 */
			var follow = readStore("follow", "1") === "1";
			/** 活动视图："summary" = 跨窗口汇总 + 按提供商分组的模型明细
			 *  （默认首页），"session" = 按会话，"deepseek" = 官方余额。 */
			var tab = readStore("tab", "summary");
			if (tab !== "summary" && tab !== "session" && tab !== "deepseek") tab = "summary";
			var TAB_ORDER = ["summary", "session", "deepseek"];
			/** 模型面板的提供商筛选（"" = 全部提供商）与文本搜索。 */
			var mFilter = readStore("mfilter", "");
			var mSearch = readStore("msearch", "");
			var mGroupOpen = {};
			try {
				var rawGroupOpen = readStore("mgroups", "");
				if (rawGroupOpen) {
					var parsedGroupOpen = JSON.parse(rawGroupOpen);
					if (parsedGroupOpen && typeof parsedGroupOpen === "object" && !Array.isArray(parsedGroupOpen)) mGroupOpen = parsedGroupOpen;
				}
			} catch { /* 展开状态损坏——使用默认状态 */ }
			var tabBtns = root.querySelectorAll(".tdb-tab");
			var paneSummary = root.querySelector(".tdb-pane-summary");
			var paneSession = root.querySelector(".tdb-pane-session");
			var paneDeepseek = root.querySelector(".tdb-pane-deepseek");
			var smListEl = root.querySelector(".tdb-smlist");
			var smBarsEl = root.querySelector(".tdb-pane-summary .tdb-bars");
			var smBarsTip = smBarsEl.parentElement.querySelector(".tdb-tip");
			var smBarsLeg = root.querySelector(".tdb-pane-summary .tdb-bleg");
			var smBarsLabel = root.querySelector(".tdb-pane-summary .tdb-blabel");
			var c2Label = root.querySelector(".tdb-pane-session .tdb-c2-label");
			/** 每日柱状图的显示模式："stack" = 按模型堆叠（默认），
			 *  "total" = 单一总量柱。与其他视图偏好一样持久化。 */
			var barMode = readStore("barmode", "stack");
			if (barMode !== "stack" && barMode !== "total") barMode = "stack";
			var barBtns = root.querySelectorAll(".tdb-bpick button");
			var wvEls = {};
			[["all", ".tdb-wv-all"], ["d30", ".tdb-wv-d30"], ["d7", ".tdb-wv-d7"], ["d1", ".tdb-wv-d1"]].forEach(function (p) { wvEls[p[0]] = root.querySelector(p[1]); });
			var mFilterEl = root.querySelector(".tdb-mfilter");
			var mSearchEl = root.querySelector(".tdb-msearch-input");
			var mCountEl = root.querySelector(".tdb-mcount");
			var dsNote = root.querySelector(".tdb-ds-note");
			var dsMeta = root.querySelector(".tdb-ds-meta");
			var dsEls = {};
			[["total", ".tdb-ds-total"], ["granted", ".tdb-ds-granted"], ["topped", ".tdb-ds-topped"]].forEach(function (p) { dsEls[p[0]] = root.querySelector(p[1]); });
			var dsC = {};
			[["h1", ".tdb-ds-c-h1"], ["h12", ".tdb-ds-c-h12"], ["d1", ".tdb-ds-c-d1"], ["d7", ".tdb-ds-c-d7"], ["all", ".tdb-ds-c-all"]].forEach(function (p) { dsC[p[0]] = root.querySelector(p[1]); });
			var dsChart = root.querySelector(".tdb-ds-chart");
			var dsChartWrap = dsChart.parentElement;
			var dsTip = dsChartWrap.querySelector(".tdb-tip");
			var dsLeg = root.querySelector(".tdb-ds-leg");
			/** 会话面板第一个图表显示的指标，与其他视图偏好一样持久化。 */
			var METRICS = ["out", "in", "cr", "total", "calls"];
			var sMetric = readStore("smetric", "out");
			if (METRICS.indexOf(sMetric) === -1) sMetric = "out";
			var sPickBtns = root.querySelectorAll(".tdb-spick button");

			/** 每个指标的图表配置：如何从一个趋势点取值、
			 *  对应的强调色、单位以及 tooltip 文案。在数据源变化时，
			 *  保持两个面板的第一个图表行为一致。 */
			var METRIC_DEFS = {
				out: { label: "输出", color: "var(--tdb-accent-out)", unit: "tok", pick: function (s) { return s.out; } },
				in: { label: "输入 · 未缓存", color: "var(--tdb-accent-in)", unit: "tok", pick: function (s) { return s.in; } },
				cr: { label: "缓存读取", color: "var(--tdb-accent-cr)", unit: "tok", pick: function (s) { return s.cr; } },
				total: { label: "总消耗(整体)", color: "var(--tdb-accent-ctx)", unit: "tok", pick: function (s) { return s.in + s.cr + (s.cw || 0) + s.out; } },
				calls: { label: "API 调用次数", color: "var(--tdb-accent-calls)", unit: "次", pick: function (s) { return typeof s.calls === "number" ? s.calls : 0; } },
			};

			/** 堆叠柱状图每个模型的分段配色（依消耗排名取色）：
			 *  优先复用面板强调色，随后用 design-token 色板补足，
			 *  保证浅色/深色主题下均可辨识。 */
			var STACK_COLORS = [
				"var(--tdb-accent-in)",
				"var(--tdb-accent-out)",
				"var(--tdb-accent-cr)",
				"var(--tdb-accent-calls)",
				"var(--tdb-accent-ctx)",
			];

			/** 渲染某个面板可切换的第一个图表。 */
			function renderMetricChart(container, legendEl, series, metric) {
				var def = METRIC_DEFS[metric] || METRIC_DEFS.out;
				var vals = series.map(def.pick);
				var isCalls = metric === "calls";
				renderChart(container, legendEl, vals, {
					color: def.color,
					unit: def.unit,
					min: 0,
					legend: vals.length >= 2
						? "峰值 " + (isCalls ? String(Math.max.apply(null, vals)) : fmt(Math.max.apply(null, vals))) + " · " + vals.length + slotUnit()
						: "",
					tooltip: function (i) {
						var s = series[i];
						var v = def.pick(s);
						return "<b>" + (isCalls ? String(v) + " 次" : fmt(v) + " tok") + "</b>" + def.label +
							'<span class="tdb-tip-time">' + tf(s.t) + "</span>";
					},
					emptyMsg: "暂无趋势数据",
				});
			}

			/** 应用已保存的位置/折叠状态。根自定义元素承担
			 *  fixed 定位；面板是它的（pointer-events:auto）子元素。 */
			function syncLayout() {
				root.style.left = pos ? Math.round(pos.x) + "px" : "";
				root.style.top = pos ? Math.round(pos.y) + "px" : "";
				root.style.right = pos ? "" : "16px";
				root.style.bottom = pos ? "" : "16px";
				setCollapsed(collapsed, true);
			}

			function setCollapsed(value, silent) {
				collapsed = !!value;
				bodyEl.hidden = collapsed;
				root.setAttribute("aria-collapsed", String(collapsed));
				toggleBtn.setAttribute("aria-expanded", String(!collapsed));
				if (!silent) writeStore("collapsed", collapsed ? "1" : "0");
				applySize();
			}

			function toggle() {
				setCollapsed(!collapsed, false);
				if (!collapsed) refreshNow();
			}

			function setError(message) {
				error = message || null;
				// 由 render() 渲染为红色「连接失败」徽章；此处保留 tooltip 详情。
				statusEl.title = error ? String(error) : "";
				render();
			}

			/** 要显示的会话；null → 全局「全部会话」视图。
			 *  跟随模式固定到最近活动的会话（服务端的 `activeId`）；
			 *  手动选择会完全覆盖跟随模式。 */
			function findSession(id) {
				if (!id || !data || !Array.isArray(data.sessions)) return null;
				for (var i = 0; i < data.sessions.length; i++) if (data.sessions[i].id === id) return data.sessions[i];
				return null;
			}
			function selectedSession() {
				if (!data || !Array.isArray(data.sessions) || data.sessions.length === 0) return null;
				if (follow) {
					// 跟随用户当前正在对话的会话；如果它落在了
					// 所选时间范围之外，则显示全局聚合数据。
					return findSession(data.activeId) || null;
				}
				return findSession(selId);
			}

			/** 构建折叠摘要中显示的胶囊徽章。 */
			function renderSummaryChips(totals, hit, occupancy) {
				var out = totals.output || 0;
				var parts = [
					'<span class="tdb-s-chip"><b>' + esc(fmt(out)) + '</b> 出</span>',
					hit === null
						? '<span class="tdb-s-chip"><b>—</b> 缓</span>'
						: '<span class="tdb-s-chip tdb-s-hit"><b>' + hit.toFixed(0) + '%</b> 缓</span>',
				];
				if (occupancy !== null) {
					parts.push('<span class="tdb-s-chip tdb-s-ctx"><b>' + occupancy.toFixed(0) + '%</b> ctx</span>');
				}
				return parts.join("");
			}

			/** 渲染单个带悬停 tooltip + 光标的 sparkline 图表。 */
			function renderChart(container, legendEl, values, opts) {
				legendEl.textContent = opts.legend || "";
				if (values.length < 2) {
					container.innerHTML = '<div class="tdb-empty">' + esc(opts.emptyMsg) + '</div>';
					return;
				}
				container.innerHTML = sparkSvg(values, { color: opts.color, baseline: opts.min });
				var svg = container.querySelector("svg.tdb-svg");
				if (!svg) return;
				// 注入一条跟随鼠标移动的虚线光标。
				var ns = "http://www.w3.org/2000/svg";
				var cursor = document.createElementNS(ns, "line");
				var vb = svg.getAttribute("viewBox").split(" ").map(Number);
				cursor.setAttribute("class", "tdb-cursor");
				cursor.setAttribute("y1", "0");
				cursor.setAttribute("y2", String(vb[3]));
				cursor.setAttribute("x1", "0");
				cursor.setAttribute("x2", "0");
				svg.appendChild(cursor);
				var wrap = container.parentElement;
				var tip = wrap.querySelector(".tdb-tip");
				function onMove(ev) {
					var rect = svg.getBoundingClientRect();
					var x = ev.clientX - rect.left;
					var frac = Math.max(0, Math.min(1, x / rect.width));
					var i = Math.round(frac * (values.length - 1));
					var cx = vb[2] * frac;
					cursor.setAttribute("x1", cx.toFixed(1));
					cursor.setAttribute("x2", cx.toFixed(1));
					cursor.classList.add("show");
					tip.innerHTML = opts.tooltip(i);
					var tipRect = tip.getBoundingClientRect();
					var px = Math.max(2, Math.min(rect.width - tipRect.width - 2, x - tipRect.width / 2));
					var py = Math.max(0, Math.min(rect.height - tipRect.height - 2, 8));
					tip.style.left = px + "px";
					tip.style.top = py + "px";
					tip.classList.add("show");
				}
				function onLeave() {
					cursor.classList.remove("show");
					tip.classList.remove("show");
				}
				svg.addEventListener("mousemove", onMove);
				svg.addEventListener("mouseleave", onLeave);
				svg.addEventListener("touchstart", function (ev) { var t = ev.touches && ev.touches[0]; if (t) onMove(t); }, { passive: true });
				svg.addEventListener("touchend", onLeave);
			}

			/** 柱状图 tooltip 的浮窗定位：贴在光标侧边（右侧优先，右侧放不下
			 *  翻到左侧），纵向按光标居中并夹在可见范围内。气泡不再「居中钉在
			 *  光标所在的那根柱子上」——那样会把鼠标还要看的其余柱子整片挡住，
			 *  越是靠右的柱子越明显。
			 *  纵向不能只夹在柱状图内：气泡比 84px 高的柱状图更高，那样夹的
			 *  结果永远是停在图表顶部；也不能只夹在面板内——真正的裁剪边界是
			 *  可滚动的 .tdb-body（overflow-y: auto，越界会被裁掉），所以按
			 *  wrap 与各 bounds 元素可见矩形的交集来夹。 */
			function placeBarsTip(tip, wrapEl, boundsEls, clientX, clientY) {
				var wrapRect = wrapEl.getBoundingClientRect();
				var tipRect = tip.getBoundingClientRect();
				var gap = 14;
				// 横向：贴光标侧边，右侧放不下就翻到左侧，再夹回柱状图内。
				var left = clientX + gap;
				if (left + tipRect.width > wrapRect.right - 2) left = clientX - gap - tipRect.width;
				var leftMin = wrapRect.left + 2;
				var leftMax = Math.max(leftMin, wrapRect.right - tipRect.width - 2);
				left = Math.max(leftMin, Math.min(leftMax, left));
				// 纵向：光标处居中，再夹进可见范围。
				var top = clientY - tipRect.height / 2;
				var topMin = wrapRect.top + 2;
				var topMax = wrapRect.bottom - tipRect.height - 2;
				for (var bi = 0; boundsEls && bi < boundsEls.length; bi++) {
					if (!boundsEls[bi]) continue;
					var boundsRect = boundsEls[bi].getBoundingClientRect();
					if (boundsRect.top + 2 > topMin) topMin = boundsRect.top + 2;
					var boundsMax = boundsRect.bottom - tipRect.height - 2;
					if (boundsMax < topMax) topMax = boundsMax;
				}
				topMax = Math.max(topMin, topMax);
				top = Math.max(topMin, Math.min(topMax, top));
				tip.style.left = Math.round(left - wrapRect.left) + "px";
				tip.style.top = Math.round(top - wrapRect.top) + "px";
			}

			/** 感知时间范围的横轴标签：1h/12h 用分钟，1d/7d 用小时，30d/全部用天。 */
			var tf = function (ms) { return range === "1h" || range === "12h" ? dtMin(ms) : range === "30d" || range === "all" ? dtDay(ms) : dtHour(ms); };
			/** 趋势点单位标签：1h/12h「分」、1d/7d「时」、30d/全部「天」。随 range
			 *  动态计算：因为用户切换范围后 legend 需立即反映新的时间粒度
			 *  （不能只在加载时求值一次，否则 1h → 30d 后单位会卡在「分」）。 */
			var slotUnit = function () { return range === "1h" || range === "12h" ? " 分" : range === "30d" || range === "all" ? " 天" : " 时"; };

			/** 渲染当前时间范围内的会话消耗排名：按整体消耗降序，只列窗口内
			 *  确有消耗的会话。数据直接取 payload.sessions[].totals——服务端
			 *  已按所选 range 切好（仅保留窗口内有贡献的会话），因此排名随顶部
			 *  时间范围联动；它不读「选择会话」下拉，那个下拉只管上方指标卡
			 *  与两张走势图。口径与上方指标卡一致：整体消耗 = 输入 + 缓存读
			 *  + 缓存写 + 输出。纯展示，不绑定点击。 */
			function renderSessionRank() {
				var list = data && Array.isArray(data.sessions) ? data.sessions : [];
				var rows = [];
				var grand = 0;
				for (var i = 0; i < list.length; i++) {
					var t0 = list[i].totals || {};
					var v0 = overall(t0);
					if (v0 <= 0) continue; // 窗口内无消耗的会话不入榜
					grand += v0;
					rows.push({ s: list[i], t: t0, v: v0, idx: i });
				}
				if (rows.length === 0) {
					rListEl.innerHTML = '<div class="tdb-empty">当前时间范围内暂无会话消耗</div>';
					rLegEl.textContent = "";
					return;
				}
				rows.sort(function (a, b) { return b.v - a.v; });
				rLegEl.textContent = rows.length + " 个会话 · 合计 " + fmt(grand) + " tok";
				// 条形长度按榜首归一（排名图惯例：第一名满格），百分比仍按
				// 窗口内全部会话的合计计算，与汇总页模型卡片的口径一致。
				var max = rows[0].v;
				var noCw = data.hasCacheWrite === false;
				var out = [];
				for (var r = 0; r < rows.length; r++) {
					var row = rows[r];
					var s = row.s;
					var t = row.t;
					var share = grand > 0 ? (row.v / grand) * 100 : 0;
					var calls = typeof t.calls === "number" ? t.calls : null;
					var tip = "会话 ID: " + s.id +
						(s.cwd ? "\n目录: " + s.cwd : "") +
						(s.preset ? "\n预设: " + s.preset : "") +
						"\n输入 " + fmt(t.uncached) + " / 缓存读 " + fmt(t.cacheRead) +
						" / 缓存写 " + (noCw ? "未上报" : fmt(t.cacheWrite)) +
						" / 输出 " + fmt(t.output) +
						" / 调用 " + (calls === null ? "未上报" : calls + " 次") +
						"\n占窗口总消耗 " + share.toFixed(1) + "%";
					out.push(
						'<div class="tdb-ritem" title="' + esc(tip) + '">' +
						'<div class="tdb-rtop">' +
						'<span class="tdb-rrank">#' + (r + 1) + '</span>' +
						'<span class="tdb-rname">' + esc(sessionLabel(s, row.idx)) + '</span>' +
						'<span class="tdb-rtotal" title="总消耗（输入 + 缓存读写 + 输出）">' + fmt(row.v) + ' tok</span>' +
						'<span class="tdb-rpct">' + share.toFixed(1) + '%</span>' +
						'</div>' +
						'<div class="tdb-mstats">' +
						'<span class="tdb-mstat tdb-ms-in" title="输入 · 未缓存"><i>入</i><b>' + fmt(t.uncached) + '</b></span>' +
						'<span class="tdb-mstat tdb-ms-cr" title="缓存读取"><i>读</i><b>' + fmt(t.cacheRead) + '</b></span>' +
						'<span class="tdb-mstat tdb-ms-cw" title="' + (noCw ? "数据源未上报缓存写入" : "缓存写入") + '"><i>写</i><b>' + (noCw ? "—" : fmt(t.cacheWrite)) + '</b></span>' +
						'<span class="tdb-mstat tdb-ms-out" title="输出"><i>出</i><b>' + fmt(t.output) + '</b></span>' +
						'<span class="tdb-mstat tdb-ms-calls" title="' + (calls === null ? "数据源未上报调用次数" : "当前时间范围内该会话的 API 调用次数") + '"><i>调</i><b>' + (calls === null ? "—" : String(calls)) + '</b></span>' +
						'</div>' +
						'<div class="tdb-rbar"><i style="width:' + Math.min(100, Math.max(0.5, (row.v / max) * 100)).toFixed(2) + '%"></i></div>' +
						'</div>'
					);
				}
				rListEl.innerHTML = out.join("");
			}

			/** 渲染某个会话的会话面板。 */
			function renderPaneSession(session) {
				if (!data || !data.totals || !session) {
					dot.className = "tdb-dot idle";
					for (var k in els) els[k].textContent = "—";
					c1.innerHTML = '<div class="tdb-empty">暂无趋势数据</div>';
					c2.innerHTML = '<div class="tdb-empty">暂无消耗数据</div>';
					c1leg.textContent = c2leg.textContent = "";
					if (c2Label) c2Label.textContent = (range === "1h" || range === "12h") ? "每分钟总消耗" : (range === "30d" || range === "all") ? "每日总消耗" : "每小时总消耗";
					renderSessionRank(); // 未选中会话时排名仍应可用
					return;
				}
				var totals = session.totals || {};
				var billed = (totals.uncached || 0) + (totals.cacheRead || 0) + (totals.cacheWrite || 0);
				var hit = billed > 0 ? ((totals.cacheRead || 0) / billed) * 100 : null;
				var context = session.context || {};
				var occupancy = null;
				if (typeof context.projectedTokens === "number" && typeof context.contextWindow === "number" && context.contextWindow > 0) {
					occupancy = (context.projectedTokens / context.contextWindow) * 100;
				}
				var series = Array.isArray(session.series) ? session.series : [];
				dot.className = "tdb-dot" + (series.length === 0 ? " idle" : "");
				els.in.textContent = fmt(totals.uncached);
				els.out.textContent = fmt(totals.output);
				els.cr.textContent = fmt(totals.cacheRead);
				if (data.hasCacheWrite === false) {
					els.cw.textContent = "—";
					els.cw.parentElement.title = "数据源未上报缓存写入";
				} else {
					els.cw.textContent = fmt(totals.cacheWrite);
					els.cw.parentElement.title = "";
				}
				els.hit.textContent = pct(hit, 1);
				els.ctx.textContent = occupancy === null
					? "—"
					: fmt(context.projectedTokens) + " / " + fmt(context.contextWindow) + "  " + occupancy.toFixed(0) + "%";
				// 时间窗口内本会话的 API 调用次数。
				var sCalls = typeof totals.calls === "number" ? totals.calls : null;
				els.calls.textContent = sCalls === null ? "—" : String(sCalls);
				els.calls.parentElement.title = sCalls === null
					? "数据源未上报调用次数"
					: "当前时间范围内本会话的 API 调用次数(每次模型回复计 1 次)";
				// 总消耗 = API 整体消耗（uncached 输入 + 缓存读取 +
				// 缓存写入 + 输出）。
				var totalVals = series.map(function (s) { return s.in + s.cr + (s.cw || 0) + s.out; });
				renderMetricChart(c1, c1leg, series, sMetric);
				// 第二张图的标题跟随当前范围的时间粒度（1h/12h 逐分钟、
				// 1d/7d 每小时、30d/全部 每天），与横轴标签保持一致。
				if (c2Label) c2Label.textContent = (range === "1h" || range === "12h") ? "每分钟总消耗" : (range === "30d" || range === "all") ? "每日总消耗" : "每小时总消耗";
				renderChart(c2, c2leg, totalVals, {
					color: "var(--tdb-accent-in)",
					unit: "tok",
					min: 0,
					legend: totalVals.length >= 2 ? "峰值 " + fmt(Math.max.apply(null, totalVals)) + " · " + totalVals.length + slotUnit() : "",
					tooltip: function (i) {
						var s = series[i];
						return "<b>" + fmt(s.in + s.cr + (s.cw || 0) + s.out) + " tok</b>总消耗(整体)" +
							'<span class="tdb-tip-time">' + tf(s.t) + "</span>";
					},
					emptyMsg: "暂无消耗数据",
				});
				renderSessionRank();
			}

			/** 渲染汇总页的模型明细：提供商可折叠分组 + 搜索/筛选
			 *  （原「模型」页逻辑整体并入汇总页）；每个模型用一行
			 *  摘要承载总量，第二行用紧凑指标承载 token 明细。 */
			function renderPaneModel() {
				var models = data && Array.isArray(data.models) ? data.models : [];
				var filter = mFilter;
				var query = String(mSearch || "").trim().toLowerCase();
				var provs = [];
				for (var fi = 0; fi < models.length; fi++) {
					var fp = (typeof models[fi].provider === "string" && models[fi].provider !== "" && models[fi].provider !== "未知")
						? models[fi].provider
						: "未知提供商";
					if (provs.indexOf(fp) === -1) provs.push(fp);
				}
				if (filter !== "" && provs.indexOf(filter) === -1) filter = "";
				mFilter = filter;
				var opts = '<option value="">全部提供商</option>';
				for (var pi = 0; pi < provs.length; pi++) {
					opts += '<option value="' + esc(provs[pi]) + '"' + (filter === provs[pi] ? ' selected' : '') + '>' + esc(provs[pi]) + '</option>';
				}
				mFilterEl.innerHTML = opts;
				mSearchEl.value = mSearch;
				if (models.length === 0) {
					mCountEl.textContent = "";
					smListEl.innerHTML = '<div class="tdb-empty">暂无模型数据</div>';
					return;
				}

				// 与柱状图共用同一套过滤（filteredModels），保证两处所见一致。
				var visible = filteredModels().visible;
				mCountEl.textContent = visible.length === models.length
					? models.length + " 个模型"
					: visible.length + " / " + models.length + " 个模型";
				if (visible.length === 0) {
					smListEl.innerHTML = '<div class="tdb-empty">没有匹配的模型</div>';
					return;
				}

				var groups = [];
				var gIndex = Object.create(null);
				for (var vi = 0; vi < visible.length; vi++) {
					var item = visible[vi];
					var gi = gIndex[item.provider];
					if (gi === undefined) {
						gi = groups.length;
						gIndex[item.provider] = gi;
						groups.push({ provider: item.provider, models: [] });
					}
					groups[gi].models.push(item);
				}

				var out = [];
				for (var g = 0; g < groups.length; g++) {
					var grp = groups[g];
					var gTotal = 0;
					var gShare = 0;
					for (var j = 0; j < grp.models.length; j++) {
						var gj = grp.models[j].model.totals || {};
						gTotal += overall(gj);
						gShare += typeof grp.models[j].model.sharePct === "number" ? grp.models[j].model.sharePct : 0;
					}
					var savedOpen = Object.prototype.hasOwnProperty.call(mGroupOpen, grp.provider);
					var groupOpen = savedOpen ? mGroupOpen[grp.provider] !== false : (groups.length === 1 || g === 0);
					out.push(
						'<details class="tdb-mgroup" data-provider="' + esc(grp.provider) + '"' + (groupOpen ? ' open' : '') + '>' +
						'<summary aria-label="展开或收起 ' + esc(grp.provider) + '">' +
						'<span class="tdb-mg-name" title="提供商">' + esc(grp.provider) + '</span>' +
						'<span class="tdb-mg-total">' + grp.models.length + ' 个模型 · ' + fmt(gTotal) + ' tok</span>' +
						'<span class="tdb-mg-pct">' + gShare.toFixed(1) + '%</span>' +
						'</summary><div class="tdb-mgroup-body">'
					);
					for (var k = 0; k < grp.models.length; k++) {
						var entry = grp.models[k];
						var mm = entry.model;
						var t = mm.totals || {};
						var total = overall(t);
						var share = typeof mm.sharePct === "number" ? mm.sharePct : 0;
						var hit = typeof mm.hitPct === "number" ? mm.hitPct : 0;
						var hitTxt = hit > 0 ? "缓存命中 " + hit.toFixed(1) + "%" : "缓存命中率 —";
						var mCalls = typeof t.calls === "number" ? t.calls : null;
						var cacheWrite = data.hasCacheWrite === false ? "—" : fmt(t.cacheWrite);
						var cacheWriteTip = data.hasCacheWrite === false ? "数据源未上报缓存写入" : "缓存写入";
						out.push(
							'<div class="tdb-mcard">' +
							'<div class="tdb-mtop"><b class="tdb-mname" title="' + esc(entry.provider + " / " + entry.name) + '">' + esc(entry.name) + '</b>' +
							'<span class="tdb-mtotal" title="总消耗（输入 + 缓存读写 + 输出）">' + fmt(total) + ' tok</span>' +
							'<span class="tdb-mpct">' + share.toFixed(1) + '%</span></div>' +
							'<div class="tdb-mstats">' +
							'<span class="tdb-mstat tdb-ms-in" title="输入 · 未缓存"><i>入</i><b>' + fmt(t.uncached) + '</b></span>' +
							'<span class="tdb-mstat tdb-ms-cr" title="缓存读取"><i>读</i><b>' + fmt(t.cacheRead) + '</b></span>' +
							'<span class="tdb-mstat tdb-ms-cw" title="' + cacheWriteTip + '"><i>写</i><b>' + cacheWrite + '</b></span>' +
							'<span class="tdb-mstat tdb-ms-out" title="输出"><i>出</i><b>' + fmt(t.output) + '</b></span>' +
							'<span class="tdb-mstat tdb-ms-calls" title="' + (mCalls === null ? '数据源未上报调用次数' : '当前时间范围内该模型的 API 调用次数') + '"><i>调</i><b>' + (mCalls === null ? "—" : String(mCalls)) + '</b></span>' +
							'</div>' +
							'<div class="tdb-mbar" title="' + esc("占窗口总消耗 " + share.toFixed(1) + "% · " + hitTxt) + '"><i style="width:' + Math.min(100, Math.max(0.5, share)) + '%"></i></div>' +
							'</div>'
						);
					}
					out.push('</div></details>');
				}
				smListEl.innerHTML = out.join("");
				var groupEls = smListEl.querySelectorAll(".tdb-mgroup");
				for (var ge = 0; ge < groupEls.length; ge++) {
					groupEls[ge].addEventListener("toggle", function () {
						mGroupOpen[this.getAttribute("data-provider")] = this.open;
						writeStore("mgroups", JSON.stringify(mGroupOpen));
					});
				}
			}

			/** 渲染汇总面板：累计/1月/1周/1日 四个滚动窗口卡片（服务端
			 *  windowTotals 单遍累计，与所选时间范围无关）、跟随时间范围
			 *  的每日柱状图（按模型堆叠 / 总量双模式，悬停显示分项明细），
			 *  以及按提供商分组、可搜索筛选的模型明细（原「模型」页整体并入）。 */
			function renderPaneSummary() {
				if (!data) {
					smListEl.innerHTML = '<div class="tdb-empty">暂无模型数据</div>';
					smBarsEl.innerHTML = '<div class="tdb-empty">暂无消耗数据</div>';
					smBarsLeg.innerHTML = "";
					return;
				}
				// ── 四窗口卡片 ──
				var wt = data && data.windowTotals ? data.windowTotals : null;
				var wMeta = [
					["all", "累计总消耗", "全部历史累计"],
					["d30", "最近一月", "滚动窗口：now-30天 至今"],
					["d7", "最近一周", "滚动窗口：now-7天 至今"],
					["d1", "最近一日", "滚动窗口：now-24小时 至今"],
				];
				for (var wi = 0; wi < wMeta.length; wi++) {
					var wk = wMeta[wi][0];
					var el = wvEls[wk];
					var wv = wt ? wt[wk] : null;
					if (!wv) {
						el.textContent = "—";
						el.parentElement.title = wMeta[wi][2] + " · 暂无数据";
					} else {
						el.textContent = fmt(overall(wv));
						el.parentElement.title = wMeta[wi][2] +
							" · 输入 " + fmt(wv.uncached) + " / 缓存读 " + fmt(wv.cacheRead) +
							" / 缓存写 " + fmt(wv.cacheWrite) + " / 输出 " + fmt(wv.output) +
							" / 调用 " + (typeof wv.calls === "number" ? wv.calls : "—") + " 次" +
							"（口径：整体消耗 = 输入 + 缓存读写 + 输出）";
					}
				}
				// ── 每日柱状图：数据取当前范围的 series（30d/全部时服务端已按天
				//  分桶；7d/1d 按小时、1h/12h 按分钟，标签相应变化）。 ──
				var series = data && Array.isArray(data.series) ? data.series : [];
				var perDay = range === "30d" || range === "all";
				var perMin = range === "1h" || range === "12h";
				var unitLbl = perDay ? "天" : perMin ? "分钟" : "小时";
				if (smBarsLabel) smBarsLabel.textContent = perDay ? "每日总消耗" : perMin ? "每分钟总消耗" : "每小时总消耗";
				// 槽位极多时（12h 逐分钟约 721 格）柱间 1px 间隙会吃掉整个容器宽度，
				// 把每根柱压成 0 宽，切换为无间隙让柱本身占满宽度。阀值只在高密度
				// 范围命中，其余范围的观感不变。该 class 每次渲染重设，范围切回
				// 小时/天后自动移除。
				if (series.length > 200) smBarsEl.classList.add("tdb-dense");
				else smBarsEl.classList.remove("tdb-dense");
				smBarsEl.innerHTML = "";
				smBarsLeg.innerHTML = "";
				var grandVals = series.map(function (s) { return (s.in || 0) + (s.cr || 0) + (s.cw || 0) + (s.out || 0); });
				// 柱状图跟随搜索/筛选：与下方分组列表共用同一份可见模型集合，
				// 只统计可见模型的时段消耗（未过滤时与全局序列对账一致）。
				var fv = filteredModels();
				var filterActive = mFilter !== "" || String(mSearch || "").trim() !== "";
				var hasMs = Array.isArray(data.modelSeries) && data.modelSeries.length > 0;
				var agg = hasMs ? aggregateModelSeries(data.modelSeries, fv.visible) : null;
				// 可见模型的每槽分项合计（无堆叠数据时为 null → 退回全局序列）。
				var sums = agg ? agg.sums : null;
				var vals;
				if (sums) {
					vals = [];
					for (var zi = 0; zi < series.length; zi++) {
						var d0 = sums[zi];
						vals.push(d0 ? (d0.in + d0.cr + d0.cw + d0.out) : 0);
					}
				} else {
					vals = grandVals;
				}
				if (series.length === 0) {
					smBarsEl.innerHTML = '<div class="tdb-empty">暂无消耗数据</div>';
				} else if (filterActive && fv.visible.length === 0) {
					smBarsEl.innerHTML = '<div class="tdb-empty">没有匹配的模型</div>';
				} else if (barMode === "stack" && hasMs) {
					// ── 堆叠模式：按模型分段着色。跟随搜索/筛选，每个可见模型
					//  独立成段（不再合并「其他」），模型小时桶已由服务端按时段切片。 ──
					var parts = agg.parts;
					var max = Math.max.apply(null, vals);
					if (max <= 0) max = 1;
					var peaks = 0;
					var frag = document.createDocumentFragment();
					for (var bi = 0; bi < series.length; bi++) {
						var col = document.createElement("div");
						col.className = "tdb-bcol";
						for (var pj = 0; pj < parts.length; pj++) {
							var segVal = parts[pj].perSlot[bi] || 0;
							if (segVal <= 0) continue;
							var seg = document.createElement("i");
							seg.style.height = Math.max(1, (segVal / max) * 100).toFixed(2) + "%";
							seg.style.background = parts[pj].color;
							col.appendChild(seg);
						}
						if (vals[bi] > 0) peaks++;
						frag.appendChild(col);
					}
					smBarsEl.appendChild(frag);
					var maxI = vals.indexOf(max);
					// 图例位置放统计文字（N 个天有消耗 · 峰值），模型图例不常驻：
					// 具体模型归属由悬停 tooltip 与下方分组列表承载。
					var legendTxt = peaks + " 个" + unitLbl + "有消耗 · " + (series[maxI] ? tf(series[maxI].t) + " 峰值 " + fmt(max) + " tok" : "");
					smBarsLeg.textContent = legendTxt;
					// 悬停交互：跟随的 tooltip 显示该时段的按模型消耗 + 全局分项。
					var onBarMove = function (ev) {
						var rect = smBarsEl.getBoundingClientRect();
						var x = ev.clientX - rect.left;
						var frac = Math.max(0, Math.min(1, x / rect.width));
						var i = Math.round(frac * (series.length - 1));
						var s = series[i];
						var v = vals[i];
						var rows = "";
						for (var rj = 0; rj < parts.length; rj++) {
							var rv = parts[rj].perSlot[i] || 0;
							if (rv <= 0) continue;
							rows += '<span class="tdb-tip-detail"><i style="display:inline-block;width:7px;height:7px;border-radius:2px;background:' + parts[rj].color + ';margin-right:4px"></i>' + esc(parts[rj].label) + "  " + fmt(rv) + " tok</span>";
						}
						smBarsTip.innerHTML = "<b>" + fmt(v) + " tok</b>总消耗(整体)" +
							'<span class="tdb-tip-time">' + tf(s.t) + "</span>" +
							rows +
							'<span class="tdb-tip-detail">入 ' + fmt(s.in) + " · 读 " + fmt(s.cr) + " · 写 " + fmt(s.cw || 0) + " · 出 " + fmt(s.out) + "</span>" +
							(typeof s.calls === "number" ? '<span class="tdb-tip-detail">调用 ' + s.calls + " 次</span>" : "");
						placeBarsTip(smBarsTip, smBarsEl, [bodyEl, panel], ev.clientX, ev.clientY);
						smBarsTip.classList.add("show");
					};
					var onBarLeave = function () { smBarsTip.classList.remove("show"); };
					// 用 on* 属性而不是 addEventListener：容器是持久元素，
					// 每次轮询重渲染时属性赋值自动覆盖，监听器不会叠加。
					smBarsEl.onmousemove = onBarMove;
					smBarsEl.onmouseleave = onBarLeave;
					smBarsEl.ontouchstart = function (ev) { var t = ev.touches && ev.touches[0]; if (t) onBarMove(t); };
					smBarsEl.ontouchend = onBarLeave;
				} else {
					// ── 总量模式（或堆叠数据缺失时的兜底）：单一总量柱，
					//  同样只统计搜索/筛选后的可见模型。 ──
					var max2 = Math.max.apply(null, vals);
					if (max2 <= 0) max2 = 1;
					var peaks2 = 0;
					var frag2 = document.createDocumentFragment();
					for (var bi2 = 0; bi2 < series.length; bi2++) {
						var col2 = document.createElement("div");
						col2.className = "tdb-bcol";
						var bar = document.createElement("i");
						bar.style.height = Math.max(1.5, (vals[bi2] / max2) * 100).toFixed(1) + "%";
						if (vals[bi2] > 0) peaks2++;
						col2.appendChild(bar);
						frag2.appendChild(col2);
					}
					smBarsEl.appendChild(frag2);
					var maxI2 = vals.indexOf(max2);
					var legend2 = peaks2 + " 个" + unitLbl + "有消耗 · " + (series[maxI2] ? tf(series[maxI2].t) + " 峰值 " + fmt(max2) + " tok" : "");
					smBarsLeg.textContent = legend2;
					// 悬停交互：跟随的 tooltip 显示当日/当小时完整分项。
					var onBarMove2 = function (ev) {
						var rect = smBarsEl.getBoundingClientRect();
						var x = ev.clientX - rect.left;
						var frac = Math.max(0, Math.min(1, x / rect.width));
						var i = Math.round(frac * (series.length - 1));
						var s = series[i];
						var v = vals[i];
						smBarsTip.innerHTML = v <= 0
							? "无消耗" + '<span class="tdb-tip-time">' + tf(s.t) + "</span>"
							: "<b>" + fmt(v) + " tok</b>总消耗(整体)" +
								'<span class="tdb-tip-time">' + tf(s.t) + "</span>" +
								'<span class="tdb-tip-detail">入 ' + fmt(s.in) + " · 读 " + fmt(s.cr) + " · 写 " + fmt(s.cw || 0) + " · 出 " + fmt(s.out) + "</span>" +
								(typeof s.calls === "number" ? '<span class="tdb-tip-detail">调用 ' + s.calls + " 次</span>" : "");
						placeBarsTip(smBarsTip, smBarsEl, [bodyEl, panel], ev.clientX, ev.clientY);
						smBarsTip.classList.add("show");
					};
					var onBarLeave2 = function () { smBarsTip.classList.remove("show"); };
					smBarsEl.onmousemove = onBarMove2;
					smBarsEl.onmouseleave = onBarLeave2;
					smBarsEl.ontouchstart = function (ev) { var t2 = ev.touches && ev.touches[0]; if (t2) onBarMove2(t2); };
					smBarsEl.ontouchend = onBarLeave2;
				}
				// ── 模型明细：按提供商分组 + 搜索/筛选（原「模型」页逻辑）。 ──
				renderPaneModel();
			}

			/** 堆叠柱状图的模型分段：把服务端按模型的每时段序列
			 *  （modelSeries）折叠为每个可见模型一个独立分段（不合并「其他」）。
			 *  parts 与传入 models 同序（服务端已按整体消耗降序），
			 *  每段携带与服务端 series 一一对应的 perSlot 数组；
			 *  sums 是所有分段每槽的分项合计（in/cr/cw/out），
			 *  过滤激活时柱高与 tooltip 都以它为准。 */
			function aggregateModelSeries(modelSeries, models) {
				var parts = [];
				for (var i = 0; i < models.length; i++) {
					// filteredModels 的可见项形状是 { model: 模型对象, provider, name: 模型名字符串 }，
					// key/label 必须取 name（模型名字符串）而不是 model（整个模型对象）。
					var mKey = (models[i].provider || "") + "|" + (models[i].name || "");
					var modelName = (typeof models[i].name === "string" && models[i].name !== "") ? models[i].name : "未知";
					parts.push({ key: mKey, label: modelName, color: STACK_COLORS[i % STACK_COLORS.length], perSlot: [] });
				}
				// 每槽分项合计（跨分段求和，供过滤后的总量柱与 tooltip 使用）。
				var sums = [];
				// 单遍扫描服务端 modelSeries：每条 { key, series } 按序累加。
				for (var si = 0; si < modelSeries.length; si++) {
					var entry = modelSeries[si];
					var dst = null;
					for (var di = 0; di < parts.length; di++) {
						if (parts[di].key === entry.key) { dst = parts[di]; break; }
					}
					if (dst === null) continue; // 不在可见集合中的模型跳过
					var src = entry.series || [];
					for (var ki = 0; ki < src.length; ki++) {
						var dIn = src[ki].in || 0, dCr = src[ki].cr || 0, dCw = src[ki].cw || 0, dOut = src[ki].out || 0;
						dst.perSlot[ki] = (dst.perSlot[ki] || 0) + dIn + dCr + dCw + dOut;
						if (!sums[ki]) sums[ki] = { in: 0, cr: 0, cw: 0, out: 0 };
						sums[ki].in += dIn;
						sums[ki].cr += dCr;
						sums[ki].cw += dCw;
						sums[ki].out += dOut;
					}
				}
				// 过滤模式下未在 modelSeries 中出现的可见模型（无时段数据）也保留分段位，
				// perSlot 保持为空数组即可（渲染时自然跳过零值段）。
				return { parts: parts, sums: sums };
			}

			/** 与下方分组列表同一套过滤规则（提供商筛选 + 搜索词）求可见模型，
			 *  供柱状图与列表共用；provider 归一逻辑与 renderPaneModel 一致。 */
			function filteredModels() {
				var models = data && Array.isArray(data.models) ? data.models : [];
				var filter = mFilter;
				var query = String(mSearch || "").trim().toLowerCase();
				if (filter !== "" && models.every(function (m) {
					var p = (typeof m.provider === "string" && m.provider !== "" && m.provider !== "未知") ? m.provider : "未知提供商";
					return p !== filter;
				})) filter = "";
				var visible = [];
				for (var i = 0; i < models.length; i++) {
					var model = models[i];
					var provider = (typeof model.provider === "string" && model.provider !== "" && model.provider !== "未知") ? model.provider : "未知提供商";
					var modelName = typeof model.model === "string" && model.model !== "" ? model.model : "未知";
					var haystack = (provider + " " + modelName).toLowerCase();
					if (filter !== "" && provider !== filter) continue;
					if (query !== "" && haystack.indexOf(query) === -1) continue;
					visible.push({ model: model, provider: provider, name: modelName });
				}
				return { visible: visible, filter: filter };
			}

			/** 渲染 DeepSeek 面板：官方账户余额（未配置密钥或 fetch 失败时
			 *  显示配置/错误提示）、各时间窗的余额降幅，以及余额随时间变化的曲线。 */
			function renderPaneDeepseek() {
				var b = data && data.balance ? data.balance : null;
				var v = { total: "—", granted: "—", topped: "—" };
				if (b && b.ok && Array.isArray(b.infos) && b.infos.length > 0) {
					var i0 = b.infos[0];
					if (typeof i0.total === "number" && Number.isFinite(i0.total)) v.total = "¥" + i0.total.toFixed(2);
					if (typeof i0.granted === "number" && Number.isFinite(i0.granted)) v.granted = "¥" + i0.granted.toFixed(2);
					if (typeof i0.topped === "number" && Number.isFinite(i0.topped)) v.topped = "¥" + i0.topped.toFixed(2);
				}
				dsEls.total.textContent = v.total;
				dsEls.granted.textContent = v.granted;
				dsEls.topped.textContent = v.topped;
				// 各时间窗内的余额下降量累计（¥）。服务端按采样段累计余额
				// 下降量，充值/赠送到账不计为消耗，因此不会为负；窗口边界
				// 跨采样段时按时间占比折算（近似）。
				var c = b && b.consumed ? b.consumed : null;
				var cKeys = [["h1", "近1小时"], ["h12", "近12小时"], ["d1", "近24小时"], ["d7", "近7天"], ["all", "自监控以来"]];
				for (var ci = 0; ci < cKeys.length; ci++) {
					var ck = cKeys[ci][0];
					var cv = c && typeof c[ck] === "number" ? Math.max(0, c[ck]) : null;
					var el = dsC[ck];
					if (cv === null) {
						el.textContent = "—";
						el.parentElement.title = "采样数据不足";
					} else {
						el.textContent = "−¥" + cv.toFixed(2);
						el.parentElement.title = cKeys[ci][1] + "累计消耗（余额下降量累计，充值/赠送不计入；窗口边界按采样折算，以官方账单为准）";
					}
				}
				if (!b) {
					dsNote.textContent = "余额信息暂不可用";
					dsNote.title = "余额信息暂不可用";
					dsNote.className = "tdb-ds-note";
				} else if (!b.configured) {
					dsNote.textContent = "未配置 DeepSeek API Key";
					dsNote.title = "请在 DSH 凭据中配置 DEEPSEEK_API_KEY，或设置环境变量 DEEPSEEK_API_KEY。密钥只存在服务端，不会下发到页面。";
					dsNote.className = "tdb-ds-note err";
				} else if (!b.ok) {
					var balanceError = b.error || "未知错误";
					dsNote.textContent = "获取余额失败：" + balanceError;
					dsNote.title = "获取余额失败：" + balanceError + "（稍后自动重试，已有历史样本保留）";
					dsNote.className = "tdb-ds-note err";
				} else {
					var avail = b.is_available === false ? "账户不可用" : "账户正常";
					var cur = b.infos.length > 0 ? b.infos.map(function (i) { return String(i.currency || "?"); }).join("/") : "—";
					dsNote.textContent = "已连接 · 币种 " + cur + " · " + avail;
					dsNote.title = "已连接 DeepSeek 官方 API · 币种 " + cur + " · " + avail + " · 消耗为余额下降量累计（充值/赠送不计入），以官方账单为准";
					dsNote.className = "tdb-ds-note ok";
				}
				// 根据历史样本绘制的余额随时间变化曲线。
				var hist = b && Array.isArray(b.history) ? b.history : [];
				var vals = [];
				for (var hi = 0; hi < hist.length; hi++) {
					if (typeof hist[hi].total === "number" && Number.isFinite(hist[hi].total)) vals.push(hist[hi].total);
				}
				if (vals.length < 2) {
					dsChart.innerHTML = '<div class="tdb-empty">暂无余额样本</div>';
					dsLeg.textContent = "";
				} else {
					dsChart.innerHTML = sparkSvg(vals, { color: "var(--tdb-accent-ctx)", baseline: 0 });
					var svg = dsChart.querySelector("svg.tdb-svg");
					if (svg) {
						var ns = "http://www.w3.org/2000/svg";
						var cursor = document.createElementNS(ns, "line");
						var vb = svg.getAttribute("viewBox").split(" ").map(Number);
						cursor.setAttribute("class", "tdb-cursor");
						cursor.setAttribute("y1", "0");
						cursor.setAttribute("y2", String(vb[3]));
						cursor.setAttribute("x1", "0");
						cursor.setAttribute("x2", "0");
						svg.appendChild(cursor);
						function onDsMove(ev) {
							var rect = svg.getBoundingClientRect();
							var x = ev.clientX - rect.left;
							var frac = Math.max(0, Math.min(1, x / rect.width));
							var i = Math.round(frac * (vals.length - 1));
							var cx = vb[2] * frac;
							cursor.setAttribute("x1", cx.toFixed(1));
							cursor.setAttribute("x2", cx.toFixed(1));
							cursor.classList.add("show");
							var h = hist[i];
							dsTip.innerHTML = "<b>¥" + h.total.toFixed(2) + "</b>余额" +
								'<span class="tdb-tip-time">' + (h.t ? tf(h.t) : "") + "</span>";
							var tipRect = dsTip.getBoundingClientRect();
							var px = Math.max(2, Math.min(rect.width - tipRect.width - 2, x - tipRect.width / 2));
							var py = Math.max(0, Math.min(rect.height - tipRect.height - 2, 8));
							dsTip.style.left = px + "px";
							dsTip.style.top = py + "px";
							dsTip.classList.add("show");
						}
						function onDsLeave() {
							cursor.classList.remove("show");
							dsTip.classList.remove("show");
						}
						svg.addEventListener("mousemove", onDsMove);
						svg.addEventListener("mouseleave", onDsLeave);
						svg.addEventListener("touchstart", function (ev) { var t = ev.touches && ev.touches[0]; if (t) onDsMove(t); }, { passive: true });
						svg.addEventListener("touchend", onDsLeave);
					}
					dsLeg.textContent = hist.length + " 样本 · 现 ¥" + (vals[vals.length - 1]).toFixed(2);
				}
				dsMeta.textContent = b && b.fetchedAt ? "上次获取 " + clock(b.fetchedAt) + " · 整点/半点采样 · 历史已持久化，重启保留" : "—";
			}

			/** 渲染失败的兜底：渲染本身绝不能冒泡到轮询循环与事件回调，否则一次
			 *  坏数据就会让整个面板（连带后续每次刷新）永久停摆。降级为面板内提示。
			 *  render() 是安全包装，真正的渲染实现在 renderInner()。 */
			function render() {
				try {
					renderInner();
				} catch (err) {
					try {
						console.warn("[dsh-token-dashboard] render failed:", err);
					} catch { /* 控制台不可用时静默 */ }
					try {
						statusEl.textContent = "渲染失败";
						statusEl.className = "tdb-status tdb-status-err";
						dot.className = "tdb-dot idle";
						if (smListEl) smListEl.innerHTML = '<div class="tdb-empty">渲染失败：数据格式与当前插件版本不匹配</div>';
					} catch { /* 连兜底提示都失败则彻底放弃本次渲染 */ }
				}
			}

			/** 根据 `data` 重新渲染所有内容（由 render() 包崩溃防护）。 */
			function renderInner() {
				if (error) {
					statusEl.textContent = "连接失败";
					statusEl.className = "tdb-status tdb-status-err";
				} else if (data && data.backfilled) {
					statusEl.textContent = "已回填";
					statusEl.className = "tdb-status tdb-status-ok";
				} else if (data && data.backfillError) {
					statusEl.textContent = "回填失败";
					statusEl.className = "tdb-status tdb-status-err";
				} else {
					statusEl.textContent = data ? "回填中…" : "连接中…";
					statusEl.className = "tdb-status tdb-status-pending";
				}
				for (var ri = 0; ri < rangeBtns.length; ri++) {
					rangeBtns[ri].classList.toggle("active", rangeBtns[ri].getAttribute("data-range") === range);
				}
				for (var ti = 0; ti < tabBtns.length; ti++) {
					tabBtns[ti].classList.toggle("active", tabBtns[ti].getAttribute("data-tab") === tab);
				}
				for (var spi = 0; spi < sPickBtns.length; spi++) {
					sPickBtns[spi].classList.toggle("active", sPickBtns[spi].getAttribute("data-metric") === sMetric);
				}
				for (var bbi = 0; bbi < barBtns.length; bbi++) {
					barBtns[bbi].classList.toggle("active", barBtns[bbi].getAttribute("data-bmode") === barMode);
				}
				paneSummary.hidden = tab !== "summary";
				paneSession.hidden = tab !== "session";
				paneDeepseek.hidden = tab !== "deepseek";

				var session = selectedSession(); // 会话面板当前的会话（或 null）
				renderPaneSummary();
				renderPaneSession(session);
				renderPaneDeepseek();

				// 头部摘要跟随当前活动的标签页。
				var totals, hit, occupancy;
				if (tab === "summary") {
					// 汇总标签页头部：累计总消耗；页脚 = 四窗口对比。
					var wAll = data && data.windowTotals ? data.windowTotals.all : null;
					summary.innerHTML = wAll
						? '<span class="tdb-s-chip tdb-s-ctx"><b>' + esc(fmt(overall(wAll))) + '</b> 累计</span>'
						: '<span class="tdb-s-chip"><b>—</b> 累计</span>';
					var wT = data && data.windowTotals ? data.windowTotals : null;
					fUpdated.textContent = wT
						? "累计 " + fmt(overall(wT.all)) + " · 1月 " + fmt(overall(wT.d30)) + " · 1周 " + fmt(overall(wT.d7)) + " · 1日 " + fmt(overall(wT.d1)) + " tok"
						: "汇总数据加载中";
					fUpdated.title = "口径：整体消耗 = 未缓存输入 + 缓存读写 + 输出；窗口随当前时刻滚动";
				} else if (tab === "deepseek") {
					// DeepSeek 标签页头部：官方账户余额（+ 配置状态）。
					var db = data && data.balance ? data.balance : null;
					var dTotal = null;
					if (db && db.ok && Array.isArray(db.infos) && db.infos.length > 0) {
						var di = db.infos[0];
						if (typeof di.total === "number" && Number.isFinite(di.total)) dTotal = di.total;
					}
					if (dTotal !== null) {
						summary.innerHTML = '<span class="tdb-s-chip tdb-s-ctx"><b>¥' + dTotal.toFixed(2) + '</b> 余额</span>';
					} else {
						summary.innerHTML = '<span class="tdb-s-chip"><b>—</b> 余额</span>';
					}
					var dStat = !db ? "连接中…" : !db.configured ? "未配置 Key" : !db.ok ? "获取失败" : (db.is_available === false ? "不可用" : "官方余额");
					fUpdated.textContent = "DeepSeek 官方 · " + dStat + (db && db.fetchedAt ? " · " + clock(db.fetchedAt) : "");
					fUpdated.title = db && db.configured && !db.ok && db.error ? db.error : "";
				} else if (session) {
					totals = session.totals || {};
					var sb = (totals.uncached || 0) + (totals.cacheRead || 0) + (totals.cacheWrite || 0);
					hit = sb > 0 ? ((totals.cacheRead || 0) / sb) * 100 : null;
					var sctx = session.context || {};
					occupancy = (typeof sctx.projectedTokens === "number" && typeof sctx.contextWindow === "number" && sctx.contextWindow > 0)
						? (sctx.projectedTokens / sctx.contextWindow) * 100
						: null;
					summary.innerHTML = renderSummaryChips(totals, hit, occupancy);
					fUpdated.textContent = (session.updatedAt ? clock(session.updatedAt) : "—") + " · " + fmt(totals.output || 0) + " tok";
					if (follow) {
						fUpdated.title = "跟随当前会话: " + sessionLabel(session, 0);
					} else {
						fUpdated.title = "";
					}
				} else {
					summary.innerHTML = '<span class="tdb-s-chip"><b>—</b> 等待</span>';
					fUpdated.textContent = "无数据";
					fUpdated.title = "";
				}
				updateSelect();

				// 迷你胶囊（折叠态）：跟随当前活动标签页与时间范围显示对应汇总。
			// summary/汇总：当前所选时间范围的窗口汇总；session/会话：当前选中会话；
			// deepseek/DeepSeek：官方余额。
			miniEl.classList.toggle("err", !!error);
			var rangeLabel = range === "all" ? "全部" : range === "30d" ? "1月" : range === "7d" ? "1周" : range === "1d" ? "1天" : range === "12h" ? "12小时" : "1小时";
			var mB = {};
			[["total", ".tdb-mv-total"], ["in", ".tdb-mv-in"], ["out", ".tdb-mv-out"], ["cr", ".tdb-mv-cr"], ["hit", ".tdb-mv-hit"], ["calls", ".tdb-mv-calls"]].forEach(function (p) { mB[p[0]] = miniEl.querySelector(p[1]); });
			var mLabelEls = {};
			[["total", ".tdb-mc-total"], ["in", ".tdb-mc-in"], ["out", ".tdb-mc-out"], ["cr", ".tdb-mc-cr"], ["hit", ".tdb-mc-hit"], ["calls", ".tdb-mc-calls"]].forEach(function (p) { mLabelEls[p[0]] = miniEl.querySelector(p[1] + " .tdb-ml"); });
			// 胶囊标签：deepseek 余额模式下切换为余额相关标签，其余标签页恢复 token 标签。
			var mTokenLabels = { total: "总计", in: "输入", out: "输出", cr: "缓存", hit: "命中", calls: "调用" };
			// 余额胶囊只有 6 格，装不下 1h/12h/24h/7天/累计 五档；折叠态取
			// 最近的三档（1h/12h/24h），7天与累计在展开的余额页查看。
			var mBalanceLabels = { total: "余额", in: "赠送", out: "充值", cr: "1h耗", hit: "12h耗", calls: "24h耗" };
			// 汇总页胶囊显示当前所选时间范围的窗口汇总（选 1天 = 最近一天，
			// 选 1月 = 最近一月），不再是四个滚动窗口的累计对比。
			var mSummaryLabels = { total: rangeLabel, in: "输入", out: "输出", cr: "缓存", hit: "命中", calls: "调用" };
			var mLabelSet = tab === "deepseek" ? mBalanceLabels : tab === "summary" ? mSummaryLabels : mTokenLabels;
			// 三个视图都显示六个胶囊：命中率与调用次数在汇总页同样有意义。
			mLabelEls.hit.parentElement.style.display = "";
			mLabelEls.calls.parentElement.style.display = "";
			for (var mlk in mLabelSet) if (mLabelEls[mlk]) mLabelEls[mlk].textContent = mLabelSet[mlk];
			mB.total.classList.remove("tdb-mv-balance");

			if (tab === "summary") {
				miniEl.title = error ? String(error) : "当前范围汇总（" + rangeLabel + "）· 点击展开";
				var st = data && data.totals ? data.totals : null;
				if (st) {
					var stBilled = (st.uncached || 0) + (st.cacheRead || 0) + (st.cacheWrite || 0);
					var stHit = stBilled > 0 ? ((st.cacheRead || 0) / stBilled) * 100 : null;
					mB.total.textContent = fmt(overall(st));
					mB.total.parentElement.title = "当前范围总消耗(整体) · " + rangeLabel;
					mB.in.textContent = fmt(st.uncached);
					mB.in.parentElement.title = "输入 · 未缓存";
					mB.out.textContent = fmt(st.output);
					mB.out.parentElement.title = "输出";
					mB.cr.textContent = fmt(st.cacheRead);
					mB.cr.parentElement.title = "缓存读取";
					mB.hit.textContent = stHit === null ? "—" : stHit.toFixed(0) + "%";
					mB.hit.parentElement.title = stHit === null ? "总命中率" : "总命中率 " + stHit.toFixed(1) + "%";
					var stCalls = typeof st.calls === "number" ? st.calls : null;
					mB.calls.textContent = stCalls === null ? "—" : String(stCalls);
					mB.calls.parentElement.title = stCalls === null ? "数据源未上报调用次数" : "API 调用次数(每次模型回复计 1 次)";
				} else {
					for (var mk in mB) mB[mk].textContent = "—";
				}
			} else if (tab === "session") {
				miniEl.title = error ? String(error) : "当前会话（" + rangeLabel + "）· 点击展开";
				var sess = selectedSession();
				if (sess && sess.totals) {
					var sb = (sess.totals.uncached || 0) + (sess.totals.cacheRead || 0) + (sess.totals.cacheWrite || 0);
					var shit = sb > 0 ? ((sess.totals.cacheRead || 0) / sb) * 100 : null;
					mB.total.textContent = fmt(overall(sess.totals));
					mB.total.parentElement.title = "总消耗(整体)";
					mB.in.textContent = fmt(sess.totals.uncached);
					mB.in.parentElement.title = "输入 · 未缓存";
					mB.out.textContent = fmt(sess.totals.output);
					mB.out.parentElement.title = "输出";
					mB.cr.textContent = fmt(sess.totals.cacheRead);
					mB.cr.parentElement.title = "缓存读取";
					mB.hit.textContent = shit === null ? "—" : shit.toFixed(0) + "%";
					mB.hit.parentElement.title = shit === null ? "总命中率" : "总命中率 " + shit.toFixed(1) + "%";
					var sCalls = typeof sess.totals.calls === "number" ? sess.totals.calls : null;
					mB.calls.textContent = sCalls === null ? "—" : String(sCalls);
					mB.calls.parentElement.title = sCalls === null ? "数据源未上报调用次数" : "API 调用次数(每次模型回复计 1 次)";
				} else {
					for (var mk in mB) mB[mk].textContent = "—";
				}
			} else if (tab === "deepseek") {
				miniEl.title = error ? String(error) : "DeepSeek 余额（" + rangeLabel + "）· 点击展开";
				var db = data && data.balance ? data.balance : null;
				var di = db && db.ok && Array.isArray(db.infos) && db.infos.length > 0 ? db.infos[0] : null;
				var dTotal = di && typeof di.total === "number" && Number.isFinite(di.total) ? di.total : null;
				var dGranted = di && typeof di.granted === "number" && Number.isFinite(di.granted) ? di.granted : null;
				var dTopped = di && typeof di.topped === "number" && Number.isFinite(di.topped) ? di.topped : null;
				var dC = db && db.consumed ? db.consumed : null;
				var fmtC = function (cv) {
					if (cv === null || typeof cv !== "number" || !Number.isFinite(cv)) return "—";
					// 服务端口径为余额下降量累计，不会为负；此处仅防御性截断。
					return "−¥" + Math.max(0, cv).toFixed(2);
				};
				mB.total.textContent = dTotal === null ? "—" : "¥" + dTotal.toFixed(2);
				mB.total.parentElement.title = dTotal === null ? "总余额" : "总余额 ¥" + dTotal.toFixed(2);
				mB.total.classList.add("tdb-mv-balance");
				mB.in.textContent = dGranted === null ? "—" : "¥" + dGranted.toFixed(2);
				mB.in.parentElement.title = "赠送余额";
				mB.out.textContent = dTopped === null ? "—" : "¥" + dTopped.toFixed(2);
				mB.out.parentElement.title = "充值余额";
				mB.cr.textContent = fmtC(dC ? dC.h1 : null);
				mB.cr.parentElement.title = "近1小时余额消耗";
				mB.hit.textContent = fmtC(dC ? dC.h12 : null);
				mB.hit.parentElement.title = "近12小时余额消耗";
				mB.calls.textContent = fmtC(dC ? dC.d1 : null);
				mB.calls.parentElement.title = "近24小时余额消耗";
			}
			}

			/** 供选择器使用的人类可读会话标签：派生的标题（首条用户消息）→
			 *  cwd 的 basename → 序号，并附上短 id 后缀
			 *  以及可选的预设标签以消除歧义。 */
			function sessionLabel(s, i) {
				var base = "";
				if (typeof s.title === "string" && s.title !== "") {
					base = s.title.length > 26 ? s.title.slice(0, 26) + "…" : s.title;
				} else if (typeof s.cwd === "string" && s.cwd !== "") {
					var parts = s.cwd.split(/[\\/]/).filter(Boolean);
					base = parts.length ? parts[parts.length - 1] : s.cwd;
				} else {
					base = "会话 " + (i + 1);
				}
				var short = typeof s.id === "string" && s.id.length > 6 ? s.id.slice(-6) : (s.id || "");
				var preset = typeof s.preset === "string" && s.preset !== "" ? " [" + s.preset + "]" : "";
				return base + " ·" + short + preset;
			}

			function updateSelect() {
				if (!data || (!Array.isArray(data.sessions) || data.sessions.length === 0) && !data.totals) {
					selEl.hidden = true;
					selEl.innerHTML = "";
					return;
				}
				selEl.hidden = false;
				var options = [
					'<option value="__follow__"' + (follow ? " selected" : "") + '>⚡ 跟随进行中的会话</option>'
				];
				var list = Array.isArray(data.sessions) ? data.sessions : [];
				for (var i = 0; i < list.length; i++) {
					var s = list[i];
					var tip = "会话 ID: " + s.id + (s.cwd ? "\n目录: " + s.cwd : "") + (s.preset ? "\n预设: " + s.preset : "");
					options.push("<option value=\"" + esc(s.id) + "\"" + (!follow && s.id === selId ? " selected" : "") + " title=\"" + esc(tip) + "\">" + esc(sessionLabel(s, i)) + "</option>");
				}
				var html = options.join("");
				if (selEl.innerHTML !== html) selEl.innerHTML = html;
			}

			// ── 数据 ────────────────────────────────────────────────────────────
			var fetching = null;
			var timer = null;

			async function refresh() {
				if (document.hidden) return;
				if (fetching) return fetching;
				fetching = (async function () {
					var response;
					var url = apiPath + "?range=" + encodeURIComponent(range);
					try {
						response = await window.fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
						if (!response.ok) throw new Error("HTTP " + response.status);
						var payload = await response.json();
						if (!payload || payload.ok !== true) throw new Error("bad payload");
						data = payload;
						if (selId && payload.sessions && !payload.sessions.some(function (s) { return s.id === selId; })) selId = "";
						setError(null);
						render();
					} catch (err) {
						setError("无法连接: " + (err && err.message ? err.message : String(err)));
					} finally {
						fetching = null;
					}
				})();
				return fetching;
			}

			function refreshNow() {
				refresh();
			}

			/** 手动刷新——立即 fetch（绕过轮询间隔），
			 *  刷新按钮上短暂显示旋转动画作为反馈。 */
			var refreshTick = 0;
			function doRefresh() {
				refreshBtn.classList.add("loading");
				var myTick = ++refreshTick;
				window.setTimeout(function () {
					if (refreshTick !== myTick) return;
					refreshBtn.classList.remove("loading");
				}, 800);
				refreshNow();
			}

			// ── 交互 ────────────────────────────────────────────────────
			var head = root.querySelector(".tdb-head");
			var drag = null;

			function onPointerDown(ev) {
				if (ev.button !== 0) return;
				if (ev.target && ev.target.closest && ev.target.closest(".tdb-btns")) return;
				var rect = root.getBoundingClientRect();
				drag = { dx: ev.clientX - rect.left, dy: ev.clientY - rect.top, moved: false };
				ev.currentTarget.setPointerCapture(ev.pointerId);
				ev.currentTarget.addEventListener("pointermove", onPointerMove);
				ev.currentTarget.addEventListener("pointerup", onPointerUp);
				ev.currentTarget.addEventListener("pointercancel", onPointerUp);
				ev.preventDefault();
			}
			function onPointerMove(ev) {
				if (!drag) return;
				var x = ev.clientX - drag.dx;
				var y = ev.clientY - drag.dy;
				pos = clampRect({ x: x, y: y });
				drag.moved = true;
				root.style.left = Math.round(pos.x) + "px";
				root.style.top = Math.round(pos.y) + "px";
				root.style.right = "";
				root.style.bottom = "";
			}
			function onPointerUp(ev) {
				if (!drag) return;
				if (!drag.moved) toggle();
				drag = null;
				ev.currentTarget.removeEventListener("pointermove", onPointerMove);
				ev.currentTarget.removeEventListener("pointerup", onPointerUp);
				ev.currentTarget.removeEventListener("pointercancel", onPointerUp);
				if (pos) writeStore("pos", JSON.stringify(pos));
			}

			head.addEventListener("pointerdown", onPointerDown);
			miniEl.addEventListener("pointerdown", onPointerDown);
			toggleBtn.addEventListener("click", toggle);

			// ── 边缘/角落拉伸 ─────────────────────────────────────────────
			// 四边与四角各有一个隐形手柄（.tdb-rsz）。拉伸在屏幕坐标中
			// 计算新矩形：固定对侧边缘，让被抓住的边缘跟随光标，并把
			// 结果同时写回面板尺寸与（若脱离默认角落停靠）显式位置。
			// 尺寸与位置都持久化到 localStorage。
			var sizeW = null, sizeH = null;
			try {
				var rawSize = readStore("size", "");
				if (rawSize) {
					var parsedSize = JSON.parse(rawSize);
					if (typeof parsedSize.w === "number" && Number.isFinite(parsedSize.w)) sizeW = parsedSize.w;
					if (typeof parsedSize.h === "number" && Number.isFinite(parsedSize.h)) sizeH = parsedSize.h;
				}
			} catch { /* 存储损坏——忽略 */ }

			/** 应用自定义尺寸（null = 未设置 → 走 CSS 默认）。
			 *  折叠时高度回到自动（只保留头部一行）。 */
			function applySize() {
				panel.style.width = sizeW ? Math.round(sizeW) + "px" : "";
				panel.style.height = sizeH && !collapsed ? Math.round(sizeH) + "px" : "";
				// 显式高度接管后放开主体的默认 max-height，让内容区填满面板。
				bodyEl.style.maxHeight = sizeH ? "none" : "";
			}

			var rsz = null;
			function onRszDown(ev) {
				if (ev.button !== 0) return;
				var handle = ev.currentTarget;
				var rect = panel.getBoundingClientRect();
				rsz = { dir: handle.getAttribute("data-rsz"), sx: ev.clientX, sy: ev.clientY, rect: rect, moved: false };
				handle.setPointerCapture(ev.pointerId);
				handle.addEventListener("pointermove", onRszMove);
				handle.addEventListener("pointerup", onRszUp);
				handle.addEventListener("pointercancel", onRszUp);
				ev.preventDefault();
				ev.stopPropagation();
			}
			function onRszMove(ev) {
				if (!rsz) return;
				var dx = ev.clientX - rsz.sx;
				var dy = ev.clientY - rsz.sy;
				var r = rsz.rect;
				var dir = rsz.dir;
				var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
				var minW = 300, maxW = Math.max(minW, vw - 16);
				var minH = 110, maxH = Math.max(minH, vh - 16);
				var x = r.left, y = r.top, w = r.width, h = r.height;
				if (dir.indexOf("e") !== -1) { w = Math.min(maxW, Math.max(minW, r.width + dx)); x = r.left; }
				if (dir.indexOf("w") !== -1) { w = Math.min(maxW, Math.max(minW, r.width - dx)); x = r.right - w; }
				if (!collapsed) {
					// 折叠时高度由头部决定，忽略纵向拉伸。
					if (dir.indexOf("s") !== -1) { h = Math.min(maxH, Math.max(minH, r.height + dy)); y = r.top; }
					if (dir.indexOf("n") !== -1) { h = Math.min(maxH, Math.max(minH, r.height - dy)); y = r.bottom - h; }
				}
				// 保证面板整体留在视口内。
				x = Math.max(4, Math.min(x, vw - w - 4));
				y = Math.max(4, Math.min(y, vh - h - 4));
				rsz.moved = true;
				// 拉伸即脱离默认角落停靠，转为显式定位（与拖拽行为一致）。
				pos = { x: x, y: y };
				root.style.left = Math.round(x) + "px";
				root.style.top = Math.round(y) + "px";
				root.style.right = "";
				root.style.bottom = "";
				sizeW = w;
				if (!collapsed) sizeH = h;
				applySize();
			}
			function onRszUp(ev) {
				if (!rsz) return;
				var handle = ev.currentTarget;
				rsz = null;
				handle.removeEventListener("pointermove", onRszMove);
				handle.removeEventListener("pointerup", onRszUp);
				handle.removeEventListener("pointercancel", onRszUp);
				writeStore("size", JSON.stringify({ w: sizeW, h: sizeH }));
				if (pos) writeStore("pos", JSON.stringify(pos));
			}
			var rszHandles = root.querySelectorAll(".tdb-rsz");
			for (var rz = 0; rz < rszHandles.length; rz++) {
				rszHandles[rz].addEventListener("pointerdown", onRszDown);
			}
			refreshBtn.addEventListener("click", function (ev) { ev.stopPropagation(); doRefresh(); });
			selEl.addEventListener("change", function () {
				var v = selEl.value;
				if (v === "__follow__") {
					follow = true;
					writeStore("follow", "1");
				} else {
					follow = false;
					writeStore("follow", "0");
					selId = v; // 一个具体的会话 id
					writeStore("session", selId);
				}
				render();
			});
			mFilterEl.addEventListener("change", function () {
				mFilter = mFilterEl.value; // "" = 全部提供商
				writeStore("mfilter", mFilter);
				render();
			});
			mSearchEl.addEventListener("input", function () {
				mSearch = mSearchEl.value;
				writeStore("msearch", mSearch);
				render();
			});
			for (var tb = 0; tb < tabBtns.length; tb++) {
				tabBtns[tb].addEventListener("click", function () {
					var t = this.getAttribute("data-tab");
					if (t === tab) return;
					tab = t;
					writeStore("tab", tab);
					if (tab === "session" && !follow && selId === "") {
						// 进入会话视图但未固定任何会话 → 跟随当前活动的会话。
						follow = true;
						writeStore("follow", "1");
					}
					render();
				});
			}
			for (var rb = 0; rb < rangeBtns.length; rb++) {
				rangeBtns[rb].addEventListener("click", function (ev) {
					var r = this.getAttribute("data-range");
					if (r === range) return;
					range = r;
					writeStore("range", range);
					// 时间范围已变化——立即用新的窗口刷新。
					refreshNow();
					render();
				});
			}
			var onVis = function () { if (!document.hidden) refreshNow(); };
			document.addEventListener("visibilitychange", onVis);

			// 图表指标选择器：会话面板第一个图表的数据源切换。
			// payload 已携带每个趋势点的所有指标，因此切换
			// 只是纯粹的重新渲染，无需重新请求。
			for (var sb = 0; sb < sPickBtns.length; sb++) {
				sPickBtns[sb].addEventListener("click", function () {
					var m = this.getAttribute("data-metric");
					if (m === sMetric) return;
					sMetric = m;
					writeStore("smetric", sMetric);
					render();
				});
			}
			// 每日柱状图的 堆叠(按模型)/总量 视图切换；纯客户端重渲染。
			for (var bb = 0; bb < barBtns.length; bb++) {
				barBtns[bb].addEventListener("click", function () {
					var m = this.getAttribute("data-bmode");
					if (m === barMode) return;
					barMode = m;
					writeStore("barmode", barMode);
					render();
				});
			}

			// 键盘快捷键：[ 折叠，] 展开，r 刷新，t 循环标签页（汇总→会话→DeepSeek），0 汇总标签，f 跟随活动会话，1..9 选择会话。
			function onKey(ev) {
				if (ev.defaultPrevented) return;
				var t = ev.target;
				// 不与文本输入框 / 会话下拉框本身发生冲突。
				if (t && t.tagName) {
					var tag = t.tagName;
					if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
					if (t.isContentEditable) return;
				}
				if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
				if (ev.key === "[") { setCollapsed(true, false); ev.preventDefault(); }
				else if (ev.key === "]") { setCollapsed(false, false); refreshNow(); ev.preventDefault(); }
				else if (ev.key === "r" || ev.key === "R") { doRefresh(); ev.preventDefault(); }
				else if (ev.key === "t" || ev.key === "T") {
					var tIdx = TAB_ORDER.indexOf(tab);
					tab = TAB_ORDER[(tIdx + 1) % TAB_ORDER.length];
					writeStore("tab", tab);
					if (tab === "session" && !follow && selId === "") {
						follow = true;
						writeStore("follow", "1");
					}
					render();
					ev.preventDefault();
				}
				else if (ev.key === "0") {
					// 切换到汇总（默认）标签页。
					tab = "summary";
					writeStore("tab", tab);
					render();
					ev.preventDefault();
				}
				else if (ev.key === "f" || ev.key === "F") {
					follow = !follow;
					writeStore("follow", follow ? "1" : "0");
					if (follow) selId = "";
					render();
					ev.preventDefault();
				}
				else if (/^[1-9]$/.test(ev.key)) {
					if (data && Array.isArray(data.sessions) && data.sessions[Number(ev.key) - 1]) {
						follow = false;
						writeStore("follow", "0");
						selId = data.sessions[Number(ev.key) - 1].id;
						writeStore("session", selId);
						render();
						ev.preventDefault();
					}
				}
			}
			document.addEventListener("keydown", onKey);

			// ── 生命周期 ───────────────────────────────────────────────────────
			syncLayout();
			render();
			refreshNow();
			// 定时器回调必须自己吞掉异常：setInterval 不会消费 refresh() 返回的
			// promise，漏出的 rejection 在浏览器里是一类难查的噪音，且会让本轮
			// 之后的逻辑（若有）静默中断。
			timer = setInterval(function () {
				try {
					var p = refresh();
					if (p && typeof p.catch === "function") p.catch(function () {});
				} catch (err) {
					try {
						console.warn("[dsh-token-dashboard] poll tick failed:", err);
					} catch { /* 控制台不可用时静默 */ }
				}
			}, refreshMs);

			ctx.effect(function* () {
				yield function dispose() {
					clearInterval(timer);
					head.removeEventListener("pointerdown", onPointerDown);
					miniEl.removeEventListener("pointerdown", onPointerDown);
					for (var rzx = 0; rzx < rszHandles.length; rzx++) {
						rszHandles[rzx].removeEventListener("pointerdown", onRszDown);
					}
					document.removeEventListener("visibilitychange", onVis);
					document.removeEventListener("keydown", onKey);
					if (root && root.parentNode) root.parentNode.removeChild(root);
				};
			}, "dsh-token-dashboard: widget");
		}

		exports.name = "dsh-token-dashboard";
		exports.apply = apply;

		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
