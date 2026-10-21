# AI 上手指南：dsh-plugin-adapter × dsh-plugin-proxy 协作

**读者**：拿到一台新机器的 AI Agent，或需要在新机器上复现 zen-free 可用性的工程师。
**目标**：让 DSH 的 `zen-free` 模型稳定可用，并且**知道配额到底按什么计**（实测：按 session id，见 §0/§5），能在 429 时用最小动作恢复。

> 这份文档是操作手册，不是设计文档。设计细节见 `docs/design.md`、IP 池见 `docs/ip-pool.md`。
> 读完本文你应该能独立完成部署、验收、故障定位。

---

## 0. 一分钟原理

```
DSH 会话
  │
  ▼
dsh-plugin-adapter ── 注册 provider「zen-free」，直连 OpenCode Zen 匿名通道
  │                      凭证是字面量 "public"（无需 API Key）
  │                      出站请求走 globalThis.fetch
  ▼
dsh-plugin-proxy ─── 接管 undici 全局 dispatcher，把上面这条 fetch 隧道到代理
  │
  ▼
v2rayN (127.0.0.1:10808) ──▶ 节点出口 IP ──▶ https://opencode.ai/zen/v1
```

**唯一必须理解的一句话**：OpenCode 匿名通道**按 session id 计额**（2026-10-21 实测：换出口 IP 仍然是 429，换 session id 立刻 200）。适配器默认按会话派生 session，所以「开个新会话」就是最直接的刷新手段；固定的 `gatewaySession` 会把整台 DSH 的配额钉在同一个 id 上，一旦打爆只能换 id。

两个插件的分工：

| 插件 | 职责 | 关键配置 |
| --- | --- | --- |
| `@memef1f1y/dsh-plugin-adapter` | 让 DSH 出现一个叫 `zen-free` 的 provider | `providerId` / `gatewaySession` / `refreshSeconds` |
| `@memef1f1y/dsh-plugin-proxy` | 把 DSH 进程内**所有**出站请求改道到代理 | `mode` / `proxy` / `noProxy` / `exportEnv` |

---

## 1. 前置条件

| 项 | 要求 | 验收命令 |
| --- | --- | --- |
| Node.js | ≥ 20 | `node -v` |
| DSH | ≥ `0.1.0-rc.7`（推荐 `0.2.0-rc.2`+） | `dsh --version` |
| v2rayN | 已启动，**混合端口 10808** | `netstat -ano \| findstr 10808` |
| 出口网络 | 代理可达 `opencode.ai` | 见 §4 步骤 6 |

> v2rayN 的 10808 是**混合端口**（同时接受 HTTP CONNECT 与 SOCKS5）。本文统一用 `http://` 形式，最省事。

---

## 2. 安装

```powershell
# 2.1 两个插件都装进 web profile
dsh plugin --profile web add @memef1f1y/dsh-plugin-adapter
dsh plugin --profile web add @memef1f1y/dsh-plugin-proxy

# 2.2 验收：两个包都出现在 dependencies 里
dsh plugin list --profile web
```

**完成判据**：输出中同时出现

```
├── @memef1f1y/dsh-plugin-adapter@0.3.11
├── @memef1f1y/dsh-plugin-proxy@0.1.4
```

任一缺失 → 重跑对应的 `dsh plugin add`，不要往下走。

---

## 3. 配置文件位置（DSH 0.2.x 必读）

DSH `0.2.0` **移除了 `settings.yaml`**，所有分节被导入到 **profile 的 patch 文件**：

```
C:\Users\<你的用户名>\.dsh\
├─ profiles\web\
│  ├─ package.json          ← 声明依赖与 bundles
│  ├─ cordis.patch.yml      ← ★ 插件配置写这里（你唯一要改的文件）
│  └─ cordis.yml            ← profile 根入口，保持空数组，别手改
└─ logs\                    ← 启动日志
```

> `~/.dsh/settings.yaml.imported` 是 0.2.0 迁移时留下的**历史快照**，**改它没有任何效果**。

---

## 4. 部署步骤

### 步骤 1 — 确认代理端口在监听

```powershell
netstat -ano | findstr 10808
```

**完成判据**：至少一行 `127.0.0.1:...  127.0.0.1:10808  ESTABLISHED` 或 `LISTENING`。
没有 → 先启动 v2rayN，别改 DSH 配置。

### 步骤 2 — 确认代理出口可用

```powershell
curl.exe -s -m 15 -x http://127.0.0.1:10808 https://api.ipify.org
```

**完成判据**：打印出一个公网 IP（如 `64.118.136.68`）。
空输出 → 节点不可用（换节点或检查订阅），此时改 DSH 也没用。

### 步骤 3 — 写入双插件配置

编辑 `C:\Users\<你的用户名>\.dsh\profiles\web\cordis.patch.yml`，**追加**（不是覆盖整个文件）：

```yaml
# ---------- 出站代理：DSH 全部出站流量改道 v2rayN ----------
- id: dsh-proxy
  name: "@memef1f1y/dsh-plugin-proxy"
  config:
    mode: manual                          # direct | system | manual
    proxy: http://127.0.0.1:10808         # 手动指定的代理
    noProxy:
      - localhost
      - 127.0.0.1                         # 本地 MCP / 自建服务必须绕过
      - speech.platform.bing.com          # Edge TTS 不接受 CONNECT 隧道
    exportEnv: true                       # 把 HTTP(S)_PROXY 传给子进程(curl/git/stdio MCP)

# ---------- Zen 适配器 ----------
- id: opencode2dsh
  name: "@memef1f1y/dsh-plugin-adapter"
  config:
    mode: adapter                         # adapter(默认) | sidecar(旧,需自行编译)
    providerId: zen-free                  # DSH 模型选择器里显示的 provider 名
    refreshSeconds: 300                   # 目录刷新周期(秒)
    # gatewaySession: 默认不要设！配额按 session id 计，钉死后所有会话共用
    #   一个配额池（429 一次就全线挂掉）。不设时适配器按会话首条用户消息派生
    #   id，每个会话各有一份配额。仅当某个会话被钉在坏副本上时，才临时填
    #   一个本机 CLI 的 live session id 再重启 DSH。
    # contextWindow: 上报给 DSH 的上下文窗口上限。免费模型声明 1,000,000，
    #   于是 DSH 永远不压缩，每轮重发整个上下文（实测 404K token/step）。
    #   设 131072 让 DSH 早点压缩：prompt 更小、首 token 更快、更省配额。
    contextWindow: 131072
    transport:
      proxyUrl: http://127.0.0.1:10808     # Zen 通道独立 dispatcher：每请求一条新 CONNECT 隧道
```

### 步骤 4 — 设定默认模型（可选）

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: zen-free
    model: deepseek-v4.1-flash-free       # 以模型选择器里实际存在的为准
    reasoningEffort: high
```

### 步骤 5 — 校验配置已被 DSH 正确合成

```powershell
dsh --dump-config --profile web | Select-String -Pattern "dsh-proxy" -Context 0,10
```

**完成判据**：输出含

```
      mode: manual
      proxy: http://127.0.0.1:10808
```

看到 `mode: direct` → 回到步骤 3。

> `dsh --dump-config` 可能会打印一堆 `patch: entry "web-ui-xxx" not found` / `name mismatch ... skipping` 的告警——那是被停用的 Web UI 插件行（`disabled: true`），属于既有噪音，不影响代理与适配器。只看 `dsh-proxy` 与 `opencode2dsh` 两段即可。

### 步骤 6 — 启动并验证代理真的接上了

```powershell
dsh web
```

另开一个 PowerShell 窗口：

```powershell
# 找到 DSH 的 node 进程
$dshPid = (Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*dsh*bin.js*" } |
  Select-Object -First 1).ProcessId

# 观察它是否连着代理口
netstat -ano | Select-String ":10808" | Where-Object { $_.Line -match "\s$dshPid$" }
```

**完成判据**：能看到 `127.0.0.1:<随机>  127.0.0.1:10808  ESTABLISHED  <dshPid>`。
看不到 → 代理没生效，见 §6 故障表第 1 条。

> **这一步是整个流程的关键验证**：它证明 DSH 的出站请求真的进了隧道，而不是"配了但没走"。

### 步骤 7 — 验证适配器健康

```powershell
Get-Content "$env:USERPROFILE\.opencode2dsh\adapter-status.json" -Raw
```

**完成判据**：

```json
{ "status": "ready", "total": 86, "exposed": 10, "lastError": "" }
```

`lastError` 非空（如 `fetch failed`）→ 目录拉取失败，代理链路没通。
`exposed` 只有 3 个 → 启动瞬间网络未就绪，等约 1 分钟插件会自动重试补齐。

### 步骤 8 — 端到端发一条消息

在 DSH Web UI 里选 `zen-free` 分组下的任一模型，发一句 `ping`。

**完成判据**：收到模型回复（不是错误提示）。

---

## 5. 日常操作：换 session 刷新配额（切节点是辅助手段）

**实测结论（2026-10-21）**：配额是按 **session id** 计的，不是按出口 IP。

- 同一个 `gatewaySession`（`ses_e45fa152d3eb5Of7MOiXfLtX4n`）+ **换了出口 IP** → 依然 `429 Rate limit exceeded`
- 同一个出口 IP + **换一个 session id**（本机 CLI live session，或让适配器派生）→ 立刻 `200` 正常回复

所以处理顺序是：

1. **首选：换 session id**
   - 最省事：DSH 里**新建会话**（适配器按会话派生新 id）
   - 或者改 `gatewaySession` 为本机 CLI 的 live session（见 §4 步骤 3）后重启 DSH
   - 注意：`gatewaySession` 是**全局**的，钉住后所有会话共用一个配额池
2. **其次：切 v2rayN 节点**（仍然是必要的，因为出口 IP 被墙/被风控时根本发不出请求）

**为什么不用重启 DSH**：v2rayN/Xray 切节点时会掐断旧的出站隧道，undici 的 keep-alive 连接随之失效，下个请求自动重连到新节点。

**想更保险**：在 DSH **设置 → 插件 → 出站代理** 卡片里再保存一次，强制换掉 dispatcher 并清掉旧连接。

**节奏建议**：切节点后等 1~2 分钟再发第一句，避开按分钟计额的窗口残留。

---

## 6. 故障表

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 切节点后配额不刷新，DSH 进程没有任何到 10808 的连接 | **`dsh-proxy` 的 `mode` 是 `direct`**——插件接管了 undici dispatcher 并静默直连 | 改成 `mode: manual`（步骤 3） |
| 改完配置运行中的 DSH 毫无变化 | 配置文件改错位置 | 只改 `profiles\web\cordis.patch.yml`；`settings.yaml.imported` 是历史快照，改它无效 |
| `403 FreeTierError: free tier can only be used from within OpenCode` | 网关只认它见过的真 session；固定的 `gatewaySession` 已过期 | 换一个新的 canonical 形状 id（`ses_` + 12 hex + 14 base62）；或先删掉 `gatewaySession` 让适配器按会话派生 |
| `Rate limit exceeded. Please try again later` | **该 session id 的配额耗尽**（实测按 session 计，不是按 IP） | 新建会话（派生新 id）；或把 `gatewaySession` 换成本机 CLI 的 live session 后重启；确认 DSH 真的走了代理（§6） |
| `lastError: "fetch failed"` | 出站到 `opencode.ai` 不通 | 跑步骤 1、2；检查 v2rayN 规则是否放行 `opencode.ai` / `models.dev` |
| 某工具（Edge TTS）报连接错误 | 服务端不接受 CONNECT 隧道 | 把该域名加进 `noProxy`（如 `speech.platform.bing.com`），保存即生效 |
| 日志报 `first stream event timeout` | **首 token 超时**，不是出口哑火：Zen 把响应头压到上游吐出第一个 token 才放行，首个回答慢会被误判 | 正常等待重试即可；窗口默认 60 秒（reasoning 模型 90 秒），可用 `watchdog.firstEventMs` / `watchdog.reasoningFirstEventMs` 调大 |
| 偶发 `UND_ERR_SOCKET` / `ECONNRESET` | 复用了被 v2rayN 静默关闭的旧 CONNECT 隧道 | 给适配器配 `transport.proxyUrl`（步骤 3），Zen 通道改为每请求一条新隧道 |
| 子进程（bash 里的 curl/git）不走代理 | 它们在切换前就启动了 | 保持 `exportEnv: true`，并重启对应工具进程 |
| 模型选择器里没有 `zen-free` | 插件没加载 | `dsh plugin list --profile web` 确认；重启 `dsh web` |
| 手动 curl 报 `CRYPT_E_REVOCATION_OFFLINE` | Windows schannel 的证书吊销检查离线 | curl 加 `--ssl-no-revoke`（Node/undici 不受影响，DSH 正常） |
| 日志报 `Request timed out.` | OpenAI SDK 的请求上界先于响应头触发（上游卡死） | 已修：适配器显式传上界（看门狗窗口 + 30 秒），由看门狗先给诊断；仍出现就是上游真挂了，重试即可 |
| 日志报 `429 … Endpoint is unavailable.` | 网关背后的模型实例挂了，**不是**配额 | 已修：适配器自动重掷一次 session id（通道按 session 绑实例）换实例重试；反复出现就是上游整体故障，等一会儿 |
| 日志报 `400 … requires adaptive thinking` | 该模型（`minimax-m3.1*`）不允许关思考 | 已修：选 `off` 时改发 `low`；注意这个模型**最低只能 low**，想更快请降模型而不是关思考 |

---

## 7. 已确认的坑（踩过，勿重复踩）

1. **`mode: direct` 是静默失配**——代理地址填了但没走。日志只有一行 `dsh-proxy: direct (mode: direct)`，adapter 侧完全无感。**每次怀疑"没走代理"，第一步就是抓 netstat 看连接**。
2. **`mode: system` 在 Windows 上读不到系统代理**——该模式只读环境变量，Windows 注册表与 PAC 未覆盖。v2rayN 处于"系统代理"模式时 `mode: system` 很可能静默直连。**用 `mode: manual` 显式指定，最可靠**。
3. **DSH 0.2.x 没有 `settings.yaml`**——配置全在 profile 的 `cordis.patch.yml`。
4. **适配器 0.3.11 只有 `gatewaySession`，没有 `gatewaySessionFile`**（README.zh-CN 里提到但未实现）。想动态换 session 只能改 `gatewaySession` 后重启。
5. **`noProxy` 一定要含 `127.0.0.1`**——否则本地 MCP server、自建服务会被塞进隧道。
6. **直连外网通常不通**——本机直连多数境外站点超时属正常，说明为什么必须显式配代理。
7. **`first stream event timeout` 不是「出口静默」**——Zen 通道把 HTTP 响应头压到第一个 token 才放行（实测 `headers_at == first_byte_at`，同毫秒），所以「还没等到首个事件」只说明模型还没开口。旧版 30 秒窗口 + 旧文案把慢首 token 误报成哑火出口；现已放宽到 60/90 秒并改了文案。实测还出现过一轮「深度求索中 1 分 2 秒」才吐字——旧窗口必杀，新窗口放行。
8. **不要钉 `gatewaySession`**——配额按 session id 计（2026-10-21 实测：换出口 IP 仍旧 429，换 session id 立刻 200）。钉一个 id = 全 DSH 共用一个配额池，打爆后只能改配置重启才能恢复；不钉则每个会话各有一份配额，429 了新建个会话即可。
9. **429 时先别急着切节点**——切节点只解决「出口被墙/风控」；配额是 session 级的，换 IP 不解 429（会白等一轮）。先新建会话或换 session id。
10. **DSH 慢 ≠ 多了一层转发**——adapter 就在宿主进程里，网络路径和 OpenCode CLI 一样。实测首 token 大头是**模型自己在想**（154 token 的 prompt 在 effort=high 也要 6~14 秒，同档位波动 6~24 秒），上下文只贡献几秒；DSH 更慢的另一原因是**一轮多个 step**，每个 step 都是一次带完整上下文的请求。
11. **免费模型声明 1M 上下文 = DSH 永不压缩**——DSH 按 provider 上报的窗口做压缩，不设上限的话长会话会一直涨（实测 surface 404K token，每步读回 205K 缓存）。用 `contextWindow: 131072` 压住。
12. **`minimax-m3.1*` 关不掉思考**——上游对 `reasoning_effort: none` 直接 400（`requires adaptive thinking`）。最低只能 `low`，想更快只能换模型。

---

## 8. 变更 profile patch 的正确姿势

```powershell
# 改之前先备份
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" `
          "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"

# 改完校验合成结果
dsh --dump-config --profile web | Select-String "dsh-proxy" -Context 0,10
```

DSH `0.2.0-rc.2` 的 profile patch **支持热重载**（实测运行中的实例无需重启即生效）。保守起见，改动涉及启动参数时重启一次 `dsh web`。

---

## 9. 相关文件与参考

| 内容 | 位置 |
| --- | --- |
| 适配器源码 | `packages\plugin\src\`（`config.ts` 是全部配置项的权威定义） |
| 适配器设计文档 | `docs\design.md` |
| IP 池（适配器自带的多出口方案） | `docs\ip-pool.md` |
| 代理插件 README | `C:\Users\<你>\.dsh\profiles\web\node_modules\@memef1f1y\dsh-plugin-proxy\README.zh.md` |
| 适配器 README | `packages\plugin\README.zh-CN.md` |
| 本机适配器健康快照 | `%USERPROFILE%\.opencode2dsh\adapter-status.json` |
| 本机 DSH 启动日志 | `%USERPROFILE%\.dsh\logs\startup-*.log` |

> **补充机制**：适配器自身还有一套 IP 池（`ipPool`），能只把 `opencode.ai` 走代理、支持多出口轮换。本手册采用 `dsh-plugin-proxy` 全局代理方案，因为它同时覆盖 `web_search` / `web_fetch` / streamable-http MCP。需要多出口容灾时再看 `docs\ip-pool.md`。

---

## 10. STOP 条件

遇到以下情况**停下来报告**，不要自行绕过：

- 步骤 2 的出口 IP 拿不到 → 节点/订阅问题，不是 DSH 问题
- `dsh --dump-config` 报 YAML 解析错误 → patch 文件被改坏了
- 步骤 8 完成后 `dsh web` 起不来 → 先用 `dsh --dump-config` 定位是哪一行
- 上游返回 `403 FreeTierError` 且换了 session 仍然 403 → 匿名通道本身可能已收紧，需要上游介入
