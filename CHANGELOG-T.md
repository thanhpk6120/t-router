# T Router — Changelog

This changelog records all updates, enhancements, and releases specific to **T Router**.
Upstream changelogs (`CHANGELOG.md` and `CHANGELOG-PRO.md`) are kept intact for clean 3-way git merges from upstream repositories.

---

## v0.5.109-pro.10-t.3 (2026-10-24)

- Automated sync and release via Telegram Bot.



- **Upstream Sync**: Synchronized latest updates from upstream 9router (v0.5.109) and 9router-pro (v0.5.109-pro.10).
- **9Router-Pro.10 Integration**: Integrated Windowed-LRU in-memory overlay ($O(n)$ latency on ~18k keys), single-pass windowed LRU rotation tests, direct `provider/model` prompt injection architecture, and auto-normalization filters.
- **Skills Catalog**: Synchronized drop-in capability skills (`skills/`) for chat, image, video, TTS, STT, embeddings, web search, and web fetch.

### 🎨 Theme & Branding
- **Azure Brand Palette**: Transitioned from Aqua to a vibrant **Azure** theme (`#3B82F6` brand-500, `#1D4ED8` brand-700) across web dashboard, dark mode, and PWA manifest.
- **High-Definition Azure Icons**:
  - Re-rendered browser favicons (`favicon.svg`, `favicon.ico`, `src/app/icon.svg`).
  - Generated high-resolution multi-size Windows app icon (`cli/src/cli/tray/icon.ico` up to 256x256) and tray icon (`icon.png`).

### 🌐 Proxy Pools & Rotation for All Providers
- **Universal Provider Proxy Pools**: Extended Proxy Pool integration beyond OpenCode Free to **all providers** (OpenAI, Anthropic, Gemini, Groq, DeepSeek, Cursor, STT, Embeddings, and Custom Providers).
- **Automated Rotation**: Supports Single Proxy Pool, Round-Robin, and Uniform Random rotation across all active pools or a custom hand-picked pool subset.
- **Seamless Account Fallback**: Individual connection proxies take priority; unconfigured accounts automatically inherit provider-level rotating proxy pools.

### ⚙️ Routing Strategy & Settings Fixes
- **Round-Robin Toggle Fix**: Fixed an issue where the "Round Robin" routing strategy in the Settings menu (`/dashboard/profile`) could not be turned off (disabled). Toggling off now reliably switches back to the default "Balanced" strategy.

### 🔌 CLI Integrations & Packaging
- **Standardized CLI Integration**: Updated CLI configuration generators (Codex, JCode, OpenClaw, OpenCode, Copilot, Droid, Hermes, OMP, Crush) to use canonical `trouter` / `T-Router` and `sk_trouter`.
- **Dual API Compatibility**: API routes now return both `hasTRouter` and `has9Router` for 100% backward and forward compatibility.
- **Fixed Identifier Syntax**: Resolved invalid hyphenated JS identifier names across CLI settings endpoints.
- **NPM Package**: Published under canonical package name `t-router-proxy` with binary commands `t-router` and `t-router-proxy`.
- **Isolated Cache**: Migrated SQLite runtime cache paths to `~/.trouter/runtime`.

---

## v0.5.109-pro.9-t.1 (2026-10-25)

### 🚀 Initial Fork & Customization
- **Independent Product Identity**: Forked and rebranded to **T Router** (`t-router`).
- **Isolated Database**: Isolated SQLite database location to `~/.trouter/db/data.sqlite` (`%APPDATA%\trouter` on Windows) to prevent interference with other proxy services.
- **Default Port**: Configured default port to `20126` (allowing simultaneous side-by-side execution with 9router on 20128 and 9router-pro on 20127).
- **Default Password**: Set default dashboard password to `123456`, with login hint shown only when the password remains unchanged from default.
- **Zero External Telemetry**: Removed external author credits, Telegram links, and donation modals while preserving 9Remote and 9English.
