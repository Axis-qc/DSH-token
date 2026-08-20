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
			"  --tdb-font: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;",
			"  --tdb-mono: ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace;",
			"  --tdb-radius-sm: 6px;",
			"  --tdb-radius-md: 10px;",
			"  --tdb-radius-lg: 14px;",
			"  --tdb-pad-x: 14px;",
			"  --tdb-pad-y: 12px;",
			"  --tdb-gap: 10px;",
			// 深色主题（默认——系统配色为浅色时会在下方切换）
			"  --tdb-bg: rgba(22, 22, 28, .82);",
			"  --tdb-bg-elev: rgba(255, 255, 255, .045);",
			"  --tdb-bg-cell: rgba(255, 255, 255, .04);",
			"  --tdb-bg-cell-hover: rgba(255, 255, 255, .07);",
			"  --tdb-bg-chart: rgba(255, 255, 255, .03);",
			"  --tdb-border: rgba(255, 255, 255, .08);",
			"  --tdb-border-strong: rgba(255, 255, 255, .14);",
			"  --tdb-fg: #e9eaee;",
			"  --tdb-fg-muted: rgba(233, 234, 238, .55);",
			"  --tdb-fg-faint: rgba(233, 234, 238, .35);",
			"  --tdb-shadow: 0 10px 32px rgba(0, 0, 0, .35), 0 2px 6px rgba(0, 0, 0, .25);",
			"  --tdb-accent-in: #7aa2ff;",
			"  --tdb-accent-out: #b8a5ff;",
			"  --tdb-accent-cr: #3fb950;",
			"  --tdb-accent-cw: #d29922;",
			"  --tdb-accent-hit: #3fb950;",
			"  --tdb-accent-ctx: #f778ba;",
			"  --tdb-accent-calls: #56d4dd;",
			"  --tdb-accent-ok: #3fb950;",
			"  --tdb-accent-warn: #d29922;",
			"  --tdb-accent-err: #f85149;",
			"}",
			"@media (prefers-color-scheme: light) {",
			"  dsh-token-dashboard {",
			"    --tdb-bg: rgba(252, 252, 254, .86);",
			"    --tdb-bg-elev: rgba(0, 0, 0, .025);",
			"    --tdb-bg-cell: rgba(0, 0, 0, .03);",
			"    --tdb-bg-cell-hover: rgba(0, 0, 0, .055);",
			"    --tdb-bg-chart: rgba(0, 0, 0, .02);",
			"    --tdb-border: rgba(0, 0, 0, .08);",
			"    --tdb-border-strong: rgba(0, 0, 0, .14);",
			"    --tdb-fg: #1c1c20;",
			"    --tdb-fg-muted: rgba(28, 28, 32, .55);",
			"    --tdb-fg-faint: rgba(28, 28, 32, .32);",
			"    --tdb-shadow: 0 10px 32px rgba(15, 18, 35, .12), 0 2px 6px rgba(15, 18, 35, .06);",
			"  }",
			"}",
			// ── 根容器 ─────────────────────────────────────────────────
			// `position: fixed` 让元素脱离任何祖先 flex/grid 布局流，因此面板
			// 永远不会被拉伸到整个视口（即「贴到底部 / 撑大页面」的症状）。
			// `width/height: max-content` 让盒子的尺寸正好等于内容大小，
			// `pointer-events: none` 让点击完全穿透该元素——只有面板子元素
			// （它重新启用了 pointer 事件）是可交互的，因此不会有任何不可见区域
			// 挡住下方的 DSH UI。
			"dsh-token-dashboard{",
			"  all: initial; display: block; position: fixed;",
			"  right: 16px; bottom: 16px; z-index: 2147483000;",
			"  width: max-content; height: max-content; max-width: 90vw; max-height: 90vh;",
			"  pointer-events: none;",
			"  color-scheme: light dark; font-family: var(--tdb-font); font-size: 12px; line-height: 1.5;",
			"  color: var(--tdb-fg); user-select: none; -webkit-user-select: none;",
			"  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;",
			"}",
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
			"dsh-token-dashboard .tdb-mini .tdb-mc-total b.tdb-mv-balance{ color: #2ecc71; font-weight: 700; }",
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
			"dsh-token-dashboard .tdb-summary .tdb-s-hit{ border-color: transparent; background: rgba(63, 185, 80, .12); color: var(--tdb-accent-cr); }",
			"dsh-token-dashboard .tdb-summary .tdb-s-hit b{ color: var(--tdb-accent-cr); }",
			"dsh-token-dashboard .tdb-summary .tdb-s-ctx{ border-color: transparent; background: rgba(247, 120, 186, .10); color: var(--tdb-accent-ctx); }",
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
			"  box-shadow: 0 4px 12px rgba(0, 0, 0, .25);",
			"  opacity: 0; transition: opacity .12s ease; z-index: 2;",
			"  max-width: 200px;",
			"}",
			"dsh-token-dashboard .tdb-tip.show{ opacity: 1; }",
			"dsh-token-dashboard .tdb-tip b{ color: var(--tdb-fg); font-weight: 600; margin-right: 4px; }",
			"dsh-token-dashboard .tdb-tip .tdb-tip-time { color: var(--tdb-fg-muted); font-size: 10px; display: block; }",
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
			// 模型面板（按模型的消耗卡片）
			"dsh-token-dashboard .tdb-mlist{ display: flex; flex-direction: column; gap: 8px; }",
			"dsh-token-dashboard .tdb-mcard{",
			"  background: var(--tdb-bg-cell); border: 1px solid var(--tdb-border); border-radius: var(--tdb-radius-sm);",
			"  padding: 8px 10px 7px; display: flex; flex-direction: column; gap: 6px;",
			"}",
			"dsh-token-dashboard .tdb-mtop{ display: flex; align-items: baseline; gap: 8px; min-width: 0; }",
			"dsh-token-dashboard .tdb-mname{",
			"  font-family: var(--tdb-mono); font-size: 12.5px; font-weight: 600; color: var(--tdb-fg);",
			"  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;",
			"}",
			"dsh-token-dashboard .tdb-mprov{",
			"  font-size: 10px; color: var(--tdb-fg-faint); flex: 1; min-width: 0;",
			"  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;",
			"}",
			"dsh-token-dashboard .tdb-mpct{ font-family: var(--tdb-mono); font-size: 12px; color: var(--tdb-accent-in); white-space: nowrap; }",
			"dsh-token-dashboard .tdb-mgrid{ display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }",
			"dsh-token-dashboard .tdb-mgrid .tdb-cell{ padding: 6px 8px; }",
			"dsh-token-dashboard .tdb-mgrid .tdb-cell b{ font-size: 13px; }",
			"dsh-token-dashboard .tdb-mgrid .tdb-mtot{",
			"  grid-column: 1 / -1; border-left-color: var(--tdb-accent-ctx);",
			"  flex-direction: row; align-items: baseline; justify-content: space-between; gap: 8px;",
			"}",
			"dsh-token-dashboard .tdb-mgrid .tdb-mtot b{ font-size: 14px; color: var(--tdb-accent-ctx); }",
			"dsh-token-dashboard .tdb-mgrid .tdb-mtot span{ font-size: 10px; }",
			"dsh-token-dashboard .tdb-mbar{ height: 3px; background: var(--tdb-bg-chart); border-radius: 2px; overflow: hidden; }",
			"dsh-token-dashboard .tdb-mbar i{",
			"  display: block; height: 100%; background: linear-gradient(90deg, var(--tdb-accent-in), var(--tdb-accent-out));",
			"  border-radius: 2px;",
			"}",
			// 模型面板：按提供商分组头（组名 + 组内汇总）
			"dsh-token-dashboard .tdb-mgroup{",
			"  display: flex; align-items: baseline; gap: 8px; margin-top: 8px; padding: 3px 2px 0;",
			"}",
			"dsh-token-dashboard .tdb-mgroup:first-child{ margin-top: 0; }",
			"dsh-token-dashboard .tdb-mg-name{",
			"  font-family: var(--tdb-mono); font-size: 12px; font-weight: 700; color: var(--tdb-fg);",
			"  white-space: nowrap;",
			"}",
			"dsh-token-dashboard .tdb-mg-total{",
			"  font-size: 10px; color: var(--tdb-fg-muted); flex: 1; min-width: 0;",
			"  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;",
			"}",
			"dsh-token-dashboard .tdb-mg-pct{",
			"  font-family: var(--tdb-mono); font-size: 11px; color: var(--tdb-accent-in); white-space: nowrap;",
			"}",
			// DeepSeek 余额面板
			"dsh-token-dashboard .tdb-ds-note{",
			"  font-size: 11px; color: var(--tdb-fg-muted); padding: 10px 8px;",
			"  border: 1px dashed var(--tdb-border-strong); border-radius: var(--tdb-radius-sm);",
			"  background: var(--tdb-bg-chart); line-height: 1.5;",
			"}",
			"dsh-token-dashboard .tdb-ds-note.err{ color: var(--tdb-accent-err); border-color: var(--tdb-accent-err); }",
			"dsh-token-dashboard .tdb-ds-note.ok{ color: var(--tdb-accent-ok); border-color: color-mix(in srgb, var(--tdb-accent-ok) 45%, transparent); }",
			"dsh-token-dashboard .tdb-ds-meta{ font-size: 10.5px; color: var(--tdb-fg-faint); text-align: right; }",
			"dsh-token-dashboard .tdb-mlist .tdb-empty{ padding: 22px 0; }",
			"dsh-token-dashboard .tdb-selrow .tdb-select{",
			"  flex: 1; min-width: 0; background: var(--tdb-bg-cell); color: var(--tdb-fg);",
			"  border: 1px solid var(--tdb-border); border-radius: var(--tdb-radius-sm);",
			"  font-size: 10.5px; padding: 3px 6px; cursor: pointer;",
			"  font-variant-numeric: tabular-nums;",
			"}",
			"dsh-token-dashboard .tdb-selrow .tdb-select:hover{ background: var(--tdb-bg-cell-hover); }",
			"dsh-token-dashboard .tdb-selrow .tdb-select option{ background: var(--tdb-bg); color: var(--tdb-fg); }",
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
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"dsh-token-dashboard/panel.css\"]") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-token-dashboard";
			tag.dataset.pluginCss = "dsh-token-dashboard/panel.css";
			tag.textContent = CSS;
			document.head.appendChild(tag);
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
			var color = (opts && opts.color) || "#58a6ff";
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
			config = config || {};
			var apiPath = typeof config.apiPath === "string" && config.apiPath !== "" ? config.apiPath : "/token-dashboard/api";
			var refreshMs = Number(config.refreshMs) > 0 ? Number(config.refreshMs) : 2500;

			var data = null;        // 最近一次成功的 payload
			var error = null;       // 最近一次 fetch 的错误文本
			var collapsed = readStore("collapsed", "1") === "1";
			var range = readStore("range", "all");
			if (["all", "30d", "7d", "1d", "1h"].indexOf(range) === -1) range = "all";
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
				"      <button type=\"button\" class=\"tdb-rag\" data-range=\"1h\">1小时</button>",
				"    </div>",
				"    <div class=\"tdb-tabs\" role=\"tablist\" aria-label=\"视图\">",
				"      <button type=\"button\" class=\"tdb-tab\" data-tab=\"all\">总消耗</button>",
				"      <button type=\"button\" class=\"tdb-tab\" data-tab=\"session\">会话</button>",
				"      <button type=\"button\" class=\"tdb-tab\" data-tab=\"model\">模型</button>",
				"      <button type=\"button\" class=\"tdb-tab\" data-tab=\"deepseek\">DeepSeek</button>",
				"    </div>",
				"    <div class=\"tdb-pane tdb-pane-all\">",
				"      <div class=\"tdb-grid\">",
				"        <div class=\"tdb-cell tdb-c-in\"><b class=\"tdb-av-in\">—</b><span><i class=\"tdb-i\"></i>输入 · uncached</span></div>",
				"        <div class=\"tdb-cell tdb-c-out\"><b class=\"tdb-av-out\">—</b><span><i class=\"tdb-i\"></i>输出</span></div>",
				"        <div class=\"tdb-cell tdb-c-cr\"><b class=\"tdb-av-cr\">—</b><span><i class=\"tdb-i\"></i>缓存读取</span></div>",
				"        <div class=\"tdb-cell tdb-c-hit\"><b class=\"tdb-av-hit\">—</b><span><i class=\"tdb-i\"></i>总命中率</span></div>",
				"        <div class=\"tdb-cell tdb-c-cw\"><b class=\"tdb-av-cw\">—</b><span><i class=\"tdb-i\"></i>缓存写入</span></div>",
				"        <div class=\"tdb-cell tdb-c-ctx\"><b class=\"tdb-av-ctx\">—</b><span><i class=\"tdb-i\"></i>上下文占用</span></div>",
				"        <div class=\"tdb-cell tdb-c-calls\"><b class=\"tdb-av-calls\">—</b><span><i class=\"tdb-i\"></i>API 调用次数 · 全部会话</span></div>",
				"      </div>",
				"      <div class=\"tdb-chart\">",
				"        <div class=\"tdb-clabel\"><span class=\"tdb-mpick tdb-apick\" role=\"tablist\" aria-label=\"图表数据\">",
				"          <button type=\"button\" data-metric=\"out\">输出</button>",
				"          <button type=\"button\" data-metric=\"in\">输入</button>",
				"          <button type=\"button\" data-metric=\"cr\">缓存读取</button>",
				"          <button type=\"button\" data-metric=\"total\">总消耗</button>",
				"          <button type=\"button\" data-metric=\"calls\">调用次数</button>",
				"        </span><span class=\"tdb-ac1l\"></span></div>",
				"        <div class=\"tdb-chart-wrap\"><div class=\"tdb-ac1\"><div class=\"tdb-empty\">暂无趋势数据</div></div><div class=\"tdb-tip\" role=\"tooltip\"></div></div>",
				"        <div class=\"tdb-clabel\"><span>每小时总消耗</span><span class=\"tdb-ac2l\"></span></div>",
				"        <div class=\"tdb-chart-wrap\"><div class=\"tdb-ac2\"><div class=\"tdb-empty\">暂无消耗数据</div></div><div class=\"tdb-tip\" role=\"tooltip\"></div></div>",
				"      </div>",
				"    </div>",
				"    <div class=\"tdb-pane tdb-pane-session\" hidden=\"\">",
				"      <div class=\"tdb-selrow\">",
				"        <select class=\"tdb-select\" aria-label=\"选择会话\"></select>",
				"      </div>",
				"      <div class=\"tdb-grid\">",
				"        <div class=\"tdb-cell tdb-c-in\"><b class=\"tdb-v-in\">—</b><span><i class=\"tdb-i\"></i>输入 · uncached</span></div>",
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
				"        <div class=\"tdb-clabel\"><span>每小时总消耗</span><span class=\"tdb-c2-legend\"></span></div>",
				"        <div class=\"tdb-chart-wrap\"><div class=\"tdb-c2\"><div class=\"tdb-empty\">暂无消耗数据</div></div><div class=\"tdb-tip\" role=\"tooltip\"></div></div>",
				"      </div>",
				"    </div>",
				"    <div class=\"tdb-pane tdb-pane-model\" hidden=\"\">",
				"      <div class=\"tdb-selrow\">",
				"        <select class=\"tdb-select tdb-mfilter\" aria-label=\"筛选提供商\"></select>",
				"      </div>",
				"      <div class=\"tdb-mlist\"><div class=\"tdb-empty\">暂无模型数据</div></div>",
				"    </div>",
				"    <div class=\"tdb-pane tdb-pane-deepseek\" hidden=\"\">",
				"      <div class=\"tdb-ds-note\"></div>",
				"      <div class=\"tdb-grid\">",
				"        <div class=\"tdb-cell tdb-c-ctx\"><b class=\"tdb-ds-total\">—</b><span>总余额</span></div>",
				"        <div class=\"tdb-cell tdb-c-cr\"><b class=\"tdb-ds-granted\">—</b><span>赠送余额</span></div>",
				"        <div class=\"tdb-cell tdb-c-in\"><b class=\"tdb-ds-topped\">—</b><span>充值余额</span></div>",
				"      </div>",
				"      <div class=\"tdb-mgrid\">",
				"        <div class=\"tdb-cell tdb-c-cr\"><b class=\"tdb-ds-c-h1\">—</b><span>近1小时余额消耗</span></div>",
				"        <div class=\"tdb-cell tdb-c-in\"><b class=\"tdb-ds-c-d1\">—</b><span>近24小时余额消耗</span></div>",
				"        <div class=\"tdb-cell tdb-c-out\"><b class=\"tdb-ds-c-d7\">—</b><span>近7天余额消耗</span></div>",
				"        <div class=\"tdb-cell tdb-mtot\"><b class=\"tdb-ds-c-all\">—</b><span>自监控以来余额消耗</span></div>",
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
			var selId = readStore("session", "");
			/** 自动跟随最近活动的会话（默认开启）。 */
			var follow = readStore("follow", "1") === "1";
			/** 活动视图："all" = 总消耗（聚合），"session" = 按会话，
			 *  "model" = 按模型消耗，"deepseek" = 官方余额。 */
			var tab = readStore("tab", "session");
			if (tab !== "all" && tab !== "session" && tab !== "model" && tab !== "deepseek") tab = "session";
			var TAB_ORDER = ["all", "session", "model", "deepseek"];
			/** 模型面板的提供商筛选（"" = 全部提供商）。 */
			var mFilter = readStore("mfilter", "");
			var tabBtns = root.querySelectorAll(".tdb-tab");
			var paneAll = root.querySelector(".tdb-pane-all");
			var paneSession = root.querySelector(".tdb-pane-session");
			var paneModel = root.querySelector(".tdb-pane-model");
			var paneDeepseek = root.querySelector(".tdb-pane-deepseek");
			var mlistEl = root.querySelector(".tdb-mlist");
			var mFilterEl = root.querySelector(".tdb-mfilter");
			var dsNote = root.querySelector(".tdb-ds-note");
			var dsMeta = root.querySelector(".tdb-ds-meta");
			var dsEls = {};
			[["total", ".tdb-ds-total"], ["granted", ".tdb-ds-granted"], ["topped", ".tdb-ds-topped"]].forEach(function (p) { dsEls[p[0]] = root.querySelector(p[1]); });
			var dsC = {};
			[["h1", ".tdb-ds-c-h1"], ["d1", ".tdb-ds-c-d1"], ["d7", ".tdb-ds-c-d7"], ["all", ".tdb-ds-c-all"]].forEach(function (p) { dsC[p[0]] = root.querySelector(p[1]); });
			var dsChart = root.querySelector(".tdb-ds-chart");
			var dsChartWrap = dsChart.parentElement;
			var dsTip = dsChartWrap.querySelector(".tdb-tip");
			var dsLeg = root.querySelector(".tdb-ds-leg");
			var aels = {};
			[["in", ".tdb-av-in"], ["out", ".tdb-av-out"], ["cr", ".tdb-av-cr"], ["hit", ".tdb-av-hit"], ["cw", ".tdb-av-cw"], ["ctx", ".tdb-av-ctx"], ["calls", ".tdb-av-calls"]].forEach(function (p) { aels[p[0]] = root.querySelector(p[1]); });
			var ac1 = root.querySelector(".tdb-ac1");
			var ac2 = root.querySelector(".tdb-ac2");
			var ac1Wrap = ac1.parentElement;
			var ac2Wrap = ac2.parentElement;
			var ac1Tip = ac1Wrap.querySelector(".tdb-tip");
			var ac2Tip = ac2Wrap.querySelector(".tdb-tip");
			var ac1leg = root.querySelector(".tdb-ac1l");
			var ac2leg = root.querySelector(".tdb-ac2l");
			/** 总消耗 / 会话两个面板中第一个图表显示的指标。每个面板
			 *  保留各自的选择，与其他视图偏好一样持久化。 */
			var METRICS = ["out", "in", "cr", "total", "calls"];
			var aMetric = readStore("ametric", "out");
			var sMetric = readStore("smetric", "out");
			if (METRICS.indexOf(aMetric) === -1) aMetric = "out";
			if (METRICS.indexOf(sMetric) === -1) sMetric = "out";
			var aPickBtns = root.querySelectorAll(".tdb-apick button");
			var sPickBtns = root.querySelectorAll(".tdb-spick button");

			/** 每个指标的图表配置：如何从一个趋势点取值、
			 *  对应的强调色、单位以及 tooltip 文案。在数据源变化时，
			 *  保持两个面板的第一个图表行为一致。 */
			var METRIC_DEFS = {
				out: { label: "输出", color: "var(--tdb-accent-out)", unit: "tok", pick: function (s) { return s.out; } },
				in: { label: "输入 · uncached", color: "var(--tdb-accent-in)", unit: "tok", pick: function (s) { return s.in; } },
				cr: { label: "缓存读取", color: "var(--tdb-accent-cr)", unit: "tok", pick: function (s) { return s.cr; } },
				total: { label: "总消耗(整体)", color: "var(--tdb-accent-ctx)", unit: "tok", pick: function (s) { return s.in + s.cr + (s.cw || 0) + s.out; } },
				calls: { label: "API 调用次数", color: "var(--tdb-accent-calls)", unit: "次", pick: function (s) { return typeof s.calls === "number" ? s.calls : 0; } },
			};

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

			/** 感知时间范围的横轴标签：1h 用分钟，1d/7d 用小时，30d/全部用天。 */
			var tf = function (ms) { return range === "1h" ? dtMin(ms) : range === "30d" || range === "all" ? dtDay(ms) : dtHour(ms); };
			/** 趋势点单位标签：1h「分」、1d/7d「时」、30d/全部「天」。随 range
			 *  动态计算：因为用户切换范围后 legend 需立即反映新的时间粒度
			 *  （不能只在加载时求值一次，否则 1h → 30d 后单位会卡在「分」）。 */
			var slotUnit = function () { return range === "1h" ? " 分" : range === "30d" || range === "all" ? " 天" : " 时"; };

			/** 渲染总消耗（聚合）面板：累计字段直接求和、
			 *  加权总命中率，不含上下文占用率（这是瞬时性的
			 *  按会话指标，没有有意义的合计值）。 */
			function renderPaneAll() {
				if (!data || !data.totals) {
					for (var k in aels) aels[k].textContent = "—";
					ac1.innerHTML = '<div class="tdb-empty">暂无趋势数据</div>';
					ac2.innerHTML = '<div class="tdb-empty">暂无消耗数据</div>';
					ac1leg.textContent = ac2leg.textContent = "";
					return;
				}
				var t = data.totals;
				var billed = (t.uncached || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);
				var hit = billed > 0 ? ((t.cacheRead || 0) / billed) * 100 : null;
				aels.in.textContent = fmt(t.uncached);
				aels.out.textContent = fmt(t.output);
				aels.cr.textContent = fmt(t.cacheRead);
				if (data.hasCacheWrite === false) {
					aels.cw.textContent = "—";
					aels.cw.parentElement.title = "数据源未上报缓存写入";
				} else {
					aels.cw.textContent = fmt(t.cacheWrite);
					aels.cw.parentElement.title = "";
				}
				aels.hit.textContent = pct(hit, 1);
				aels.ctx.textContent = "—";
				aels.ctx.parentElement.title = "上下文占用是单会话实时状态,不参与总量统计";
				var series = Array.isArray(data.series) ? data.series : [];
				// 时间窗口内的 API 调用次数：assistant/消息事件的精确计数。
				var aCalls = typeof t.calls === "number" ? t.calls : null;
				aels.calls.textContent = aCalls === null ? "—" : String(aCalls);
				aels.calls.parentElement.title = aCalls === null
					? "数据源未上报调用次数"
					: "当前时间范围内所有会话的 API 调用次数(每次模型回复计 1 次)";
				// 总消耗 = API 整体消耗（uncached 输入 + 缓存读取 +
				// 缓存写入 + 输出），未计费环境直接统计整体流量。
				var totalVals = series.map(function (s) { return s.in + s.cr + (s.cw || 0) + s.out; });
				renderMetricChart(ac1, ac1leg, series, aMetric);
				renderChart(ac2, ac2leg, totalVals, {
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
			}

			/** 渲染某个会话的会话面板。 */
			function renderPaneSession(session) {
				if (!data || !data.totals || !session) {
					dot.className = "tdb-dot idle";
					for (var k in els) els[k].textContent = "—";
					c1.innerHTML = '<div class="tdb-empty">暂无趋势数据</div>';
					c2.innerHTML = '<div class="tdb-empty">暂无消耗数据</div>';
					c1leg.textContent = c2leg.textContent = "";
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
			}

			/** 渲染模型面板：按提供商分组，每组一个标题 + 组内汇总，
			 *  组内每模型一张卡片，展示窗口内 token 明细、占总体消耗的
			 *  比例以及缓存命中率。顶部的下拉可按提供商筛选。 */
			function renderPaneModel() {
				var models = data && Array.isArray(data.models) ? data.models : [];
				// 重建筛选下拉的选项（保留当前选择；新的提供商出现时自动补充）。
				var filter = mFilter;
				var provs = [];
				for (var fi = 0; fi < models.length; fi++) {
					var fp = (typeof models[fi].provider === "string" && models[fi].provider !== "" && models[fi].provider !== "未知")
						? models[fi].provider
						: "未知提供商";
					if (provs.indexOf(fp) === -1) provs.push(fp);
				}
				var opts = '<option value="">全部提供商</option>';
				for (var pi = 0; pi < provs.length; pi++) {
					opts += '<option value="' + esc(provs[pi]) + '"' + (filter === provs[pi] ? ' selected' : '') + '>' + esc(provs[pi]) + '</option>';
				}
				mFilterEl.innerHTML = opts;
				if (filter !== "" && provs.indexOf(filter) === -1) filter = "";
				mFilter = filter;
				if (models.length === 0) {
					mlistEl.innerHTML = '<div class="tdb-empty">暂无模型数据</div>';
					return;
				}
				// 按提供商分组，保持首次出现顺序；组内保持原顺序（按占比降序）。
				var groups = [];
				var gIndex = {};
				for (var i = 0; i < models.length; i++) {
					var m = models[i];
					var p = (typeof m.provider === "string" && m.provider !== "" && m.provider !== "未知")
						? m.provider
						: "未知提供商";
					if (filter !== "" && p !== filter) continue; // 筛选：只保留选中的提供商
					var gi = gIndex[p];
					if (gi === undefined) {
						gi = groups.length;
						gIndex[p] = gi;
						groups.push({ provider: p, models: [] });
					}
					groups[gi].models.push(m);
				}
				var out = [];
				for (var g = 0; g < groups.length; g++) {
					var grp = groups[g];
					var gTotal = 0;
					var gShare = 0;
					for (var j = 0; j < grp.models.length; j++) {
						var gj = grp.models[j].totals || {};
						gTotal += overall(gj);
						gShare += typeof grp.models[j].sharePct === "number" ? grp.models[j].sharePct : 0;
					}
					out.push(
						'<div class="tdb-mgroup">' +
						'<span class="tdb-mg-name" title="提供商">' + esc(grp.provider) + '</span>' +
						'<span class="tdb-mg-total">' + grp.models.length + ' 个模型 · ' + fmt(gTotal) + ' tok</span>' +
						'<span class="tdb-mg-pct">' + gShare.toFixed(1) + '%</span>' +
						'</div>'
					);
					for (var k = 0; k < grp.models.length; k++) {
						var mm = grp.models[k];
						var t = mm.totals || {};
						var total = overall(t);
						var share = typeof mm.sharePct === "number" ? mm.sharePct : 0;
						var hit = typeof mm.hitPct === "number" ? mm.hitPct : 0;
						var hitTxt = hit > 0 ? "命中 " + hit.toFixed(1) + "%" : "命中率 —";
						var mCalls = typeof t.calls === "number" ? t.calls : null;
						out.push(
							'<div class="tdb-mcard">' +
							'<div class="tdb-mtop"><b class="tdb-mname" title="提供商: ' + esc(mm.provider || "未知") + '">' + esc(mm.model || "未知") + '</b>' +
							'<span class="tdb-mprov">' + esc(grp.provider) + '</span><span class="tdb-mpct">' + share.toFixed(1) + '%</span></div>' +
							'<div class="tdb-mgrid">' +
							'<div class="tdb-cell tdb-c-in"><b>' + fmt(t.uncached) + '</b><span><i class="tdb-i"></i>输入 · uncached</span></div>' +
							'<div class="tdb-cell tdb-c-cr"><b>' + fmt(t.cacheRead) + '</b><span><i class="tdb-i"></i>缓存读取</span></div>' +
							'<div class="tdb-cell tdb-c-out"><b>' + fmt(t.output) + '</b><span><i class="tdb-i"></i>输出</span></div>' +
							'<div class="tdb-cell tdb-c-calls" title="' + (mCalls === null ? '数据源未上报调用次数' : '当前时间范围内该模型的 API 调用次数') + '"><b>' + (mCalls === null ? "—" : String(mCalls)) + '</b><span><i class="tdb-i"></i>API 调用次数</span></div>' +
							'<div class="tdb-cell tdb-mtot"><b>' + fmt(total) + '</b><span>总消耗(整体) · ' + hitTxt + '</span></div>' +
							'</div>' +
							'<div class="tdb-mbar"><i style="width:' + Math.min(100, Math.max(0.5, share)) + '%"></i></div>' +
							'</div>'
						);
					}
				}
				mlistEl.innerHTML = out.join("");
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
				// 各时间窗内的余额降幅（¥，负值表示余额增加，
				// 例如窗口中途有充值/赠送到账）。
				var c = b && b.consumed ? b.consumed : null;
				var cKeys = [["h1", "近1小时"], ["d1", "近24小时"], ["d7", "近7天"], ["all", "自监控以来"]];
				for (var ci = 0; ci < cKeys.length; ci++) {
					var ck = cKeys[ci][0];
					var cv = c && typeof c[ck] === "number" ? c[ck] : null;
					var el = dsC[ck];
					if (cv === null) {
						el.textContent = "—";
						el.parentElement.title = "采样数据不足";
					} else {
						var neg = cv < 0;
						el.textContent = (neg ? "↑" : "−") + "¥" + Math.abs(cv).toFixed(2);
						el.parentElement.title = cKeys[ci][1] + "余额变化" + (neg ? "（期间余额增加，可能充值/赠送到账）" : "（近似消耗，可能含其他渠道消费，以官方账单为准）");
					}
				}
				if (!b) {
					dsNote.textContent = "余额信息暂不可用";
					dsNote.className = "tdb-ds-note";
				} else if (!b.configured) {
					dsNote.textContent = "未配置 DeepSeek API Key：在插件配置中设置 deepseekApiKey，或设置环境变量 DEEPSEEK_API_KEY（密钥只存在服务端，不会下发到页面）。";
					dsNote.className = "tdb-ds-note err";
				} else if (!b.ok) {
					dsNote.textContent = "获取余额失败：" + (b.error || "未知错误") + "（稍后自动重试，已有历史样本保留）";
					dsNote.className = "tdb-ds-note err";
				} else {
					var avail = b.is_available === false ? "账户不可用（is_available=false）" : "账户正常";
					var cur = b.infos.length > 0 ? b.infos.map(function (i) { return String(i.currency || "?"); }).join("/") : "—";
					dsNote.textContent = "已连接 DeepSeek 官方 API · 币种 " + cur + " · " + avail + " · 消耗为余额差额的近似值，以官方账单为准";
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

			/** 根据 `data` 重新渲染所有内容。 */
			function render() {
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
				for (var api = 0; api < aPickBtns.length; api++) {
					aPickBtns[api].classList.toggle("active", aPickBtns[api].getAttribute("data-metric") === aMetric);
				}
				for (var spi = 0; spi < sPickBtns.length; spi++) {
					sPickBtns[spi].classList.toggle("active", sPickBtns[spi].getAttribute("data-metric") === sMetric);
				}
				paneAll.hidden = tab !== "all";
				paneSession.hidden = tab !== "session";
				paneModel.hidden = tab !== "model";
				paneDeepseek.hidden = tab !== "deepseek";

				var session = selectedSession(); // 会话面板当前的会话（或 null）
				renderPaneAll();
				renderPaneSession(session);
				renderPaneModel();
				renderPaneDeepseek();

				// 头部摘要跟随当前活动的标签页。
				var totals, hit, occupancy;
				if (tab === "all" && data && data.totals) {
					totals = data.totals;
					var ab = (totals.uncached || 0) + (totals.cacheRead || 0) + (totals.cacheWrite || 0);
					hit = ab > 0 ? ((totals.cacheRead || 0) / ab) * 100 : null;
					occupancy = null;
					summary.innerHTML = renderSummaryChips(totals, hit, occupancy);
					fUpdated.textContent = "全部会话 · " + fmt(totals.output || 0) + " tok";
					fUpdated.title = "";
				} else if (tab === "model") {
					// 模型标签页头部：最顶层模型 + 其消耗；页脚 = 模型数量。
					var mods = data && Array.isArray(data.models) ? data.models : [];
					if (mods.length > 0) {
						var mTop = mods[0];
						var mT = mTop.totals || {};
						summary.innerHTML = '<span class="tdb-s-chip"><b>' + esc(fmt(overall(mT))) + '</b> ' + esc(mTop.model || "未知") + '</span>';
						var mTotal = 0;
						for (var mi = 0; mi < mods.length; mi++) {
							var mt = mods[mi].totals || {};
							mTotal += overall(mt);
						}
						fUpdated.textContent = mods.length + " 个模型 · " + fmt(mTotal) + " tok";
						fUpdated.title = "范围: " + (range === "all" ? "全部" : range === "30d" ? "1月" : range === "7d" ? "1周" : range === "1d" ? "1天" : "1小时");
					} else {
						summary.innerHTML = '<span class="tdb-s-chip"><b>—</b> 模型</span>';
						fUpdated.textContent = "无模型数据";
						fUpdated.title = "";
					}
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
			// all/总消耗：全部会话聚合；session/会话：当前选中会话；
			// model/模型：占比最高的模型；deepseek/DeepSeek：官方余额。
			miniEl.classList.toggle("err", !!error);
			var rangeLabel = range === "all" ? "全部" : range === "30d" ? "1月" : range === "7d" ? "1周" : range === "1d" ? "1天" : "1小时";
			var mB = {};
			[["total", ".tdb-mv-total"], ["in", ".tdb-mv-in"], ["out", ".tdb-mv-out"], ["cr", ".tdb-mv-cr"], ["hit", ".tdb-mv-hit"], ["calls", ".tdb-mv-calls"]].forEach(function (p) { mB[p[0]] = miniEl.querySelector(p[1]); });
			var mLabelEls = {};
			[["total", ".tdb-mc-total"], ["in", ".tdb-mc-in"], ["out", ".tdb-mc-out"], ["cr", ".tdb-mc-cr"], ["hit", ".tdb-mc-hit"], ["calls", ".tdb-mc-calls"]].forEach(function (p) { mLabelEls[p[0]] = miniEl.querySelector(p[1] + " .tdb-ml"); });
			// 胶囊标签：deepseek 余额模式下切换为余额相关标签，其余标签页恢复 token 标签。
			var mTokenLabels = { total: "总计", in: "输入", out: "输出", cr: "缓存", hit: "命中", calls: "调用" };
			var mBalanceLabels = { total: "余额", in: "赠送", out: "充值", cr: "1h耗", hit: "24h耗", calls: "累计耗" };
			var mLabelSet = tab === "deepseek" ? mBalanceLabels : mTokenLabels;
			for (var mlk in mLabelSet) if (mLabelEls[mlk]) mLabelEls[mlk].textContent = mLabelSet[mlk];
			mB.total.classList.remove("tdb-mv-balance");

			if (tab === "all") {
				miniEl.title = error ? String(error) : "全部会话汇总（" + rangeLabel + "）· 点击展开";
				var aTot = data && data.totals ? data.totals : null;
				if (aTot) {
					var ab = (aTot.uncached || 0) + (aTot.cacheRead || 0) + (aTot.cacheWrite || 0);
					var ahit = ab > 0 ? ((aTot.cacheRead || 0) / ab) * 100 : null;
					mB.total.textContent = fmt(overall(aTot));
					mB.total.parentElement.title = "总消耗(整体)";
					mB.in.textContent = fmt(aTot.uncached);
					mB.in.parentElement.title = "输入 · uncached";
					mB.out.textContent = fmt(aTot.output);
					mB.out.parentElement.title = "输出";
					mB.cr.textContent = fmt(aTot.cacheRead);
					mB.cr.parentElement.title = "缓存读取";
					mB.hit.textContent = ahit === null ? "—" : ahit.toFixed(0) + "%";
					mB.hit.parentElement.title = ahit === null ? "总命中率" : "总命中率 " + ahit.toFixed(1) + "%";
					var aCalls = typeof aTot.calls === "number" ? aTot.calls : null;
					mB.calls.textContent = aCalls === null ? "—" : String(aCalls);
					mB.calls.parentElement.title = aCalls === null ? "数据源未上报调用次数" : "API 调用次数(每次模型回复计 1 次)";
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
					mB.in.parentElement.title = "输入 · uncached";
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
			} else if (tab === "model") {
				miniEl.title = error ? String(error) : "主力模型（" + rangeLabel + "）· 点击展开";
				var mods = data && Array.isArray(data.models) ? data.models : [];
				if (mods.length > 0 && mods[0].totals) {
					var mT = mods[0].totals;
					var mb = (mT.uncached || 0) + (mT.cacheRead || 0) + (mT.cacheWrite || 0);
					var mhit = mb > 0 ? ((mT.cacheRead || 0) / mb) * 100 : null;
					mB.total.textContent = fmt(overall(mT));
					mB.total.parentElement.title = "总消耗(整体)";
					mB.in.textContent = fmt(mT.uncached);
					mB.in.parentElement.title = "输入 · uncached";
					mB.out.textContent = fmt(mT.output);
					mB.out.parentElement.title = "输出";
					mB.cr.textContent = fmt(mT.cacheRead);
					mB.cr.parentElement.title = "缓存读取";
					mB.hit.textContent = mhit === null ? "—" : mhit.toFixed(0) + "%";
					mB.hit.parentElement.title = mhit === null ? "总命中率" : "总命中率 " + mhit.toFixed(1) + "%";
					var mCalls = typeof mT.calls === "number" ? mT.calls : null;
					mB.calls.textContent = mCalls === null ? "—" : String(mCalls);
					mB.calls.parentElement.title = mCalls === null ? "数据源未上报调用次数" : "API 调用次数(每次模型回复计 1 次)";
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
					return (cv < 0 ? "↑" : "−") + "¥" + Math.abs(cv).toFixed(2);
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
				mB.hit.textContent = fmtC(dC ? dC.d1 : null);
				mB.hit.parentElement.title = "近24小时余额消耗";
				mB.calls.textContent = fmtC(dC ? dC.all : null);
				mB.calls.parentElement.title = "自监控以来余额消耗";
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

			// 图表指标选择器：按面板切换第一个图表的数据源。
			// payload 已携带每个趋势点的所有指标，因此切换
			// 只是纯粹的重新渲染，无需重新请求。
			for (var ab = 0; ab < aPickBtns.length; ab++) {
				aPickBtns[ab].addEventListener("click", function () {
					var m = this.getAttribute("data-metric");
					if (m === aMetric) return;
					aMetric = m;
					writeStore("ametric", aMetric);
					render();
				});
			}
			for (var sb = 0; sb < sPickBtns.length; sb++) {
				sPickBtns[sb].addEventListener("click", function () {
					var m = this.getAttribute("data-metric");
					if (m === sMetric) return;
					sMetric = m;
					writeStore("smetric", sMetric);
					render();
				});
			}

			// 键盘快捷键：[ 折叠，] 展开，r 刷新，t 循环标签页（总消耗→会话→模型→DeepSeek），0 总消耗标签，f 跟随活动会话，1..9 选择会话。
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
					// 切换到总消耗（聚合）标签页。
					tab = "all";
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
			timer = setInterval(refresh, refreshMs);

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
