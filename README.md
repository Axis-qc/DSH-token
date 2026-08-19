# dsh-token-dashboard

一个双端 DSH 插件，在 Web GUI 中加入一个**可折叠、可拖动的悬浮小窗**，实时显示 token 消耗、缓存命中率、上下文占用与分步用量趋势 —— 既覆盖当前进行中的会话，**也**覆盖磁盘上已有的所有历史会话。

- **服务端（`index.js`）** 订阅已落盘的会话事件流，将其折叠为每会话的 token 累计值与按小时的趋势序列。插件加载时（以及之后每 5 分钟）会异步重放 `$DSH_HOME/sessions` 下所有持久化的 `.jsonl.zstd` 会话日志，因此 dsh web 冷启动后即可看到磁盘上既有会话的历史用量，而不只是插件加载之后新建的会话。
- **浏览器端（`client.js`）** 是完全自包含的 bundle（不依赖 React、不用插槽、不用主题工具库 —— 只有 `fetch` + DOM + SVG）。它渲染一个固定定位的小窗，可折叠为单行摘要、可在页面上拖动，展开后显示汇总数值、图表、时间窗口筛选器与会话选择器。

## 安装

该包必须能从 web profile 的 `node_modules` 中被解析到。在本工作区的仓库根目录执行：

```sh
node _plugins/dsh-token-dashboard/install.mjs
```

安装脚本会把整个包复制到 `$DSH_HOME/profiles/web/node_modules/`，在 profile 的 `package.json` 依赖中注册它，并**幂等地更新**（upsert）`cordis.patch.yml` 中的加载行。每次改动源码后重新执行即可重新部署。之后需要**重启 dsh web**（插件集变更仅在重启时生效）：

```
# 在 start-web 控制台窗口中输入：
restart
```

> 安装脚本是单向覆盖部署。**请始终在本源码树中修改插件，绝不要直接编辑 profile 里的副本** —— 源码树是唯一可信来源且已纳入版本控制，出问题用 git 检出恢复即可。

如果你更愿意手工接线，在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: token-dashboard
      name: 'dsh-token-dashboard'
      config:
        apiPath: /token-dashboard/api
        seriesSize: 600
```

## 配置项

| 配置键 | 默认值 | 含义 |
| ------ | ------ | ---- |
| `apiPath` | `/token-dashboard/api` | JSON 路由（浏览器端向此地址请求数据） |
| `seriesSize` | `600` | 每个会话保留的趋势样本上限（实时事件与回填历史共用此上限） |
| `scanRoot` | `$DSH_HOME/sessions` | 覆盖扫描历史记录的持久化会话根目录 |
| `backfillOnStart` | `true` | 插件加载时执行一次历史回填 |
| `deepseekApiKey` | `env DEEPSEEK_API_KEY` | DeepSeek tab 所需的官方 API 密钥（建议通过环境变量提供；密钥绝不离开服务端） |
| `balanceRefreshMs` | `1800000`（30 分钟） | 官方余额的重新拉取间隔 |
| `balanceFile` | `$DSH_HOME/dsh-token-dashboard-balance.json` | 余额历史的持久化位置（重启后仍保留） |
| `refreshMs`（客户端） | `2500` | 浏览器轮询间隔（毫秒） |

## 回填 —— 历史数据是如何重建的

插件加载时，`setImmediate` 会调度一次对所有 `<scanRoot>/<编码后的cwd>/session-*/session.jsonl.zstd` 的单遍扫描：

1. 通过读取帧头与块长度来定位文件中的 zstd 帧（**不做解压**），因此即使有上百个会话，扫描依然很快。
2. 每个完整帧被解压（`node:zlib` —— Node 22 已内置 Zstandard），其事件送入与实时订阅**完全相同**的 `foldEvent` 处理。这样累计值与分步序列都能被重新推导出来。
3. 后续的回填轮次会跳过已在内存中的状态 —— 周期性刷新（每 5 分钟）只会重新折叠那些 `.jsonl.zstd` mtime 有推进的会话。这样 dsh 运行期间进行中的实时样本不会被覆盖破坏。
4. 浏览器收到的第一份数据里 `backfilled: false`、`backfillError: null`；约 1 秒内的下一次轮询就会翻转为 `backfilled: true`，小窗页脚随即显示一个「已回填」标记。

重放一个 150 KB 的会话日志通常耗时约 15 ms；2 MB 的日志约 50–250 ms。`$DSH_HOME/sessions` 下所有会话都会被扫描，因此启动开销取决于历史会话的数量，而非挂钟时间。

### 哪些是精确重建，哪些是近似值

| 字段 | 回填来源 | 精确度 |
| ---- | -------- | ------ |
| `totals` | 每一条 `assistant/message` 的 usage | 精确 |
| `series[]` | 按 (turn, step) 触发的 flush | 精确（与实时算法一致） |
| `stats.turns` | `turn/end` 计数 | 精确 |
| `stats.steps` | `step/end` 计数 | 精确 |
| `context.contextWindow` | `request/context.contextWindow` | 精确 |
| `context.pressureTokens` | 最后一条 `assistant/message` 的 usage | 精确（仅最新样本） |
| `context.projectedTokens` | 直接取 `pressureTokens`（无 surface 折叠） | **近似** |

之所以要说明 `projectedTokens` 是近似值：宿主的投影计算为 `projectedTokens = pressureTokens + surfaceTokens - sampledSurfaceTokens`，而回填过程没有可重放的 surface 折叠数据。由于下一条 `assistant/message` 到达时实时订阅就会更新该字段，这个近似只在插件启动后的第一次轮询中可见。

## 四个视图：总消耗 / 会话 / 模型 / DeepSeek

小窗有四个 tab 视图（按键 `T` 循环切换 总消耗 → 会话 → 模型 → DeepSeek，按键 `0` 直接跳到 总消耗）：

- **总消耗（汇总）** —— 在所选时间窗口内，把**所有会话合并**为一组数值卡片与图表：
  - 输入 / 输出 / 缓存读取 / 缓存写入 都是累计型 token 计数，直接求和。
  - **总命中率**并非各会话命中率的平均值，而是由总和重新计算：`总缓存读取 ÷ (总输入 + 总缓存读取 + 总缓存写入)`。
  - **上下文占用**是单会话的瞬时指标（当前上下文窗口填充度），没有有意义的总量 —— 该格显示 `—`。
  - **API 调用次数**是窗口内所有会话的模型调用总次数（每条模型回复计 1 次）。
  - 第一个图表的数据源**可点击切换**：输出 / 输入 / 缓存读取 / 总消耗 / 调用次数；第二个图表固定为每小时总消耗（仅 uncached 输入 + 输出 —— 即真实的 API 消耗；缓存读写有折扣，故排除在外）。
- **会话** —— 针对单个会话的数值卡片与图表：跟随模式（`⚡ 跟随进行中的会话`，按键 `F`）会自动切换到最近产生事件的那个会话（即 `payload.activeId`，也就是你正在 DSH 中对话的那一个），也可以从下拉框中指定某个会话。此视图显示该会话自己的命中率、上下文占用、API 调用次数，以及同样的两个图表（第一个同样可切换数据源）。
- **模型** —— 每个「提供商/模型」组合一张卡片，显示**哪个模型消耗了多少 token**：输入（uncached）/ 缓存读取 / 输出、该模型的 API 调用次数，以及一个带缓存命中率的总消耗格（uncached 输入 + 输出）和一条占窗口总消耗比例的条形图。卡片按总消耗降序排列。提供商/模型组合读取自每条 `assistant/message` 的 `data.message.source`（缺失时归入 未知|未知），因此混用多模型的对话能把每个 token 都归因到真正生成它的模型。
  对于会上报实际服务模型的路由型提供商（Auto / 路由类提供商，例如火山方舟 ark），显示的是来自 `source.replayState.response.responseModel` 的**服务端实际路由模型**（例如 `kimi-k3`），而非请求时配置的名称 —— 当没有上报路由模型名时，回退为 `source.model`。
  此 tab **只显示精确的 token 计数**，不做金额估算。模型价格会随时间变化，而且（对 opencode-go 等）无法通过 API 查询，因此基于过期价格快照推算出的任何「成本」都只是误导性的猜测。真实金额请查看各提供商自己的控制台（或下面的 DeepSeek tab，它反映的是**官方**余额）。
- **DeepSeek（官方余额）** —— 显示从 `GET https://api.deepseek.com/user/balance` 拉取的 DeepSeek 官方账户余额（[文档](https://api-docs.deepseek.com/api/get-user-balance/)）：按币种显示 总余额 / 赠送余额 / 充值余额，加上账户可用状态、一条**余额随时间变化曲线**，以及 近1小时 / 近24小时 / 近7天 / 自监控以来 四个窗口的**余额下降量**。服务端在启动时拉取一次，之后每 `balanceRefreshMs`（默认 30 分钟）拉取一次，并把每个成功取到的值追加到一份**持久化到磁盘**的滚动历史中（`balanceFile`，默认 `$DSH_HOME/dsh-token-dashboard-balance.json`），启动时重新载入 —— 因此这些窗口与曲线能跨重启保留历史，而不会归零。
  下降量 = 窗口内的最新余额 − 最旧余额 —— 这是唯一可得的真实金额信号（token 日志里有用量，但价格可自由浮动，所以用量比乘上一个猜测价格更诚实）。下降量为负说明窗口内余额**上升**了（有充值或赠送到账）。该下降量只是此密钥消耗的近似值，可能包含 DSH 之外的花费 —— 请务必与官方账单控制台交叉核对。使用此功能必须提供密钥：在插件配置中设置 `deepseekApiKey`，或设置 `DEEPSEEK_API_KEY` 环境变量。**密钥只留在服务端 —— 绝不会出现在 JSON 响应中。** 未配置密钥时该 tab 显示配置提示；遇到 HTTP/网络错误时显示失败原因并自动重试。

面板上方的分段控件用于收窄**所有** tab 的时间窗口：

| 标签 | `?range=` | 窗口范围 | 粒度 |
| ---- | --------- | -------- | ---- |
| 全部 | `all` | 磁盘上的全部历史 | 每小时 |
| 1月 | `30d` | 最近 30 天 | 每小时 |
| 1周 | `7d` | 最近 7 天 | 每小时 |
| 1天 | `1d` | 最近 24 小时 | 每小时 |
| 1小时 | `1h` | 最近 1 小时 | **每分钟** |

**1小时**范围是特殊的：它以**每分钟**粒度渲染趋势图（连续的 60 分钟轴，空缺补零），便于逐分钟观察最近一段活动。小窗约每 2.5 秒轮询一次，因此面板打开时大约每分钟会出现一个新的分钟数据点。分钟级桶以约 25 小时的滚动缓冲保存在内存中；其他所有范围仍使用小时级桶。

切换范围会重新向服务端请求（`GET /token-dashboard/api?range=…`）并重新聚合每个会话的桶，因此汇总数值、图表以及折叠状态下的摘要标签都会反映所选窗口。会话选择器位于 会话 tab 内，提供跟随模式以及每个有数据贡献的会话条目（标签 = 推导标题 / cwd / id）。

所选范围、视图与图表数据源都记录在 `localStorage` 中（`dsh-token-dashboard:range`、`…:tab`、`…:follow`、`…:session`、`…:ametric`、`…:smetric`）。

小窗宽约 440px（3 列数值网格）。连接/回填状态标记（`连接中…` / `回填中…` / `已回填` / 红色 `连接失败`）位于面板头部标题旁，因此即使面板折叠也能看到；页脚只保留最后更新时间。

## API

- `GET /token-dashboard/api[?range=all|1h|1d|7d|30d]` → `{ ok, now, range, activeId, config, count, backfilled, backfillError, totals, series, models[], balance, sessions[] }`
  - `activeId` —— 最近活跃会话的 id（取**所有**会话中最新的事件，不限于当前窗口）—— 即浏览器端跟随模式的目标
  - `totals` —— 窗口内所有会话合并的 `{ uncached, cacheRead, cacheWrite, output, calls }`
  - `series[]` —— 窗口内合并的每小时 `{ t, in, cr, cw, out, calls, hitPct }`；当 `range=1h` 时这是由滚动分钟桶算出的每分钟序列（60–61 个点，步长 1 分钟）
  - `models[]` —— 窗口内的每模型数据 `{ provider, model, totals, hitPct, sharePct }`：
    - `totals` —— 该「提供商/模型」组合在所有会话上求和得到的 `{ uncached, cacheRead, cacheWrite, output, calls }`
    - `hitPct` —— 该模型自己的缓存命中率，百分比 0-100，由其总和重新计算（`cacheRead ÷ (uncached + cacheRead + cacheWrite)`）
    - `sharePct` —— 占窗口总消耗（uncached 输入 + 输出）的比例，百分比 0-100；条目按消耗降序排列
    - （没有 `price`/`cost` 字段 —— 金额估算已被移除）
  - `balance` —— DeepSeek 官方余额
    `{ configured, ok, error, fetchedAt, is_available, infos: [{ currency, total, granted, topped }], history: [{ t, total, granted, topped }], consumed: { h1, d1, d7, all } }`；
    未设置密钥前 `configured: false`，拉取失败或从未执行时 `ok: false`；`history` 是按时间排序的余额样本（最新在最后），用于驱动曲线与 `consumed` 余额下降窗口（单位 ¥，上升则为负）。API 密钥本身绝不出现在响应中。
  - `sessions[].totals` —— 窗口内的 `{ uncached, cacheRead, cacheWrite, output, calls }`
  - `sessions[].title` —— 推导出的标签：第一条**真实用户消息**的文本（插件注入的上下文会被忽略），截断至 60 字符；该会话没有则为 `null`。DSH 不存储面向用户的标题，因此选择器会退化为使用 cwd 的基名，再退化为顺序编号，并总是追加短 id 与可选的预设标签（例如 `修复插件样式 ·a1b2c3 [standard]`）。
  - `sessions[].preset` —— 会话头中的 agent 预设 id（若有）
  - `sessions[].createdAt` —— 会话头中的创建时间，毫秒时间戳
  - `sessions[].series[]` —— 窗口内的每小时 `{ t, in, cr, cw, out, calls }`
  - `sessions[].stats` —— `{ turns, steps }`（宿主侧的 `sessionStats` 在实时链路上字段更多，但回填只能恢复计数）
  - `sessions[].context` —— `{ contextWindow, pressureTokens, projectedTokens }`

小窗头部有一个**刷新**按钮（键盘 `R`），会立即按当前范围请求数据而不等下一次轮询；图标会短暂旋转作为反馈。这里刻意**没有「清空/重置」**功能 —— 插件聚合的是磁盘上真实的会话日志，清空内存状态只会在下一次回填时被重新填满，结果只是让数字消失一瞬间。

## 说明与已知限制

- 响应中的趋势序列是**按小时**的（每个点聚合一小时的分步样本），这样 30 天窗口仍然可读，也让 API 能低成本地切出任意时间范围。实时的分步粒度仍在内部折叠用于去重；小时桶才是小窗渲染与 API 提供的内容。
- 回填不会重放完整的 surface 投影。因此在实时事件补上之前，`projectedTokens` 字段等于 `pressureTokens`。
- 仍在写入的会话中，最后一个（被截断的）zstd 帧会被跳过 —— 会话写入器会在下次追加时重试。如果 dsh 在长对话中途重启，该对话最后几秒的实时样本会通过 `session/event` 订阅叠加到已回填的基线之上。
- 小窗仅限同源使用（无 CORS），经局域网代理访问是安全的。
