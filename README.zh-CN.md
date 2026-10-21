<div align="center">

# dsh-plugin-adapter

**在 DSH（DeepSeek Harness）里原生使用 OpenCode Zen 的免费匿名模型。**

无需 API Key。无需注册。无需额外进程。

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue)](https://github.com/1624318455/dsh-plugin-adapter)

<div>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="license"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="Awesome"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-20%2B-blue" alt="node"></a>
  <a href="packages/plugin/test"><img src="https://img.shields.io/badge/tests-162%20passed-success" alt="tests"></a>
  <a href="https://github.com/1624318455/dsh-plugin-adapter"><img src="https://img.shields.io/github/stars/1624318455/dsh-plugin-adapter" alt="stars"></a>
  <a href="https://github.com/1624318455/dsh-plugin-adapter/commits/master"><img src="https://img.shields.io/github/last-commit/1624318455/dsh-plugin-adapter" alt="last commit"></a>
</div>

[English](README.md) | 简体中文

</div>

---

dsh-plugin-adapter 会向 DSH 注册一个原生的 `LlmAdapter`，直接流式对接
[OpenCode Zen](https://opencode.ai/zen) 的**匿名免费通道**——也就是
OpenCode 官方 CLI 无需登录即可使用的那批免费模型，它们会以 `zen-free`
这个常规 provider 出现在你的 DSH 模型选择器里（`opencode2dsh` 保留为
旧会话的兼容别名）。

插件发出的请求与 OpenCode CLI 的流量完全同形（相同的 User-Agent、相同的
关联请求头），模型目录通过三级回退链保持新鲜。不用登录任何账号，也不用
自己部署任何东西。

## 特性

- **零凭据、零配置**——匿名通道不需要任何 Key；装好、重启、开聊
- **原生 adapter，无 sidecar**——一个 npm 包，没有子进程、没有二进制、没有本地端口（旧版 Go sidecar 不随包发行，见 `legacy/`）
- **CLI 同形伪装**——请求携带 OpenCode CLI 的 User-Agent 和整套会话/请求/项目关联头，按会话派生
- **思考等级可选**——带推理的免费模型在 DSH 模型选择器里出现思考等级选项（模型声明档位的按声明展示，其余提供 Off/Minimal/Low/Medium/High）；Off 向上游发送 `reasoning_effort: "none"` 真正停思考，不选则保持上游默认
- **实时目录 + 三级回退**——上游实时列表 ∩ 元数据判定免费，断网时依次回退到磁盘缓存与已验证的静态名单
- **自愈能力**——启动期快速重试、周期刷新，并落盘健康快照便于排查
- **规范的错误呈现**——上游故障（限流、鉴权、超时、传输）以分类的 finish 原因送达 DSH，重试策略始终由 DSH 掌控

## 安装

**从插件市场安装**（推荐，收录后可用）：在 DSH 里打开 **设置 → 插件市场**，
搜索 `dsh-plugin-adapter`，一键安装。

**从 GitHub 安装**：

```sh
dsh plugin --profile web add github:1624318455/dsh-plugin-adapter
```

**从 npm 安装**：

```sh
dsh plugin --profile web add @memef1f1y/dsh-plugin-adapter
```

**从源码安装**（自行打包）：

```sh
git clone https://github.com/1624318455/dsh-plugin-adapter.git
cd dsh-plugin-adapter/packages/plugin
pnpm install && pnpm pack
dsh plugin --profile web add ./memef1f1y-dsh-plugin-adapter-<version>.tgz
```

**验证**：重启 `dsh web`，打开模型选择器，在 **zen-free** 分组里选模型即可。

需要带 web profile 的 DSH（DeepSeek Harness）；Node.js ≥ 20（DSH 能跑就满足）；
出站 HTTPS 需可达 `opencode.ai` 与 `models.dev`。

## 配置

默认配置开箱即用。需要覆盖时，编辑 profile 的 `cordis.patch.yml`：

```yaml
- id: opencode2dsh
  name: '@memef1f1y/dsh-plugin-adapter'
  config:
    mode: adapter        # adapter（默认）| sidecar
    providerId: zen-free
    refreshSeconds: 300  # 目录刷新周期（秒）
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `adapter` | `adapter`：原生 LlmAdapter 直连 Zen。`sidecar`：旧版本地 agent 模式，不随包发行——请从 `legacy/agent` 自行构建并通过 `agentPath` 指定。 |
| `providerId` | `zen-free` | 在 DSH 中显示的 provider 名称（`opencode2dsh` 保留为兼容别名）。 |
| `refreshSeconds` | `300` | 实时目录刷新间隔；定价元数据每 24 小时刷新。 |
| `gatewaySession` | — | 每轮固定发送的 session id。**默认不要设**，除非需要逃生口：Zen 免费通道的配额是按 **session id** 计的，钉死后所有会话共用一个配额池（一旦 429，整台 DSH 都会挂到换 id 为止）；不设时适配器按每个会话的首条用户消息派生 canonical id——同会话多轮不变、不同会话互不相同，于是每个会话各有一份配额。某个会话被钉在坏副本上时，再用本机 CLI 的 live session id 填这里并重启即复活。 |
| `watchdog.firstEventMs` | `60000` | 首 token 预算。Zen 会把响应头压到上游吐出第一个 token 才放行，所以这个窗口衡量的是「首个回答有多慢」，不是「出口是否哑火」。 |
| `watchdog.reasoningFirstEventMs` | `90000` | reasoning 模型的同一预算（它们思考更久）。 |
| `watchdog.bodyIdleMs` | `120000` | 内容开始流出后的静默预算（Responses 模型 300 秒）。 |
| `contextWindow` | — | 上报给 DSH 的上下文窗口上限（token 数）。DSH 按 provider 报的窗口做压缩，而免费模型声明的是 **1,000,000**——于是长会话永远不压缩，每轮都把整个（还在增长的）上下文重发一遍（实测：surface 404K token，每步从提示缓存读回 205K）。设一个上限（如 `131072`）让 DSH 早点压缩：prompt 更小、首 token 更快、烧的配额更少。不设 = 用模型自己的窗口。 |
| `transport.proxyUrl` | — | Zen 通道自己的代理地址，例如 `http://127.0.0.1:10808`。该通道会走**每请求一条新 CONNECT 隧道**的独立 dispatcher，代理悄悄关掉旧隧道时不会以 `UND_ERR_SOCKET` / `ECONNRESET` 打断这一轮；其他域名仍走原来的全局 dispatcher。 |
| `transport.noReuse` | `true` | 设为 `false` 可让 Zen 通道继续复用连接。 |
| `agentPath` | 自动解析 | 仅 sidecar：agent 二进制路径。 |
| `agentArgs` | — | 仅 sidecar：传给 agent 的额外 CLI 参数。 |
| `restartDelayMs` / `restartMaxDelayMs` / `maxConsecutiveCrashes` | `1000` / `60000` / `5` | 仅 sidecar：重启退避与熔断阈值。 |

## 工作原理

```
DSH 会话
   │  harness chunk（block-start / text-delta / usage / finish …）
   ▼
ZenAdapter（注册的 LlmAdapter）
   │  pi-ai openai-completions 流式
   ▼
https://opencode.ai/zen/v1        ← Authorization: Bearer public
   携带与 CLI 同形的请求头：
     user-agent: opencode/…
     x-opencode-client, x-opencode-session, x-session-affinity,
     X-Session-Id, x-opencode-request, x-opencode-project
```

- **会话关联**——session/project id 由会话首条用户消息经 SHA-256 派生
  （同一会话稳定、不可逆推），每个请求再附带一个全新的随机 id，与 CLI 行为一致。
- **目录回退链**——S1：实时 `GET /v1/models`；S2：models.dev 定价元数据判定
  "免费"；S3：编译期验证的静态名单。上游故障时由磁盘缓存（约 7 天有效期）兜底。
- **韧性**——adapter 在启动时立即注册；若首次目录拉取撞上网络尚未就绪
  （VPN/TUN 重连、DNS 等），会以短周期重试（约 1 分钟内），随后转入常规刷新。
- **sidecar 模式**（`mode: sidecar`，旧版）——拉起本地 Go agent（
  [opencode2api](https://github.com/jasonxu114514/opencode2api) 的单租户移植版），
  监听 `127.0.0.1:<随机端口>`、token 鉴权，并注册标准 `llm-pi-ai` 路由。
  **不随包发行**；请从 `legacy/agent` 构建（`go build ./cmd/agent`）并把
  `agentPath` 指向产物。

## 网关兼容（Zen 门跟踪）

Zen 免费通道会锁第三方客户端，且不打招呼就迁移模型接口。本 fork 跟踪
已知的三道门（见 issue #7）：

- **Responses-only 模型**——`muse-spark-*` 走 `/chat/completions` 必裸 500，
  走 `/responses` 200。adapter 把它们路由到 pi-ai `openai-responses`
  （reasoning 阵发，body 静默窗口放宽到 300 秒），其余仍走
  `openai-completions`。
- **严格 UA**——网关要求裸的当前 `opencode/<版本>`；带后缀或旧版本一律
  `403 FreeTierError`。`opencodeUserAgent()` 跟随 CLI 发版。
- **真 session 检查**——网关只认它见过的真 session，未知 id 一律
  `403 FreeTierError`。在插件配置里设 `gatewaySession`（或
  `gatewaySessionFile`，每轮重读）填一个本机 CLI 的 live session：

```yaml
- id: opencode2dsh
  config:
    gatewaySessionFile: C:\Users\you\.opencode2dsh\gateway-session.txt
```

## 健康状态与排查

插件在每轮刷新后写入健康快照：

```
~/.opencode2dsh/adapter-status.json
```

```json
{
  "status": "ready",
  "total": 64,
  "exposed": 9,
  "lastError": "",
  "writtenAt": "2026-08-29T07:01:54.915Z"
}
```

| 现象 | 可能原因与处理 |
| --- | --- |
| 启动页报 `Failed to load plugins … list slot "settings.plugin.item" requires options.id` | DSH 版本过旧（≤ 0.1.0-rc.6）：设置槽位契约与插件 0.3.0 的浏览器半边不匹配。升级 DSH 到 ≥ 0.1.0-rc.7（推荐最新）即可；插件 ≥ 0.3.1 已自带双形态兼容，旧版 DSH 上最多没有设置卡片，模型路由不受影响。 |
| 只有 3 个模型 | 启动时网络未就绪，重试会在约 1 分钟内补齐；看 `adapter-status.json` 里的 `lastError`。 |
| `lastError: "fetch failed"` 持续出现 | 出站 HTTPS 到 `opencode.ai` 被拦截；检查代理/VPN 规则。 |
| 对话中报限流错误 | 匿名通道按 IP 限额；切换网络节点或稍后再试。 |
| `muse-spark-*` 经 chat 报 500 | Responses-only 模型；本 fork 已自动路由到 `/responses`。 |
| `403 FreeTierError：free tier can only be used from within OpenCode` | Zen 收紧指纹：升级插件（裸当前 UA）并用 `gatewaySessionFile` 同步本机 CLI 的真 session。 |
| reasoning 模型报 `stream body idle timeout` | 阵发式 chain-of-thought 触发 120 秒看门狗；本 fork 对 Responses 模型用 300 秒。 |
| 报 `first stream event timeout` | 这是**首 token 超时**，不是出口哑火：Zen 把响应头压到上游吐出第一个 token 才放行，首个回答慢以前会被误报成「出口静默」。窗口为 60 秒（reasoning 模型 90 秒），可用 `watchdog.*` 调整；有 IP 池时会换出口重试。 |
| 连接 `127.0.0.1:*` 报错 | 残留的 sidecar 路由遮蔽了 adapter；插件 ≥ 0.2.1 启动时会自动清理。 |
| `429 … "Upstream request failed: Endpoint is unavailable."` | 网关背后的模型实例挂了——**不是**配额问题，也跟出口无关。适配器会重掷一次 session id（通道按 session 绑定实例），把请求挪到另一个实例。 |
| `Request timed out.` | OpenAI SDK 的请求上界先于任何响应头触发。适配器现在会显式传上界（看门狗窗口 + 30 秒），上游卡死不会拖成 SDK 默认的 10 分钟，且由看门狗给出可读诊断而不是这句裸错误。 |
| `400 … requires adaptive thinking; reasoning effort none is not allowed` | 该模型不允许关思考（`minimax-m3.1*`）。选 `off` 会被映射成它接受的最便宜档位（`low`），而不是整轮 400。 |
| 安装时报 `ERR_PNPM_IGNORED_BUILDS` | `pi-ai` 的传递依赖（`@google/genai`、`protobufjs`）带构建脚本，运行时并不需要。在插件市场里按提示选择允许/拒绝，或在 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds:` 下把这两项设为 `false`。 |

## 安全性

- 不涉及任何机密：匿名通道的 Key 就是字面量 `public`；插件不存储任何东西，也没有任何遥测。
- 安装产物仅限 `lib/`；不执行任何依赖的构建脚本。
- 所有请求均从你的机器直连 `opencode.ai` / `models.dev`。

## 开发

```sh
git clone https://github.com/1624318455/dsh-plugin-adapter.git
cd dsh-plugin-adapter/packages/plugin
pnpm install
pnpm typecheck && pnpm test
pnpm build                    # 打包到 lib/
```

旧版 Go sidecar 在 `legacy/agent`（`go test ./...`）。架构说明与移植记录见 `docs/`。

发布：在 `packages/plugin` 执行 `pnpm pack`（prepack 会构建并同步文档）。

## 致谢

- [opencode2dsh](https://github.com/FishBottle7/opencode2dsh)（[FishBottle7](https://github.com/FishBottle7)）——
  本项目是它的维护分支，adapter、目录与 IP 池设计源自该项目。
- [**opencode2api**](https://github.com/jasonxu114514/opencode2api)，作者
  [@jasonxu114514](https://github.com/jasonxu114514)——`legacy/agent` 里的旧版
  Go sidecar 是其匿名通道实现的移植版，目录回退链与请求伪装细节同样源自它。
  本项目能成立，全靠它踩过的路。
- [OpenCode](https://opencode.ai)——运营免费匿名 Zen 通道。
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)——adapter 模式使用的线上协议层。
- [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 与
  [dsh-market](https://github.com/dsh-market/dsh-market) 社区。

## 友链

<div align="center">

**[LinuxDo](https://linux.do)** —— 新的理想型社区

</div>

## 许可证

[MIT](./LICENSE) © FishBottle7
