<div align="center">

# dsh-plugin-adapter

**Free OpenCode Zen models, natively inside DSH (DeepSeek Harness).**

No API key. No registration. No extra process.

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue)](https://github.com/1624318455/dsh-plugin-adapter)

<div>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="license"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="Awesome"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-20%2B-blue" alt="node"></a>
  <a href="packages/plugin/test"><img src="https://img.shields.io/badge/tests-162%20passed-success" alt="tests"></a>
  <a href="https://github.com/1624318455/dsh-plugin-adapter"><img src="https://img.shields.io/github/stars/1624318455/dsh-plugin-adapter" alt="stars"></a>
  <a href="https://github.com/1624318455/dsh-plugin-adapter/commits/master"><img src="https://img.shields.io/github/last-commit/1624318455/dsh-plugin-adapter" alt="last commit"></a>
</div>

English | [简体中文](README.zh-CN.md)

</div>

---

opencode2dsh registers a native DSH `LlmAdapter` that streams directly from
[OpenCode Zen](https://opencode.ai/zen)'s **anonymous free lane** — the same
models OpenCode's own CLI uses without an account, served to your DSH model
picker as a regular provider called `opencode2dsh`.

Requests leave your machine looking exactly like traffic from the OpenCode
CLI (same user agent, same correlation headers), and the model catalog stays
fresh through a three-tier fallback chain. There is nothing to log into and
nothing to host.

## Highlights

- **Zero credential, zero setup** — the anonymous lane needs no key; install, restart, chat
- **Native adapter, no sidecar** — one npm package, no child process, no binary, no local port (the legacy Go sidecar is not part of the published package; see `legacy/`)
- **CLI-identical disguise** — requests carry the OpenCode CLI user agent and its session/request/project header set, derived per conversation
- **Selectable thinking levels** — reasoning-capable free models expose an effort picker in DSH's model selector (declared ladders where the model metadata provides them, Off/Minimal/Low/Medium/High otherwise); Off sends `reasoning_effort: "none"` upstream to actually stop thinking, and no selection keeps the provider default
- **Live catalog with a fallback chain** — live upstream list ∩ free-by-metadata, falling back to offline cache and a verified static list
- **Self-healing** — fast startup retries, periodic refresh, and a written health snapshot for diagnostics
- **Proper error surfaces** — upstream failures (rate limit, auth, timeout, transport) arrive in DSH as classified finish reasons, and retries stay owned by DSH

## Install

**From the plugin market** (recommended, once listed):
in DSH open **Settings → Plugin Market**, search `dsh-plugin-adapter`,
one-click install.

**From GitHub**:

```sh
dsh plugin --profile web add github:1624318455/dsh-plugin-adapter
```

**From npm**:

```sh
dsh plugin --profile web add @memef1f1y/dsh-plugin-adapter
```

**From source** (build the tarball yourself):

```sh
git clone https://github.com/1624318455/dsh-plugin-adapter.git
cd dsh-plugin-adapter/packages/plugin
pnpm install && pnpm pack
dsh plugin --profile web add ./memef1f1y-dsh-plugin-adapter-<version>.tgz
```

**Verify**: restart `dsh web`, open the model picker, and pick a model from
the **opencode2dsh** group.

Requires DSH (DeepSeek Harness) with a web profile; Node.js ≥ 20 (already
present if DSH runs); outbound HTTPS to `opencode.ai` and `models.dev`.

## Configuration

Defaults work out of the box. Override via the profile's `cordis.patch.yml`:

```yaml
- id: opencode2dsh
  name: '@opencode2dsh/dsh-plugin'
  config:
    mode: adapter        # adapter (default) | sidecar
    providerId: opencode2dsh
    refreshSeconds: 300  # catalog refresh cadence
```

| Option | Default | Description |
| --- | --- | --- |
| `mode` | `adapter` | `adapter`: native LlmAdapter streaming straight from Zen. `sidecar`: legacy local-agent mode, not bundled — build the agent from `legacy/agent` and pass `agentPath`. |
| `providerId` | `opencode2dsh` | Provider name shown in DSH. |
| `refreshSeconds` | `300` | Live catalog refresh interval. Pricing metadata refreshes every 24 h. |
| `agentPath` | auto-resolved | Sidecar only: path to the agent binary. |
| `agentArgs` | — | Sidecar only: extra CLI args for the agent. |
| `restartDelayMs` / `restartMaxDelayMs` / `maxConsecutiveCrashes` | `1000` / `60000` / `5` | Sidecar only: restart backoff and circuit breaker. |

## How it works

```
DSH session
   │  harness chunks (block-start / text-delta / usage / finish …)
   ▼
ZenAdapter (registered LlmAdapter)
   │  pi-ai openai-completions stream
   ▼
https://opencode.ai/zen/v1        ← Authorization: Bearer public
   with CLI-identical headers:
     user-agent: opencode/…
     x-opencode-client, x-opencode-session, x-session-affinity,
     X-Session-Id, x-opencode-request, x-opencode-project
```

- **Session correlation** — session/project ids are SHA-256 derived from the
  conversation's first user turn (stable per conversation, non-reversible),
  and each request gets a fresh random id, mirroring the CLI.
- **Catalog fallback chain** — S1: live `GET /v1/models`; S2: models.dev
  pricing metadata decides "free"; S3: a compile-time verified static list.
  A disk cache (~7-day TTL) covers upstream outages.
- **Resilience** — the adapter registers immediately at startup; if the first
  catalog fetch races your network (VPN/TUN reconnects, DNS), the plugin
  retries on a short cadence (~1 min) before settling into the periodic
  refresh.
- **Sidecar mode** (`mode: sidecar`, legacy) — spawns a local Go agent (a
  single-tenant port of [opencode2api](https://github.com/jasonxu114514/opencode2api))
  on `127.0.0.1:<random>`, token-authenticated, and registers a standard
  `llm-pi-ai` route. **Not part of the published package**; build it from
  `legacy/agent` (`go build ./cmd/agent`) and point `agentPath` at the binary.

## Gateway compatibility (Zen gate tracking)

Zen's free lane gates third-party clients and moves models between APIs
without notice. Two mechanisms matter here:

- **Canonical sessions (upstream)** — the gateway only serves
  `x-opencode-session` ids shaped `ses_<12 hex><14 base62>`; every identity
  is hashed into that shape, so plain DSH conversations pass with no setup.
- **Responses-only models (this fork)** — `muse-spark-*` return a bare 500 on
  `/chat/completions` but 200 on `/responses`. The adapter routes them to
  pi-ai `openai-responses` (wider 300 s body-idle watchdog for bursty
  reasoning); everything else stays on `openai-completions`.

## Health & troubleshooting

The plugin writes a health snapshot after every refresh round:

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

| Symptom | Likely cause & fix |
| --- | --- |
| Boot screen shows `Failed to load plugins … list slot "settings.plugin.item" requires options.id` | Your DSH is too old (≤ 0.1.0-rc.6): the settings-slot contract predates the plugin 0.3.0 browser half. Upgrade DSH to ≥ 0.1.0-rc.7 (latest recommended). Plugin ≥ 0.3.1 registers in either slot shape, so on old DSH you lose at most the settings card — model routing is unaffected. |
| Only 3 models | Startup fetch raced your network; retries land within ~1 min. Check `adapter-status.json` for `lastError`. |
| `lastError: "fetch failed"` persisting | Outbound HTTPS to `opencode.ai` blocked; check proxy/VPN rules. |
| Rate-limit errors in chat | The anonymous lane is quota-per-IP; switch network node or wait. |
| `500` on `muse-spark-*` via chat | Responses-only model; this fork routes it to `/responses` automatically. |
| `403 FreeTierError: free tier can only be used from within OpenCode` | Update past 0.3.2 (canonical sessions + gate-tools body shaping); non-streaming probes always 403 — diagnose with `stream:true`. |
| `stream body idle timeout` on reasoning models | Bursty chain-of-thought tripped the 120 s watchdog; this fork uses 300 s for Responses models. |
| Connection error to `127.0.0.1:*` | A stale sidecar route shadows the adapter; plugin ≥ 0.2.1 removes it at startup. |
| Install fails with `ERR_PNPM_IGNORED_BUILDS` | A transitive dependency of `pi-ai` (`@google/genai`, `protobufjs`) has build scripts that are not needed at runtime. Approve-or-decline them via the plugin market, or set both to `false` under `allowBuilds:` in the profile's `pnpm-workspace.yaml`. |

## Security

- No secrets involved: the anonymous lane's key is the literal string `public`; nothing is stored, nothing telemetry.
- Install paths restricted to `lib/` only; no build scripts run from dependencies.
- All requests go directly from your machine to `opencode.ai` / `models.dev`.

## Development

```sh
git clone https://github.com/1624318455/dsh-plugin-adapter.git
cd dsh-plugin-adapter/packages/plugin
pnpm install
pnpm typecheck && pnpm test
pnpm build                    # bundle to lib/
```

The legacy Go sidecar lives in `legacy/agent` (`go test ./...`). Architecture
notes and the porting record live in `docs/`.

Releasing: `pnpm pack` in `packages/plugin` (prepack builds and syncs docs).

## Acknowledgments

- [opencode2dsh](https://github.com/FishBottle7/opencode2dsh) by
  [FishBottle7](https://github.com/FishBottle7) — this project is a maintained
  fork of it; the adapter, catalog and IP-pool design originate there.
- [**opencode2api**](https://github.com/jasonxu114514/opencode2api) by
  [@jasonxu114514](https://github.com/jasonxu114514) — the legacy Go sidecar
  in `legacy/agent` is a port of its anonymous-lane implementation, and the
  catalog fallback chain and request-disguise details are derived from it.
  This project stands on its shoulders.
- [OpenCode](https://opencode.ai) — for running the free anonymous Zen lane.
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) — the wire layer used by adapter mode.
- [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) and the
  [dsh-market](https://github.com/dsh-market/dsh-market) community.

## Friends

<div align="center">

**[LinuxDo](https://linux.do)** — 新的理想型社区 / a new ideal community

</div>

## License

[MIT](./LICENSE) © FishBottle7
