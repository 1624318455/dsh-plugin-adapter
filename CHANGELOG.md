# Changelog

## 0.3.0 (2026-09-09)

The release where the IP pool actually works. Every fix below was found and
verified against live traffic (full-chain e2e: adapter → pi-ai → fetch →
dispatcher → real exits → zen anonymous lane), not against mocks.

**中文摘要见本节末尾 / 中文版更新日志见 README.zh-CN。**

### Fixed — the pool now really routes your traffic

- **Global fetch capture (the big one).** Node's built-in `fetch` reads the
  BUILT-IN undici instance's dispatcher slot, while `setGlobalDispatcher` on
  the npm undici module writes its own — two isolated module states. The
  OpenAI SDK inside pi-ai captures `globalThis.fetch` at call time, so model
  traffic silently bypassed the pool entirely: every request went direct
  while the pool looked enabled. The installer now swaps the global fetch to
  the module's own fetch while routing is enabled and restores it on
  disable.
- **The 70-minute hang class is dead.** Stream watchdogs now actually fire:
  the old mechanism (a background `source.return()`) queued behind the
  pending `next()` and never interrupted it; the new one races every pull
  against a deadline. No event at all within 30s, or a 120s mid-stream gap,
  synthesizes the terminal error pi-ai never delivered — pre-content silence
  rotates to a fresh exit, silence after content surfaces an honest error.
  Never a hang, never a replay of partial content.
- **Healthy streams no longer struck dead at 2s.** The response-silence
  sentinel now runs two windows: a strict 2s for the connect stage (dead
  CONNECT fires zero callbacks), a separate 10s budget for tunnel-up →
  response headers (measured live: headers land 1.7–2.7s after the tunnel —
  the LLM composing the first token is not exit liveness).
- **An upstream 5xx no longer kills the exit.** A model-level 500 (e.g. a
  contributor-only model answering 500 to everyone) used to strike the exit
  dead; a single-exit pool then picked nothing and ALL traffic silently fell
  back to direct. 5xx now counts for diagnostics only; recovery rides the
  adapter rotate loop.
- **Admission smoke carries the CLI session headers.** zen now requires the
  session disguise headers on the anonymous lane (400 MissingSessionID);
  the probes sent none, so every free-source candidate failed admission
  regardless of exit quality — a full round admitted 0 of 701 tunnel-OK
  survivors. Probes now send the same header set as the adapter, with
  per-candidate session ids.
- **The free-source pool engages routing by itself.** A pool that starts
  empty skipped the dispatcher install, and nothing retried it after refill
  filled the pool — routing stayed off until the user touched settings. The
  first admitted exit now engages routing automatically.

### Added

- **Free-source inventory 26 → 48.** Every new source was verified live
  (HTTP 200, parseable rows, same-day commits) before being added; dead
  candidates found in research (ShiftyTR, clarketm, mmpx12,
  proxy-list.download…) were dropped. Effect measured live: ~48k → ~84k
  candidate rows per round.
- Live e2e scripts shipped as test assets: full-path chat through the pool,
  routing-behavior proofs (session stickiness / 429 reroute / spread), and
  the production-shape free-source pool e2e.

### Removed

- All TEMP-DIAG instrumentation (scratch-file stage marks) — the hang it was
  built to locate is found and fixed.

### 0.3.0 中文摘要

本次发布的主题：**IP 池真正可用了**。所有修复均在真实流量全链路
（适配器 → pi-ai → fetch → 调度器 → 真实出口 → zen 匿名通道）上定位并验证：

- **接管全局 fetch（关键修复）**：Node 内置 fetch 与 npm undici 是两个隔离
  实例，池的调度器此前从未作用于模型流量。安装器现在会把
  `globalThis.fetch` 换成走池的 fetch，关闭时还原。
- **70 分钟挂死类问题彻底修复**：流看门狗改为每次拉取带截止时间竞速，
  无事件超时自动换出口，流中断流如实报错——不再挂死，不重放已发内容。
- **哨兵双窗口**：连接期 2 秒严格判定死出口；隧道建立后等响应头放宽到
  10 秒，不再误杀慢首包的健康流。
- **上游 5xx 不再把出口打成 dead**：模型级 500 不再清空池子、导致全部流量
  静默直连；5xx 只计统计，恢复交给轮换逻辑。
- **准入冒烟补齐 session 伪装头**：上游现在强制要求（400
  MissingSessionID），修复前免费源候选全军覆没；修复后实测每轮可准入
  真实出口。
- **免费源池自动启用路由**：空池 refill 出首个出口的瞬间自动装上调度器，
  无需手动碰设置。
- **免费源 26 → 48 个**：全部逐个实测（200 + 可解析 + 当日有提交），
  每轮候选量 ~48k → ~84k。

## 0.2.7 (2026-09-05)

The IP-pool release (IP-0 … IP-7): exit pool with two-tier health and
sticky sessions, routing dispatcher + installer with R1 coexistence
deferral, subscription layer with sing-box conversion for encrypted nodes,
settings namespace with live reconfigure, passive health signals from real
traffic, full-scan coarse screening (300-wide fanout), adapter-layer rotate
retries, response-silence sentinel, probe-model dropdown, and refill
reservation gating.

## 0.2.6

Free-model catalog fixes: metadata deprecation outranks the free-name
fallback; marketplace entry at the installable repo root.
