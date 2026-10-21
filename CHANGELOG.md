# Changelog

## 0.4.0 (identifier rename + watchdog/transport fix)

> 0.3.12 was never published to npm — its content ships in this release.

### Changed

- **功能标识符全部迁到新名字（`opencode2dsh` → `dsh-plugin-adapter`）。**
  0.3.9 只改了品牌表层（日志前缀、类型名、UI 标题），落盘与线上配置仍然依赖旧名；
  本轮把「功能标识符」也一并迁走：

  | 旧 | 新 |
  | --- | --- |
  | 插件 id `opencode2dsh` | `dsh-plugin-adapter` |
  | 数据目录 `~/.opencode2dsh` | `~/.dsh-plugin-adapter` |
  | 凭据 env `OPENCODE2DSH_TOKEN` | `DSH_PLUGIN_ADAPTER_TOKEN` |
  | 桥地址 `/api/opencode2dsh/ip-pool` | `/api/dsh-plugin-adapter/ip-pool` |
  | 工程串 `opencode2dsh:default-project` | `dsh-plugin-adapter:default-project` |
  | sidecar `displayName` | `dsh-plugin-adapter` |

  - **数据目录自动搬家**：首次启动时把 `~/.opencode2dsh` 逐项复制到新目录并校验
    （存在 + 大小一致），然后把旧目录改名为 `~/.opencode2dsh.bak-<日期>`——
    **从不原地销毁**，回滚只需把 `.bak` 改回旧名。任何一步失败都退回旧目录继续跑
    并打一条 warning，绝不让插件崩掉（`src/data-dir.ts`）。
  - **线上 patch 行必须同步改名**：DSH 靠插件 id 把 config 挂到插件上，
    线上 `cordis.patch.yml` 的 `- id:` 若不改，`gatewaySession` 之类的配置会被
    **静默丢弃**（不报错）。README 的升级说明里写了这一条。
  - **provider 别名 `opencode2dsh` 保留**（旧会话按旧 id 存盘，删掉它们就再也发不出
    消息），只作为兼容别名注册，不在模型选择器里显示第二个分组。
  - **旧 sidecar 路由残留会被清掉**：`llm-pi-ai.providers.opencode2dsh` 指向已死的
    本地端口时会遮蔽适配器、让每次派发都报连接错误；启动时的清理范围已扩大到
    旧路由名。
  - Go 侧车（`legacy/`）暂不改名（没有 Go 工具链可验证），sidecar 二进制名两种
    都会去找。

### Added

- **免费模型判定不再被元数据缺项误杀。** Zen 目录里名字带 `-free` 的 id 由通道本身
  免费供应，models.dev 还没收录（实测 `jev-1.13-free`）时以前会被「元数据缺失」
  挡住；现在这类 id 直接放行，元数据只补价格/上下文/思考档位。
  明确的「付费」与「已下架」判定仍然优先（模型名不能复活一个已知付费的 id）。
- **静态免费名单与线上通道同步。** 名单里已经下架的 id
  （`mimo-v2.5-free`、`ling-3.0-flash-fin-free`、`nemotron-3-ultra-free`、
  `muse-spark-1.2-contributor-free`）被移出（否则 S1 未就绪时选择器仍会给出死模型），
  换成本轮线上免费名单（`beam-free`、`flint-40b-free`、`jev-1.13-free`、
  `longcat-2.5-preview-free`、`mimo-v2.6-flash-free`、`deepseek-v4.1-flash-free`、
  `glm-5.3-flash-free`、`nemotron-3.5-super-vl-free`、`minimax-m3.1-flash-free`）。
- **只支持 Responses 协议的模型会自动换路。** 上游用
  `400 ModelProtocolUnsupported: Model does not support this protocol` 拒绝某个模型
  时，适配器会在同一轮里改走 `/responses` 再问一次（记进本进程的模型名单，之后不再
  试错路），而不是把一个用户无法处理的 400 直接甩出去。
  已知只用 `/responses` 的家族（`muse-spark-*`）仍然走静态名单，不用试错。
  实测：`jev-1.13-free` 在**两种协议上都被上游拒绝**（2026-10-22，
  `POST /v1/chat/completions` 与 `POST /v1/responses` 都是同一个 400），所以它虽然
  出现在 Zen 目录里、也会出现在选择器里，但这一轮仍然会以上游 400 收场——
  那是通道侧的问题，不是适配器的路由问题。

### Fixed

- **`first stream event timeout` 不再把「慢首 token」误报成「出口哑火」。**
  实测（2026-10-21）Zen 匿名通道把 HTTP 响应头压到上游吐出第一个 token 才放行
  （`headers_at == first_byte_at`，同毫秒），所以「还没等到首个 pi-ai 事件」只
  说明模型还没开口；旧的 30 秒窗口 + 旧文案把 TTFT 尾部（实测 p50 1.7s /
  p90 8.2s，尾部 35.8s）说成了「exit silent before any response」。现在：
  首个事件窗口放宽到 60 秒（reasoning 模型 90 秒，Responses 模型 120 秒），
  文案改为「time-to-first-token timeout, not a dead exit」，并可通过
  `watchdog.firstEventMs` / `watchdog.reasoningFirstEventMs` /
  `watchdog.bodyIdleMs` 配置。
- **Zen 通道可选独立 dispatcher（`transport.proxyUrl`）。** 全局代理插件
  （`dsh-plugin-proxy`）的 `EnvHttpProxyAgent` 会复用被 Clash/v2rayN 静默关闭
  的 CONNECT 隧道，下一个请求于是以 `UND_ERR_SOCKET` / `ECONNRESET` 收场
  （实测 12 次采样 2 次失败）。配置 `transport.proxyUrl` 后，Zen 通道改走自己的
  dispatcher（`pipelining: 0`，每请求一条新隧道），失败时自动回落到原路径；
  其他域名的流量不受影响。
- **实测澄清：免费通道的配额按 session id 计，不是按出口 IP。** 同一个
  `gatewaySession` 换了出口 IP 依旧 `429 Rate limit exceeded`，同一个出口 IP 换
  一个 session id 立刻 `200`。因此**建议不要钉 `gatewaySession`**：不钉时适配器按
  每个会话的首条用户消息派生 canonical id（同会话多轮稳定、不同会话互不相同，
  形状仍满足免费通道的 gate），于是每个会话各有一份配额池。`gatewaySession`
  保留为逃生口（某会话被钉在坏副本上时再临时钉一个 live session id）。
- **请求上界不再依赖 SDK 默认值。** 之前只有 OpenAI SDK 自己的 10 分钟默认
  超时在兜底，上游卡死时会变成「静默挂 10 分钟」，最后只抛一句裸的
  `Request timed out.`。现在适配器给 pi-ai 显式传 `timeoutMs`
  （= 首事件窗口 + 30 秒），看门狗永远先开口（它带诊断），SDK 只是兜底。
- **`429 "Upstream request failed: Endpoint is unavailable."` 自愈。** 这是网关
  背后的模型实例挂了，不是配额问题、也跟出口无关；通道按 session 绑定实例，
  所以同一个 id 会一直失败。适配器遇到这一类错误会**重掷一次 session id**
  再请求，把请求挪到另一个实例（每轮至多一次）。
- **不允许关思考的模型不再整轮 400。** 实测（2026-10-22）
  `minimax-m3.1-flash-free` 对 `reasoning_effort: none` 直接 400
  （`requires adaptive thinking; reasoning effort none is not allowed`）。
  选 `off` 时改发该模型接受的最便宜档位（`low`）。
- **新增 `contextWindow` 上限。** DSH 按 provider 上报的窗口做压缩，而免费模型
  声明 1,000,000 —— 长会话永远不压缩，每轮重发整个增长的上下文（实测 surface
  404K token、每步从提示缓存读回 205K）。设 `contextWindow`（如 `131072`）让 DSH
  早点压缩：prompt 更小、首 token 更快、烧的配额更少。
- **压缩包络自洽：上报的输出上限不再撑破上报的上下文窗口。**
  DSH 的压缩器（`dsh-compaction-basic`）把**请求的 `maxTokens` 当作窗口内预留**
  来算：`messageBudget = contextWindow - reservedCompletionTokens`；预算为负时它抛
  target-pressure 配置错误，而错误只被记成一条 warning，**这一轮就带着没压缩的
  上下文继续跑**。之前适配器对 `minimax-m3.1-flash-free` 上报 1,000,000/512,000，
  配上 `contextWindow: 131072` 就是 `131072 - 512000 < 0`：**压缩从来没有真正
  运行过**，实测该会话的 surface 一路涨到 256,327 prompt token（每步都重发四分
  之一百万 token），最后通道只能回一个空的 length 响应。
  现在上报的输出上限 = `min(模型上限, 窗口的 1/4)`（窗口被 `contextWindow` 收窄时
  一起收窄），包络恒为正：压缩恢复工作，窗口 262,144 / 输出 65,536 时 DSH 的压力
  阈值落在窗口的 50%（131,072 token）。请求体里的 `max_completion_tokens` 也被夹到
  上报值（实测已从 512000 变成 65536），宿主临时加大的值同样夹住。
- **「已达到输出 token 上限…发送『继续』」的死循环没有了。**
  上游在 prompt 装不下时会**截断**而不是拒绝，回一个 `finish_reason=length`、
  `completion_tokens=1`、**内容为空**的响应（实测 2026-10-22：256,327 prompt
  token）。适配器以前把它映射成 `max-tokens`，宿主于是渲染「达到输出上限，发
  『继续』可让模型接着输出」——而下一轮请求带着同样超大的 prompt，同样的死法，
  用户只能反复点『继续』。现在：**空 length 响应不再是「截断」**——
  prompt 填满窗口时按 `CONTEXT_WINDOW_EXCEEDED` 上报，宿主据此**压缩并重试**
  （`dsh-compaction-basic` 监听这个 code）；prompt 不满窗口时按
  `EMPTY_RESPONSE` 上报，宿主重试该请求。真正的截断（**有**内容）仍然映射成
  `max-tokens`，部分输出不丢。
- **静默溢出判定对齐 pi-ai。** 之前只看未命中缓存的 input，
  `usage.input + usage.cacheRead` 才是一整个 prompt 占掉的窗口；命中缓存的大
  prompt 因此一直没被识别成溢出。现在按 pi-ai 的口径判定（缓存前缀计入窗口），
  并补上 pi-ai 的「length 停止且零输出 = 溢出」这条（阈值 95%，实测通道在
  窗口 98% 处就开始截断）。

### Measured

- **DSH 慢不是「多一层转发」。** 适配器跑在宿主进程内，网络路径与 OpenCode CLI
  相同（都经同一个代理直连 Zen）。实测首 token：154 token 的 prompt 在
  effort=high 下要 6~14 秒（模型自己在想，同一模型同一档位波动就有 6~24 秒），
  130K token 的冷 prompt 约 19~24 秒——上下文只贡献几秒，**大头是模型思考**。
  DSH 里更慢的另一个原因是**一轮多个 step**：每个 step 都是一次带完整上下文的
  请求（实测该会话第 5 轮就到第 21 个 step）。

## Fork 0.3.4 (this repo)

- Responses-only models (`muse-spark-*`) auto-route to pi-ai
  `openai-responses` (chat returns a bare 500); Responses models get a wider
  300 s body-idle watchdog for bursty reasoning.
- Distribution renamed to `@memef1f1y/dsh-plugin-adapter`; runtime ids
  (`opencode2dsh` provider/entry, `ip-pool` namespace) unchanged for drop-in
  installs. Everything else tracks upstream.

## 0.3.3 (2026-09-18)

### Added

- **带推理的免费模型现在可以选择思考等级。** 在 DSH 的模型选择器中，推理模型
  （big-pickle、mimo-v2.5-free、nemotron 系、muse-spark 系等）会出现思考等级
  选项：模型元数据声明了档位的按声明展示（如 muse-spark 的 Minimal–Xhigh），
  其余推理模型提供 Off/Minimal/Low/Medium/High。选 Off 会向上游发送
  `reasoning_effort: "none"`——实测这是唯一能真正让"常思考"模型停止思考的传法
  （只省略该字段时上游保持默认继续思考）；选具体档位原样透传；不选则请求与
  旧版完全一致。非推理模型不出现该选项。

## 0.3.2 (2026-09-18)

### Fixed

- **免费模型全线恢复：修复 2026-09-17 起所有免费源报 `403 FreeTierError`
  （"free tier can only be used from within OpenCode"）的问题。** 经逐项探针
  实测，上游匿名免费通道现在有两道校验，缺一即拒：其一，会话头必须匹配
  OpenCode 官方客户端的会话格式（原先任意 `ses_` 开头的串即可）；其二，请求体
  必须是"智能体形态"——流式且 `tools` 里同时包含名为 `bash` 与 `read` 的
  function 工具（描述与参数不查；纯聊天请求没有工具，故此前全部被拒）。
  插件现在把会话标识确定性映射成官方格式（同一对话仍映射到同一会话，会话
  亲和不受影响），并在发往上游的请求体缺失这两个工具时注入最小桩工具（纯
  聊天附带 `tool_choice: "none"`，模型不会真的调用它们）；免费源准入冒烟
  探测同步改为流式并携带桩工具。

## 0.3.1 (2026-09-11)

### Fixed

- **旧版 DSH 上插件加载失败的问题（用户反馈 `list slot "settings.plugin.item" requires options.id`）。**
  `settings.plugin.item` 槽位在 DSH 0.1.0-rc.7 起由 list（按 `id` 注册）改为 keyed
  （按 `key` 注册）；0.3.0 的设置页卡片按新版 keyed 形态注册，在旧版 DSH
  （≤ 0.1.0-rc.6）上会让整个插件加载失败、启动页报错。现在卡片注册前会探测宿主
  声明的槽位类型，按对应形态注册，两边都能用；即便宿主行为异常，注册失败也只
  跳过设置卡片（控制台警告提示升级 DSH），模型路由不再被拖垮。

## 0.3.0 (2026-09-09)

The release where the IP pool actually works.

### Fixed

- **模型流量现在真正经过 IP 池。** 此前 Node 内置 fetch 与插件所用 undici
  是两个隔离实例，池开启后模型请求仍然直连、路由从未生效。现在开启
  IP 池后模型流量会真实走池中出口。
- **卡死回合不会再挂住整个会话。** 请求遇到出口无响应时会在超时后
  自动换出口重试或如实报错，不再无限等待。
- **慢响应的正常请求不再被误判为坏出口。** 响应哨兵改为双窗口：
  连接阶段 2 秒严格判定死出口，隧道建立后等待响应头放宽到 10 秒，
  避免误杀慢首包的健康流。
- **上游 5xx 不再连带惩罚出口。** 模型自身报错（如权限不足的模型对
  所有人返回 500）不会再把出口标记为失效导致全部流量静默直连。
- **免费源准入恢复正常。** 上游现在要求会话伪装头，探测请求已同步
  补齐；此前免费源候选全部被误拒。
- **池首次攒到出口后自动启用路由**，无需再手动改一次设置来触发。

### Added

- **免费代理源从 26 个扩展到 48 个**，全部逐个实测可用后接入，每轮
  候选量约提升 75%。

## 0.2.7 (2026-09-05)

IP 池发布（IP-0 … IP-7）：出口池与两级健康度、粘性会话路由调度器、
订阅源（含 sing-box 加密节点转换）、设置页热更新、真实流量的被动健康
统计、全量粗筛、适配器层轮换重试、响应静默哨兵、探测模型下拉选择。

## 0.2.6

免费模型目录修复：元数据弃用优先于免费名回退；marketplace 条目指向
可安装的仓库根。
