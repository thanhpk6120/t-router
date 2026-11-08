<div align="center">

# 🌐 T Router

**Enterprise-Grade AI Gateway & Multi-Provider Prompt Engineering Router**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![NPM Version](https://img.shields.io/npm/v/t-router-proxy?color=007FFF)](https://www.npmjs.com/package/t-router-proxy)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![Default Port](https://img.shields.io/badge/Port-20126-3B82F6)](http://localhost:20126)
[![Theme](https://img.shields.io/badge/Theme-Azure-3B82F6)](https://github.com/thanhpk6120/t-router)

One unified OpenAI & Anthropic-compatible routing engine for **40+ AI providers** and **100+ models**, featuring deep multi-rule prompt injection, universal rotating proxy pools, granular model enforcement, maximum prompt caching optimization, token budgets, and self-healing multi-account fallback.

[English](README.md) • [Tiếng Việt](README-vi.md) • [Quick Start](#-quick-start) • [Feature Comparison](#-detailed-comparison-t-router-vs-9router-vs-9router-pro) • [Key Highlights](#-key-highlights) • [CLI Tools](#-cli-tools-integration) • [Architecture](#-architecture)

</div>

---

## 📊 Detailed Comparison: T Router vs. 9Router vs. 9Router Pro

T Router was engineered to solve real-world enterprise gateway challenges, multi-user prompt injection, and reliable proxy routing that neither upstream 9Router nor 9Router Pro address.

| Capability / Dimension | 9Router (Upstream) | 9Router Pro | 🌐 T Router (This Project) |
|---|---|---|---|
| **Primary Focus** | Minimalist AI model proxy & protocol translation | Single-target prompt injection & reselling token limits | **Enterprise AI Gateway, Multi-Rule Prompt Engine & Robust Proxy Routing** |
| **Prompt Injection Rules** | ❌ None (No prompt injection support) | ⚠️ Single injection per target (1 Global, 1 Per Key, 1 Per Model) | **✅ Unlimited multi-target Rules + multi-model & multi-key targeting + live priority stack** |
| **Prompt Injection Stacking** | ❌ None | ⚠️ Fixed 3-layer order (Global → Key → Model) | **✅ Dynamic rule precedence with Variant backing model resolution & Stack Preview** |
| **Disabled Models Enforcement** | ⚠️ Partial (Disabled models still accessible via direct API or combos) | ⚠️ Only visual list separation (chips remain callable) | **✅ Multi-tier enforcement: API 404, auto-sanitized from combos, hidden in catalog & capabilities** |
| **Prompt Caching Optimization** | ⚠️ Passive (Relies on upstream provider defaults) | ⚠️ Passive (Claude caching limited to native tools) | **✅ Aggressive 4-breakpoint Claude caching across OpenAI clients + automated provider prefix alignment** |
| **Stream Truncation Protection** | ❌ Prone to premature SSE truncation | ⚠️ Basic anti-empty retry (often trips on Gemini/Antigravity) | **✅ Antigravity/Gemini wrapper SSE parsing in `emptyFailover` + fail-safe completion guards** |
| **Proxy Architecture** | ⚠️ Simple proxy support | ⚠️ Health checks & subset rotation | **✅ Universal Proxy Pools: Per-connection override, Dynamic IP Rotation (`rotateLink`), Exit IP detection** |
| **Runtime & Data Isolation** | Port `20126`, shared default config paths | Port `20126`, standard config paths | **✅ Dedicated isolated SQLite database (`~/.trouter/db/data.sqlite`) & zero-collision runtime** |
| **Dashboard & Visual Identity** | Standard dark theme | Dark neumorphism glass theme | **✅ Custom Azure Blue theme (`#3B82F6`/`#1D4ED8`), 50/50 balanced usage view, high-DPI icons** |
| **Combo Testing & Diagnostics** | ❌ None | ❌ None | **✅ Live Combo Diagnostic Modal: non-intrusive `peekRotatedModels()`, latency & disabled badges** |
| **Catalog Persistence** | ❌ Live upstream query on every page load | ❌ Live query on every page load | **✅ Local database catalog cache (`loadedModels`), instantaneous load times & on-demand refresh** |
| **Security & Hardening** | Basic sanitization | Standard sanitization | **✅ SSRF protection on proxy probes, header anti-spoofing, credential redaction & DOMPurify XSS guards** |

---

## ⚡ Key Highlights

### 🎯 Advanced Multi-Rule Prompt Injection Engine
- **Multi-Target Granular Rules**: Unlike 9Router Pro which restricts you to a single injection per target, T Router allows you to define arbitrary numbers of rules targeting specific combinations of models and API keys simultaneously.
- **Dynamic Stack Precedence**: Compose and re-order system prompts (prepend/append) and scripted conversations (fake history). Backing model resolution ensures variant models accurately inherit rules.
- **Detailed Stack Preview & Fire Stats**: Inspect the resolved injection stack before sending traffic and track per-model, per-rule execution telemetry in real time.

### 🛡️ Enterprise-Grade Disabled Models Enforcement
- **Multi-Tier Protection**: When a model is disabled, it is strictly unreachable across the entire gateway.
- **Combo Auto-Sanitization**: Combos automatically filter out disabled member models on the fly. If all members in a combo are disabled, the gateway fails gracefully with HTTP 404 rather than routing to broken upstreams.
- **Catalog & Capabilities Masking**: Disabled models are omitted from `/v1/models`, model info endpoints, and capability aggregations.

### ⚡ Maximum Prompt Caching & Stream Resilience
- **Full Claude 4-Breakpoint Caching**: Automatically calculates and injects cache breakpoints (system 1h, tools 1h, assistant turn 5m, tool results 5m) for all Claude models, even when requests originate from OpenAI-compatible tools (DSH, Cursor, Cline).
- **Vendor-Accurate Prefix Caching**: Calibrated for OpenAI, DeepSeek, Google Gemini / Antigravity, and Codex according to official vendor specifications.
- **Premature Stream Truncation Fix**: Deep parsing of SSE chunk wrappers prevents false-positive empty stream failovers on Antigravity and Gemini.

### 🔄 Universal Proxy Pools & Dynamic IP Rotation
- **Proxy Support Across All 40+ Providers**: Configure HTTP, HTTPS, SOCKS5, or Serverless Relays per provider or per connection.
- **Dynamic IP Rotation**: Integrates `rotateLink` endpoints for automated external IP refresh, alongside one-click manual IP rotation directly from the dashboard.
- **Live Exit IP Detection**: Verifies what remote servers actually observe through the proxy pool via real-time external IP probes (`probeExitIp`).

### 🎨 Modern Azure Experience & Isolated Storage
- **Signature Azure Theme**: Designed with an Azure palette (`#3B82F6` / `#1D4ED8`), responsive layout, and an optimized 50/50 split usage analytics dashboard.
- **Zero-Collision Local Storage**: Dedicated isolated SQLite database at `~/.trouter/db/data.sqlite` running on port **`20126`**.

---

## 🚀 Quick Start

### Option 1: Global CLI (Recommended)

Install globally via npm and start with a single command:

```bash
# Install the package globally
npm install -g t-router-proxy

# Launch T Router (opens dashboard at http://localhost:20126)
t-router
```

Or run directly without installing:

```bash
npx t-router-proxy
```

### Option 2: Run from Source

```bash
# Clone repository
git clone https://github.com/thanhpk6120/t-router.git
cd t-router

# Install dependencies
npm install

# Start development server
npm run dev

# Or build and start standalone server
npm run build
npm start
```

### Option 3: Docker Container

```bash
docker build -t t-router .
docker run -d \
  -p 20126:20126 \
  -v ~/.trouter:/root/.trouter \
  --name t-router \
  t-router
```

> **Default Access:**
> - Dashboard URL: `http://localhost:20126`
> - Default Password: `123456` (You will be prompted to update it on first login)

---

## 🔌 CLI Tools Integration

T Router provides native integration for all modern AI coding assistants and IDEs:

| Tool | Supported Endpoints | Configuration Command / Environment Variable |
|---|---|---|
| **Claude Code** | Anthropic Messages | `ANTHROPIC_BASE_URL="http://localhost:20126"` |
| **Cursor** | OpenAI / Claude | Base URL: `http://localhost:20126/v1` |
| **Codex CLI** | OpenAI Compatible | `trouter` provider profile |
| **OpenCode** | OpenAI Compatible | `trouter` provider profile |
| **OpenClaw** | OpenAI / Anthropic | Gateway URL: `http://localhost:20126/v1` |
| **GitHub Copilot** | MITM / Custom Provider | Native dashboard Copilot hook generator |
| **Hermes Agent** | OpenAI / Anthropic / STT | `hermes config` with `trouter` endpoint |

---

## 🏗️ Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                          Clients                                │
│    Claude Code • Cursor • Codex • OpenCode • DSH • REST Clients │
└───────────────────────────────┬─────────────────────────────────┘
                                │ HTTP / SSE (Port 20126)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                           T Router                              │
│                                                                 │
│  ┌────────────────────┐  ┌──────────────────┐  ┌─────────────┐  │
│  │   Auth & Quotas    │  │  Multi-Rule      │  │ Model Map   │  │
│  │ RateLimit/429/Keys │  │  Prompt Inject   │  │ Combos/Caps │  │
│  └─────────┬──────────┘  └────────┬─────────┘  └──────┬──────┘  │
│            │                      │                   │         │
│            ▼                      ▼                   ▼         │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │       Disabled Models Multi-Tier Guard & Sanitizer        │  │
│  │           API 404 • Combo Filter • Catalog Pruning        │  │
│  └────────────────────────────┬──────────────────────────────┘  │
│                               │                                 │
│                               ▼                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │      Fleet Account Fallback & Anti-Truncation Router      │  │
│  │        Balanced LRU • Anti-Flaky • Cache Breakpoints      │  │
│  └────────────────────────────┬──────────────────────────────┘  │
│                               │                                 │
│                               ▼                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │      Universal Proxy Pool, Dynamic Rotation & Exit IP     │  │
│  │       Round-Robin • Random • rotateLink • SOCKS/HTTP      │  │
│  └────────────────────────────┬──────────────────────────────┘  │
└───────────────────────────────┼─────────────────────────────────┘
                                │ Upstream Requests
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                       AI Model Providers                        │
│   Anthropic • OpenAI • Google Gemini • DeepSeek • Groq • etc.   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📂 Workspace & File Layout

- `~/.trouter/` — Isolated data directory for SQLite database, runtime logs, and cache.
- `src/app/` — Next.js App Router dashboard and REST API endpoints.
- `src/sse/` — Streaming server engine, combo dispatchers, and prompt injection filters.
- `open-sse/` — Provider-agnostic routing, translators, and executor adapters.
- `cli/` — Standalone CLI package (`t-router-proxy`) with system tray and process management.
- `CHANGELOG-T.md` — Dedicated release history for all T Router updates.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
T Router builds upon the foundations of 9Router and 9Router-Pro with independent architectural enhancements, isolated runtimes, and enterprise features.
