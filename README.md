# dsh-token-dashboard

A dual-face DSH plugin that adds a **collapsible, draggable mini-window** to the
web GUI showing live token consumption, cache hit rate, context occupancy, and
per-step usage trends — both for the active session **and** for every other
session already on disk.

- **Server half** (`index.js`) listens on the committed session event stream
  and folds it into per-session token totals + a per-hour trend series. On
  startup (and every 5 minutes after) it asynchronously replays every durable
  `.jsonl.zstd` session log under `$DSH_HOME/sessions`, so a fresh dsh web boot
  shows historical usage for sessions that already exist on disk — not just
  ones created live after the plugin loaded.
- **Browser half** (`client.js`) is a fully self-contained bundle (no React, no
  slots, no theme kit — just `fetch` + DOM + SVG). It renders a fixed-position
  widget that can be collapsed to a one-line summary, dragged around the page,
  and expanded to show totals, charts, a time-window filter, and a session
  picker.

## Install

The package must be resolvable from the web profile's `node_modules`. From the
repo root of this workspace:

```sh
node _plugins/dsh-token-dashboard/install.mjs
```

The installer copies the package into `$DSH_HOME/profiles/web/node_modules/`,
registers it in the profile `package.json` dependencies, and **upserts**
(idempotent) the loader row in `cordis.patch.yml`. Re-run any time you edit
sources to redeploy. Then **restart dsh web** (plugin-set changes take effect
on restart):

```
# in the start-web console window:
restart
```

> The installer overwrites the deployed copy in one direction. **Edit the plugin
> in this source tree, never directly inside the profile** — the source tree is
> the single source of truth and is version-controlled, so recovery is a git
> checkout.

If you prefer to wire it manually, add to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: token-dashboard
      name: 'dsh-token-dashboard'
      config:
        apiPath: /token-dashboard/api
        seriesSize: 600
```

## Config

| key                 | default                                            | meaning                                              |
| ------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `apiPath`           | `/token-dashboard/api`                             | JSON route (browser fetches this)              |
| `seriesSize`        | `600`                                              | max trend samples kept per session (across both live events and backfilled history) |
| `scanRoot`          | `$DSH_HOME/sessions`                               | override the durable session root to scan for history |
| `backfillOnStart`   | `true`                                             | run the historical replay once when the plugin loads |
| `deepseekApiKey`    | `env DEEPSEEK_API_KEY`                             | DeepSeek official API key for the DeepSeek tab (recommended via env; the key never leaves the server) |
| `balanceRefreshMs`  | `1800000` (30 min)                                 | how often to re-fetch the official balance        |
| `balanceFile`       | `$DSH_HOME/dsh-token-dashboard-balance.json`       | where the balance history is persisted (survives restarts) |
| `refreshMs` (client)| `2500`                                             | browser poll interval in ms                       |

## Backfill — how historical data is reconstructed

When the plugin loads, `setImmediate` schedules a single-pass scan of every
`<scanRoot>/<encoded-cwd>/session-*/session.jsonl.zstd`:

1. The file's zstd frames are located by reading headers + block lengths (no
   decoding), so the scan is fast even on hundreds of sessions.
2. Each complete frame is decompressed (`node:zlib` — Node 22 ships Zstandard)
   and its events fed through the same `foldEvent` the live subscription uses.
   This re-derives both the cumulative totals and the per-step series.
3. State already in memory is skipped on subsequent backfill ticks — the
   periodic refresh (every 5 min) only re-folds sessions whose `.jsonl.zstd`
   mtime advanced since we last read them. That way in-flight live samples
   can't be clobbered while dsh is running.
4. The very first payload the browser receives has `backfilled: false` and
   `backfillError: null`; within ~1 second the next poll flips
   `backfilled: true` and the widget shows a small "已回填" badge in the footer.

A typical replay of a 150 KB session log takes ~15 ms; a 2 MB log takes
~50–250 ms. All sessions under `$DSH_HOME/sessions` are scanned, so boot
overhead is bounded by the number of historical sessions, not the wall clock.

### What is reconstructed vs. approximated

| field            | backfill source                      | accuracy                     |
| ---------------- | ------------------------------------ | ---------------------------- |
| `totals`         | every `assistant/message` usage      | exact                        |
| `series[]`       | per (turn, step) flushes             | exact (same algorithm as live) |
| `stats.turns`    | count of `turn/end`                  | exact                        |
| `stats.steps`    | count of `step/end`                  | exact                        |
| `context.contextWindow` | `request/context.contextWindow` | exact                        |
| `context.pressureTokens` | last `assistant/message` usage | exact (latest sample only) |
| `context.projectedTokens` | set to `pressureTokens` (no surface fold) | approximated |

The approximation on `projectedTokens` is documented because the host
projection sets `projectedTokens = pressureTokens + surfaceTokens -
sampledSurfaceTokens`, and backfill has no surface fold to replay. Since
the live subscription will update this field as soon as the next
`assistant/message` arrives, the approximation is only visible on the very
first poll after plugin boot.

## Views: 总消耗 tab vs 会话 tab vs 模型 tab vs DeepSeek tab

The widget has four tabbed views (key `T` cycles 总消耗 → 会话 → 模型 → DeepSeek,
`0` jumps to 总消耗):

- **总消耗 (aggregate)** — one grid + charts for **all sessions combined** within
  the selected time window:
  - 输入 / 输出 / 缓存读取 / 缓存写入 are cumulative token counts, so they are
    summed directly.
  - **总命中率** is *not* an average of per-session hit rates; it is recomputed
    from the sums: `总缓存读取 ÷ (总输入 + 总缓存读取 + 总缓存写入)`.
  - **上下文占用** is an instantaneous per-session metric (current context
    window fill) and has no meaningful total — the cell shows `—`.
  - Both charge show hourly trends: 每小时输出 and 每小时总消耗 (uncached input +
    output only — the actual API burn; cache read/write are discounted so they
    are excluded).
- **会话 (session)** — one grid + charts for a single session: follow mode
  (`⚡ 跟随进行中的会话`, key `F`) auto-switches to the session that most
  recently produced events (`payload.activeId`, i.e. the one you are actively
  chatting with in DSH), or a specific session picked from the dropdown. This
  view shows the session's own hit rate, context occupancy, and the same two
  hourly charts.
- **模型 (model)** — one card per provider/model pair showing **which model
  consumed how many tokens**: 输入 (uncached) / 缓存读取 / 输出, a 总消耗
  (uncached input + output) cell with the model's cache-hit rate, and a share
  bar of the window's total burn. Cards are sorted by 总消耗 descending. The
  provider/model pair is read from each `assistant/message`'s
  `data.message.source` (falling back to 未知|未知 when absent), so mixed-model
  conversations attribute every token to the model that actually generated it.
  For routing providers that report a served model (Auto/routing providers such
  as 火山方舟 ark), the model shown is the **server-routed model** from
  `source.replayState.response.responseModel` (e.g. `kimi-k3`) rather than the
  requested config name — the fallback is `source.model` when no routed name
  was reported.
  This tab shows **exact token counts only** — no money estimates. Model prices
  change over time and (for opencode-go and the others) cannot be queried via an
  API, so any "cost" derived from a stale price snapshot would just be misleading
  guesswork. Real money figures belong in the providers' own consoles (or in the
  DeepSeek tab below, which reflects the *official* balance).
- **DeepSeek (官方余额)** — shows the official DeepSeek account balance fetched
  from `GET https://api.deepseek.com/user/balance` ([docs](https://api-docs.deepseek.com/api/get-user-balance/)):
  总余额 / 赠送余额 / 充值余额 per currency, plus account availability, a
  **balance-over-time curve**, and the **balance drop** over 近1小时 / 近24小时 /
  近7天 / 自监控以来. The server polls the endpoint once at startup and then every
  `balanceRefreshMs` (default 30 min), appending each successful value to a
  rolling history **persisted to disk** (`balanceFile`, default
  `$DSH_HOME/dsh-token-dashboard-balance.json`) and reloaded on boot — so the
  windows and curve keep their history across restarts instead of resetting.
  The drop = latest balance − oldest balance inside that
  window — the only real money signal available (token logs carry amounts, but
  prices vary freely, so amounts are more honest than multiplying by a guessed
  price). A negative drop means the balance *rose* mid-window (a recharge/grant
  landed). The drop is an approximation of what this key consumed and can include
  spend outside DSH — always cross-check the official billing console. A key is
  required: set `deepseekApiKey` in the plugin config or the `DEEPSEEK_API_KEY`
  environment variable. **The key stays on the server — it is never included in
  the JSON payload.** Without a key the tab shows a setup hint; on HTTP/network
  errors it shows the failure and retries automatically.

A segmented control above the panes narrows the time window for **all** tabs:

| label | `?range=` | window | granularity |
| ----- | --------- | ------ | ----------- |
| 全部 | `all`     | everything on disk | hourly |
| 1月   | `30d`     | trailing 30 days   | hourly |
| 1周   | `7d`      | trailing 7 days    | hourly |
| 1天   | `1d`      | trailing 24 hours  | hourly |
| 1小时 | `1h`      | trailing 1 hour    | **per-minute** |

The **1小时** range is special: it renders the trend charts at **per-minute**
granularity (a continuous 60-minute axis, zero-filled), so you can watch the
last chunk of activity minute by minute. The widget polls every ~2.5 s, so a
new minute point appears on the chart roughly once a minute while the panel is
open. Per-minute buckets are kept as a rolling ~25h in-memory buffer; every
other range keeps using the hourly buckets.

Switching the range re-fetches from the server (`GET /token-dashboard/api?range=…`)
and re-aggregates every session's buckets, so totals, charts, and the
collapsed-summary chips all reflect the selected window. The session picker
lives inside the 会话 tab and offers follow-mode plus one entry per contributing
session (label = derived title / cwd / id).

The selected range/view are remembered in `localStorage`
(`dsh-token-dashboard:range`, `…:tab`, `…:follow`, `…:session`).

The widget is ~440px wide (3-column totals grid). The connection/backfill status
badge (`连接中…` / `回填中…` / `已回填` / red `连接失败`) sits in the panel header
next to the title, so it is visible even when the panel is collapsed; the footer
keeps just the last-update time.

## API

- `GET /token-dashboard/api[?range=all|1h|1d|7d|30d]` → `{ ok, now, range, activeId, config, count, backfilled, backfillError, totals, series, models[], balance, sessions[] }`
  - `activeId` — id of the most recently active session (latest event across
    ALL sessions, not just the window) — the browser's follow-mode target
  - `totals` — combined `{ uncached, cacheRead, cacheWrite, output }` across all
    sessions within the window
  - `series[]` — combined per-hour `{ t, in, cr, cw, out, hitPct }` within the
    window; when `range=1h` this is the per-minute series (60–61 points, 1-min
    step) computed from the rolling minute buckets
  - `models[]` — per-model `{ provider, model, totals, hitPct, sharePct }`
    within the window:
    - `totals` — `{ uncached, cacheRead, cacheWrite, output }` summed across
      every session for that provider/model pair
    - `hitPct` — the model's own cache-hit rate, percentage 0-100, recomputed
      from its sums (`cacheRead ÷ (uncached + cacheRead + cacheWrite)`)
    - `sharePct` — share of the window's total burn (uncached input + output),
      percentage 0-100; entries sorted by burn descending
    - (no `price`/`cost` fields — monetary estimates were removed)
  - `balance` — official DeepSeek balance
    `{ configured, ok, error, fetchedAt, is_available, infos: [{ currency, total, granted, topped }], history: [{ t, total, granted, topped }], consumed: { h1, d1, d7, all } }`;
    `configured: false` until a key is set, `ok: false` while a fetch fails/never
    ran; `history` is the chronological balance samples (newest last) that drive
    the curve and the `consumed` balance-drop windows (¥, negative if it rose).
    The API key itself is never present in the payload.
  - `sessions[].totals` — in-window `{ uncached, cacheRead, cacheWrite, output }`
  - `sessions[].title` — derived label: the first **real user message** text
    (plugin-injected context is ignored), truncated to 60 chars; `null` if the
    session has none. DSH stores no user-facing title, so the picker falls back
    to the cwd basename, then to a sequential number, always suffixed with the
    short id + optional preset tag (e.g. `修复插件样式 ·a1b2c3 [standard]`).
  - `sessions[].preset` — agent preset id from the session header, if any
  - `sessions[].createdAt` — session creation time from the header, ms epoch
  - `sessions[].series[]` — in-window per-hour `{ t, in, cr, cw, out }`
  - `sessions[].stats` — `{ turns, steps }` (host-side `sessionStats` has more fields on
    the live wire, but backfill only recovers counts)
  - `sessions[].context` — `{ contextWindow, pressureTokens, projectedTokens }`

The widget's header has a **刷新** button (keyboard `R`) that fetches the
current range immediately instead of waiting for the next poll; the icon spins
briefly as feedback. There is deliberately **no "clear/reset"** — the
plugin aggregates real session logs on disk, so wiping in-memory state would
just be re-populated by the next backfill tick, which would only make the
numbers vanish for a moment.

## Notes & limitations

- The payload trend series is **per-hour** (each point aggregates one hour of
  step samples), which keeps a 30-day window readable and lets the API slice any
  time range cheaply. Live per-step granularity is still folded internally for
  deduplication; the hour buckets are what the widget renders and the API serves.
- Backfill does not replay the full surface projection. The `projectedTokens`
  field therefore equals `pressureTokens` until live events catch up.
- The very last (torn) zstd frame of a still-open session is skipped — the
  session-writer will retry it on the next append. If dsh restarts in the
  middle of a long conversation, the last few seconds of that conversation's
  live samples will be picked up via the `session/event` subscription on top
  of the backfilled baseline.
- The widget is same-origin only (no CORS), safe over the LAN proxy.