/** 服务端配置（所有键均为可选）。 */
export interface Config {
  /** 提供 JSON 数据的路由（默认 "/token-dashboard/api"）。 */
  apiPath?: string;
  /** 每个会话保留的实时分步趋势样本上限（默认 600）。 */
  seriesSize?: number;
  /** 覆盖扫描历史记录的持久化会话根目录（默认 $DSH_HOME/sessions）。 */
  scanRoot?: string;
  /** 插件加载时执行历史回填（默认 true）。 */
  backfillOnStart?: boolean;
  /** 余额 tab 所需的 DeepSeek 官方 API 密钥（也可从环境变量
   *  `DEEPSEEK_API_KEY` 读取）。密钥只留在服务端，绝不会传到页面。 */
  deepseekApiKey?: string;
  /** 官方余额的刷新间隔（毫秒，默认 30 分钟）。 */
  balanceRefreshMs?: number;
  /** 覆盖余额历史的持久化位置（默认
   *  `$DSH_HOME/dsh-token-dashboard-balance.json`）。 */
  balanceFile?: string;
}

/**
 * 某个时间窗口内的 token 汇总桶（可以是单会话的，也可以是全部会话合计）。
 * 字段与每条 `assistant/message` 的 tokenUsage 投影保持一致。
 */
export interface TokenDashboardTotals {
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** 窗口内的 API 调用次数（每条模型回复计 1 次）。 */
  calls: number;
}

/** 一个按小时的用量样本（把一小时内各步的增量聚合在一起）。 */
export interface TokenDashboardHourSample {
  t: number;
  in: number;
  cr: number;
  cw: number;
  out: number;
  /** 该小时内的 API 调用次数。 */
  calls: number;
  /** 该小时计费输入中缓存读取的占比，0..1（仅全局序列有此字段）。 */
  hitPct?: number;
}

/** 提供给浏览器小窗的单会话面板状态（限定在所选时间范围内）。 */
export interface TokenDashboardSession {
  id: string;
  totals: TokenDashboardTotals;
  /** 推导出的标签：第一条真实用户消息的文本，会被截断；没有则为 null。 */
  title: string | null;
  /** 会话头中的 agent 预设 id（`standard`/`code`/…），若有。 */
  preset: string | null;
  /** 会话头中的创建时间，毫秒时间戳；未知时为 null。 */
  createdAt: number | null;
  stats: { turns: number; steps: number } | null;
  context: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number } | null;
  series: TokenDashboardHourSample[];
  updatedAt: number | null;
}

/** 某个时间窗口内单个模型（提供商/模型组合）的消耗。只提供精确的 token
 *  计数 —— 金额估算已被移除，因为价格会变化、无法查询，用过期价格算出的
 *  金额只会产生误导。 */
export interface TokenDashboardModel {
  provider: string;
  model: string;
  totals: TokenDashboardTotals;
  /** 该模型的缓存命中率，百分比 0-100；无计费输入时为 0。 */
  hitPct: number;
  /** 占窗口总消耗（uncached 输入 + 输出）的比例，百分比 0-100。 */
  sharePct: number;
}

/** DeepSeek 官方余额中的一个币种条目。 */
export interface TokenDashboardBalanceInfo {
  currency: string;
  total: number;
  granted: number;
  topped: number;
}

/** 一次成功拉取所记录的余额样本（按时间顺序）。 */
export interface TokenDashboardBalanceSample {
  t: number;
  total: number;
  granted: number;
  topped: number;
}

/** DeepSeek 官方账户余额（来自 GET /user/balance；密钥绝不外发）。 */
export interface TokenDashboardBalance {
  configured: boolean;
  ok: boolean;
  error: string | null;
  fetchedAt: number | null;
  is_available: boolean | null;
  infos: TokenDashboardBalanceInfo[];
  /** 按时间顺序排列的近期样本（最新在最后）。每次成功拉取都会持久化到磁盘
   *  并在启动时重新载入，因此各时间窗口能跨重启保留。 */
  history: TokenDashboardBalanceSample[];
  /** 近 1 小时 / 24 小时 / 7 天 / 全部窗口内的余额下降量累计：相邻采样对之间余额下降
   *  记为消耗、余额上升（充值/赠送到账）记 0，窗口边界跨采样段时按时间占比折算。
   *  因此永不出现负值，且必然满足 h1 ≤ d1 ≤ d7 ≤ all（嵌套累计窗口）。 */
  consumed: { h1: number | null; d1: number | null; d7: number | null; all: number | null };
}

/** GET <apiPath>[?range=all|1h|1d|7d|30d] 的响应体。 */
export interface TokenDashboardPayload {
  ok: true;
  now: number;
  /** 回显请求的时间范围；未指定时为 "all"。 */
  range: string;
  /** 最近活跃的会话 id（取所有会话中最新的事件）；没有则为 null。 */
  activeId: string | null;
  config: { apiPath: string; seriesSize: number };
  count: number;
  backfilled: boolean;
  backfillError: string | null;
  /** 窗口内所有会话合并后的汇总值。 */
  totals: TokenDashboardTotals;
  /** 窗口内合并的每小时趋势；range=1h 时为每分钟粒度（60-61 个点），range=30d|all 时为每天粒度。 */
  series: TokenDashboardHourSample[];
  /** 窗口内的每模型消耗，按消耗降序排列。 */
  models: TokenDashboardModel[];
  /** DeepSeek 官方账户余额，以及按余额下降推算的消耗。 */
  balance: TokenDashboardBalance;
  sessions: TokenDashboardSession[];
}

export const name: string;
export function apply(ctx: unknown, config?: Config): void;
