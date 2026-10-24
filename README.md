<div align="center">

# 🌐 T Router

**High-Performance AI Gateway & Prompt Injection Proxy**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![NPM Version](https://img.shields.io/npm/v/t-router-proxy?color=007FFF)](https://www.npmjs.com/package/t-router-proxy)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![Default Port](https://img.shields.io/badge/Port-20126-3B82F6)](http://localhost:20126)
[![Theme](https://img.shields.io/badge/Theme-Azure-3B82F6)](https://github.com/thanhpk6120/t-router)

One unified OpenAI & Anthropic-compatible endpoint for **40+ AI providers** and **100+ models**, featuring deep prompt injection, universal rotating proxy pools, token quotas, and self-healing multi-account fallback.

[Quick Start](#-quick-start) • [Key Highlights](#-key-highlights) • [CLI Tools](#-cli-tools-integration) • [Architecture](#-architecture) • [Configuration](#-configuration)

</div>

---

## ⚡ Key Highlights

### 🎯 Prompt Injection Engine
- **Three Scopes**: Inject prompts at **Global** (all requests), **Per API Key** (per user persona), or **Per Model** (customized model behaviors).
- **Two Flexible Modes**: Single system prompt (prepend or append), or a **scripted conversation history** (primes models significantly more effectively than system prompts alone).
- **Format-Aware Stacking**: Injections stack seamlessly (Global → Key → Model) across OpenAI, Anthropic Claude, Google Gemini, and Responses schemas.

### 🔄 Universal Proxy Pools & Smart Rotation
- **Proxy Support for ALL Providers**: Configure single or rotating proxy pools for OpenAI, Anthropic, Gemini, Groq, DeepSeek, Cursor, and custom providers.
- **Rotation Strategies**:
  - `Round-Robin`: Cycles sequentially through proxy endpoints per request.
  - `Random`: Uniform random distribution across available proxies.
  - `Subsets`: Pin rotation to a specific hand-picked list of active proxy pools.
- **Protocols Supported**: HTTP, HTTPS, SOCKS5, and Serverless Relay runners (Vercel, Cloudflare Workers, Deno Deploy, Netlify).

### 🛡️ Resilient Fleet & Balanced Fallback
- **Balanced LRU Account Fallback**: Health-tiered accounts (`clean` → `suspect` → `cooldown`), automatically routing requests through the healthiest and longest-rested accounts.
- **Anti-Flaky Guard**: Automatically detects truncated streams, empty bodies, and upstream errors, instantly retrying against the next available connection.
- **Mutual Exclusivity Fixes**: Easily toggle between **Balanced (Pro)**, **Round Robin**, and **Fill First** strategies in Settings.

### 💰 Token Quotas & Reselling Rate Limits
- **Rolling Token Budgets**: Enforce 24-hour, 7-day, or 30-day token budgets per API key with automatic HTTP 429 enforcement.
- **Fine-Grained Rate Limits**: Limit requests/minute (RPM), tokens/minute (TPM), requests/hour, requests/day, and maximum concurrent connections per client key.

### 🎨 Modern Azure Experience & Isolated Storage
- **Azure Visual Theme**: Default signature Azure palette (`#3B82F6` / `#1D4ED8`) with crisp vector icons, optimized dark mode, and customizable accent swatches.
- **Completely Isolated Database**: Stores all runtime data at `~/.trouter/db/data.sqlite` (`%APPDATA%\trouter` on Windows) on dedicated default port **`20126`**, completely preventing collisions with other running proxy servers.

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

> **Default Credentials:**
> - Dashboard URL: `http://localhost:20126`
> - Default Password: `123456` (You will be prompted to update it on first login)

---

## 🔌 CLI Tools Integration

T Router provides native, zero-friction integration for popular AI terminal and IDE tools. In the **CLI Tools** dashboard tab, copy one-click configuration commands or apply profiles automatically:

| Tool | Supported Endpoints | Config Command / Variable |
|---|---|---|
| **Claude Code** | Anthropic Messages | `ANTHROPIC_BASE_URL="http://localhost:20126"` |
| **Cursor** | OpenAI / Claude | Base URL: `http://localhost:20126/v1` |
| **Codex CLI** | OpenAI Compatible | `trouter` provider profile |
| **OpenCode** | OpenAI Compatible | `trouter` provider profile |
| **OpenClaw** | OpenAI / Anthropic | Gateway URL: `http://localhost:20126/v1` |
| **GitHub Copilot** | MITM / Custom Provider | In-dashboard Copilot hook generator |
| **Hermes Agent** | OpenAI / Anthropic / STT | `hermes config` with `trouter` endpoint |
| **OMP & Crush** | OpenAI Compatible | Custom model endpoints on `20126` |

*Note: All CLI endpoints remain fully backward-compatible with legacy `9router` configs while prioritizing canonical `trouter`.*

---

## 🏗️ Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                          Clients                                │
│    Claude Code • Cursor • Codex • OpenCode • REST API Tools     │
└───────────────────────────────┬─────────────────────────────────┘
                                │ HTTP / SSE (Port 20126)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                           T Router                              │
│                                                                 │
│  ┌────────────────────┐  ┌──────────────────┐  ┌─────────────┐  │
│  │   Auth & Quotas    │  │  Prompt Inject   │  │ Model Map   │  │
│  │ RateLimit/429/Keys │  │ Global/User/Mod  │  │ Combos/Caps │  │
│  └─────────┬──────────┘  └────────┬─────────┘  └──────┬──────┘  │
│            │                      │                   │         │
│            ▼                      ▼                   ▼         │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │        Fleet Account Fallback & Health-Tier Router        │  │
│  │            Balanced LRU • Anti-Flaky Guard                │  │
│  └────────────────────────────┬──────────────────────────────┘  │
│                               │                                 │
│                               ▼                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │             Universal Proxy Pool & Rotator                │  │
│  │        Round-Robin • Random • Subsets • Relay             │  │
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

- `~/.trouter/` — Root data directory for SQLite database, runtime logs, and cache.
- `src/app/` — Next.js 16 App Router dashboard and REST API routes.
- `src/sse/` — Streaming server engine and proxy adapter handlers.
- `src/lib/network/connectionProxy.js` — Core proxy resolution, pool mapping, and rotation algorithms.
- `cli/` — Standalone CLI package (`t-router-proxy`) with system tray and background process manager.
- `CHANGELOG-T.md` — Dedicated release history for all T Router updates.

---

## 📄 License

This project is open-source under the [MIT License](LICENSE).
T Router builds upon the foundations of 9Router and 9Router-Pro with independent extensions, isolated runtime environments, and unique branding.
