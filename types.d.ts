/** Server half configuration (all keys optional). */
export interface Config {
  /** Route serving the JSON payload (default "/token-dashboard/api"). */
  apiPath?: string;
  /** Max live per-step trend samples kept per session (default 600). */
  seriesSize?: number;
  /** Override the durable session root scanned for history (default $DSH_HOME/sessions). */
  scanRoot?: string;
  /** Run the historical replay when the plugin loads (default true). */
  backfillOnStart?: boolean;
  /** DeepSeek official API key for the balance tab (also read from env
   *  `DEEPSEEK_API_KEY`). The key stays server-side and never reaches the page. */
  deepseekApiKey?: string;
  /** How often to refresh the official balance (ms, default 30 min). */
  balanceRefreshMs?: number;
  /** Override where the balance history is persisted (default
   *  `$DSH_HOME/dsh-token-dashboard-balance.json`). */
  balanceFile?: string;
}

/**
 * Aggregate token buckets within a time window (per session or across all).
 * Mirrors the tokenUsage projection fields per `assistant/message`.
 */
export interface TokenDashboardTotals {
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** One per-hour usage sample (deltas aggregated over one hour of steps). */
export interface TokenDashboardHourSample {
  t: number;
  in: number;
  cr: number;
  cw: number;
  out: number;
  /** Number of API calls in this hour. */
  calls: number;
  /** cache-read share of that hour's billed input, 0..1 (global series only). */
  hitPct?: number;
}

/** Per-session dashboard state served to the browser widget (within the range). */
export interface TokenDashboardSession {
  id: string;
  totals: TokenDashboardTotals;
  /** Derived label: first real user message text, truncated; null when absent. */
  title: string | null;
  /** Agent preset id from the session header (`standard`/`code`/…), if any. */
  preset: string | null;
  /** Session creation time from the header, ms epoch; null when unknown. */
  createdAt: number | null;
  stats: { turns: number; steps: number } | null;
  context: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number } | null;
  series: TokenDashboardHourSample[];
  updatedAt: number | null;
}

/** One model's consumption within a time window (provider/model pair). Exact
 *  token counts only — monetary estimates were removed because prices change,
 *  cannot be queried, and stale prices would produce misleading amounts. */
export interface TokenDashboardModel {
  provider: string;
  model: string;
  totals: TokenDashboardTotals;
  /** Cache-hit rate for this model, percentage 0-100; 0 when no billed input. */
  hitPct: number;
  /** Share of the window's total burn (uncached input + output), percentage 0-100. */
  sharePct: number;
}

/** One currency entry of the official DeepSeek balance. */
export interface TokenDashboardBalanceInfo {
  currency: string;
  total: number;
  granted: number;
  topped: number;
}

/** One balance sample recorded from a successful fetch (chronological). */
export interface TokenDashboardBalanceSample {
  t: number;
  total: number;
  granted: number;
  topped: number;
}

/** Official DeepSeek account balance (from GET /user/balance; key never sent). */
export interface TokenDashboardBalance {
  configured: boolean;
  ok: boolean;
  error: string | null;
  fetchedAt: number | null;
  is_available: boolean | null;
  infos: TokenDashboardBalanceInfo[];
  /** Chronological recent samples (newest last). Persisted to disk on every
   *  successful fetch and reloaded on boot, so windows survive restarts. */
  history: TokenDashboardBalanceSample[];
  /** Balance drop over 1h / 24h / 7d / all (recent minus oldest in window);
   *  negative means the balance rose (recharge/grant mid-window). */
  consumed: { h1: number | null; d1: number | null; d7: number | null; all: number | null };
}

/** Payload of GET <apiPath>[?range=all|1h|1d|7d|30d]. */
export interface TokenDashboardPayload {
  ok: true;
  now: number;
  /** Echoed query range; "all" when absent. */
  range: string;
  /** Most recently active session id (latest event across ALL sessions); null when none. */
  activeId: string | null;
  config: { apiPath: string; seriesSize: number };
  count: number;
  backfilled: boolean;
  backfillError: string | null;
  /** Combined totals across every session within the window. */
  totals: TokenDashboardTotals;
  /** Combined per-hour trend within the window; per-minute (60-61 points) with range=1h. */
  series: TokenDashboardHourSample[];
  /** Per-model consumption within the window, sorted by burn desc. */
  models: TokenDashboardModel[];
  /** Official DeepSeek account balance + consumption-by-balance-drop. */
  balance: TokenDashboardBalance;
  sessions: TokenDashboardSession[];
}

export const name: string;
export function apply(ctx: unknown, config?: Config): void;