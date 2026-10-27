# T Router — Changelog

This changelog records all updates, enhancements, and releases specific to **T Router**.
Upstream changelogs (`CHANGELOG.md` and `CHANGELOG-PRO.md`) are kept intact for clean 3-way git merges from upstream repositories.

---

## v0.5.111-pro.14-t.2 (2026-10-27)

- **Provider Toggle & OpenCode Free Fixes**:
  - **Instant & Reliable Provider Disable/Enable**: Fixed provider toggle switch in `src/app/(dashboard)/dashboard/providers/page.js` by isolating event propagation in `Toggle.js`, wiring direct boolean change handlers, and re-fetching server summary state after `PATCH /api/providers` to prevent state drift or requiring multiple clicks/reloads.
  - **OpenCode Free Toggle Support**: Added toggle disable/enable support for OpenCode Free (`opencode`) and other `noAuth` providers. Fixed `FREE_PROVIDERS` import in `src/app/api/providers/route.js` and registered `opencode` across all authType queries in `connectionsRepo.js` and `dualAuthTypes`.
- **Simplified & Reliable Update Workflow**:
  - Replaced the brittle in-process 1-click detached auto-updater with an informative, clean Update Instructions Modal featuring instant command copying (`npm i -g t-router-proxy@latest`), copy feedback, and concise environment instructions (NPM Global, systemd, Git).

---

## Upstream Sync (9router 0.5.111, 9router-pro 0.5.109-pro.14) (2026-10-27)

- **Automation Menu**:
  - **Outbound Notifications**: Added configurable Telegram bot and generic webhook alerts with HMAC signature verification (`X-TRouter-Signature` and `X-9Router-Signature`) for silent automated tasks such as scheduled backup success and failure.
  - **Response Cache**: Exact replay cache for non-streaming chat completions (opt-in, tools/streaming bypassed, bounded LRU/TTL).
  - **Two-Factor Authentication (TOTP)**: Added RFC 6238 TOTP two-factor authentication for password dashboard login with secure backup code generation and consumption.
  - **Database Maintenance**: Scheduled daily maintenance to prune historical per-request logs and expired cache rows while preserving daily usage aggregates and optimizing space.
- **Performance & Usability Enhancements**:
  - **Latency Statistics Card**: Integrated TTFT and total latency percentile stats (p50/p95) into the Usage dashboard.
  - **Concurrent Bulk Key Import**: Sped up bulk API key addition using a bounded 6-worker pool with pre-planned unique collision-free naming.
  - **Capacity Adapter Variant Resolution**: Extended capability checks and context-window stripping for custom model variants by resolving backing models.
  - **Schema Migration & Safety**: Bumped schema to version 3 with safety backups and verified test coverage.

---

## v0.5.111-pro.14-t.1 (2026-10-27)

- Automated sync and release via Telegram Bot.

## v0.5.111-pro.13-t.7 (2026-10-26)

- **Fix: "Cannot create property 'finishReasonSent' on string 'claude-sonnet-5'"**:
  - **Resolved Translator Registration Signature Collision**: In `open-sse/translator/index.js`, `register` expects `(from, to, requestFn, responseFn)`. Fixed the argument order in `response/claude-to-openai.js` and `response/gemini-to-openai.js` where flush functions were inadvertently registered as `requestFn`, which overwrote the inbound Claude/Gemini request translator and received the model string as its first argument.
  - **Standardized In-Stream Flush on `!chunk`**: Consolidated terminal turn synthesis directly inside `claudeToOpenAIResponse` and `geminiToOpenAIResponse` when `!chunk` is passed, safely validating `typeof state === "object"` before accessing state fields.

---

## v0.5.111-pro.13-t.6 (2026-10-26)

- **Fix: "OpenAI completions stream closed before a finish_reason was received"**:
  - **Guaranteed Terminal Finish Chunks**: Enforced `openAIFinishReasonSeen` tracking in `open-sse/utils/stream.js`. When any SSE stream to an OpenAI client concludes (in both passthrough and translate modes, or upon unexpected upstream EOF), automatically synthesize a fallback chunk with `finish_reason: "stop"` (or `"tool_calls"`) and ensure the trailing `data: [DONE]\n\n` sentinel is always dispatched before closing the controller.
  - **Gemini & Claude Response Flush Handlers**: Implemented and registered `geminiToOpenAIFlush` and `claudeToOpenAIFlush` in `open-sse/translator/response/gemini-to-openai.js` and `claude-to-openai.js`, preventing truncated turns when upstream models emit tool calls or finish without an explicit `finishReason` candidate.
  - **Stream Abort Error Framing**: Enhanced `buildStreamErrorBytes` to include a proper OpenAI-compatible choice with `finish_reason: "stop"` alongside error payloads so downstream client SDKs gracefully process error notices instead of throwing unhandled premature stream close exceptions.

---

## v0.5.111-pro.13-t.5 (2026-10-26)

- **Release on NPM**: Published `t-router-proxy@0.5.111-pro.13-t.5` to npmjs registry with latest tag.

---

## v0.5.111-pro.13-t.4 (2026-10-26)

- **Robust Release Pipeline & Telegram Integration**:
  - Upgraded release execution with `--ignore-scripts` on `npm publish` and 50MB process buffer to ensure fast, zero-timeout tarball upload to npmjs.
  - Added automatic resolution for staged version conflicts (HTTP 409) with automated version bumping.
  - Optimized error extraction so Telegram failure notifications show concise diagnostic logs.

---

## v0.5.111-pro.13-t.3 (2026-10-26)

- **Session Lockout Fix (401 Unauthorized) on Require Login / Password Update**:
  - Automatically issue and renew the dashboard `auth_token` cookie directly in `PATCH /api/settings` when enabling `requireLogin` or updating the password, eliminating 401 Unauthorized session lockouts and unclickable button states.
- **Streamlined Single-Input Password Form in Settings**:
  - Simplified the password change form in Settings to a single input field (with an immediate Set / Update Password action) without requiring legacy password fields or redundant confirmation inputs.
  - Removed `disabled={loading}` on the `Require login` toggle so users can interact with it immediately upon page load without freezing.
- **CLI Version Comparison & Update Detection (`cli/cli.js`)**:
  - Updated `compareVersions` and `parseVersion` in the CLI to support the `-pro.X-t.Y` suffix convention, ensuring CLI `checkForUpdate()` correctly detects newer versions from npmjs.
  - Comprehensive process detection matching running instances of `t-router`, `trouter`, and legacy `9router` for clean process termination and restarts.

---

## v0.5.111-pro.13-t.2 (2026-10-26)

- **Version Notification & One-Click Upgrade Engine**:
  - Resolved version check queries to target the official npm registry (`https://registry.npmjs.org/t-router-proxy/latest`) with fast response and reliable fallbacks.
  - Standardized 3-tier version comparator supporting upstream base (`major.minor.patch`), upstream pro (`pro.X`), and internal release (`t.Y`).
  - Added new version notification badges on the Sidebar and introduced a dedicated **Version & Updates** card on the Settings page.
  - Provided dual update modes: **1-Click Auto Update** with automatic reload upon server restart, and **Manual Update** with copy-ready command `npm i -g t-router-proxy@latest`.
- **Require Login Default & Password Management**:
  - Enabled `Require login` by default (`true`) across all configuration layers (DB defaults, client state, and API routes).
  - Ensured the password change form is always directly visible in Settings rather than conditionally hidden behind toggle states.
  - Allowed first-time users to set their password immediately without entering the default `123456`.
  - Automatically synchronized `hasPassword: true` state upon successful password changes.

---

## Upstream Sync (9router 0.5.111, 9router-pro 0.5.109-pro.13)

- **Upstream 9Router v0.5.111 Synchronization**:
  - **Ollama Local TTS (Phonon)**: Added `ollama-local` TTS provider supporting Phonon model families (15 tags, 38 preset voices), standardized audio format conversion to WAV/PCM, automatic fallbacks, and raw PCM encapsulation into standard WAV headers for dashboard audio previews.
  - **Ollama Local Embeddings**: Added embedding adapter for `/v1/embeddings`, auto-normalized host URLs, Bearer token authorization with API keys, and cataloged 14 embedding model families with dimensions.
  - **New Provider Runcrate (`rc`)**: Supported Runcrate OpenAI-compatible endpoint with DeepSeek, GLM, Qwen, and gpt-oss models; balance authenticated via `GET /api/v1/billing/balance`.
  - **CommandCode & OpenCode Go**: Added Kimi K3.1 Pro to catalog (retaining upstream model ID, NDJSON `/alpha/generate` streaming, vision/video support, 1M context window, and 131k output tokens).
  - **OpenCode Free Tier & TLS Fingerprint**: Restored OpenCode free tier connectivity by sending genuine TLS ClientHello fingerprints (via `wreq-js`, fail-open to native fetch) and in-place session/fingerprint tool definition normalization.
  - **Claude Translator & Headroom**: Automatically converted `image_url` within tool messages to native Claude image blocks; optimized RTK Headroom for Claude to preserve native PDFs, signed thinking, and tool history.
  - **CLI Tools (Pi Settings)**: Added configurable `contextWindow` and `maxTokens` per Pi model while preserving custom user-defined model names in `models.json`.
- **Preserved 100% T-Router Constraints**:
  - Preserved primary brand theme Azure (`#3B82F6` / `#1D4ED8`) and Azure T icons.
  - Preserved database location at `~/.trouter/db/data.sqlite` and data directory `~/.trouter`.
  - Maintained default listening port `20126`.
  - Zero external author telemetry, credits, Telegram links, or donation modals.
  - Preserved Universal Proxy Pools & Rotation for all providers, including Direct proxy guard, `rotateLink` (Dynamic IP Rotation), Rotate IP button, Proxy Source (`both`/`static`/`rotating`), auto-rotate on 429/403/cooldown, and shorthand parsers.
  - Ensured Round Robin routing strategy in Settings can be toggled on/off reliably.

---

## Upstream Sync (9router 0.5.109, 9router-pro 0.5.109-pro.13)

- **Upstream 9Router Pro v0.5.109-pro.13 Synchronization**:
  - **Sticky-random routing**: Added a new account routing strategy — stick to an active API key until rate-limited or in error (429/403/cooldown), then randomly pick another available key to maximize prompt-cache retention.
  - **Variant Backing AUTO Resolution**: Automatically resolved custom provider alias prefixes to routable node IDs on variant save, combo save, and backup import (eliminating 404-alias runtime errors).
  - **Variant Prompt Injection for Combo Members**: Supported prompt injection workflows for variants when acting as members of a Combo, ensuring variant-specific prompts trigger correctly even when routed via combos.
  - **Friendly Backing Labels**: Displayed readable `<prefix>/<model>` labels instead of internal UUIDs across all UI components (combo cards, edit forms, model picker modals, prompt injection pages); ignored 404 requests for custom provider node icons.
  - **Optimized Provider/Combo Rendering**: Memoized active provider IDs to accelerate status checks and provide instant rendering.
  - **Auto-Detection of Search Capability for Combos**: Automatically routed to search-capable models when incoming requests included search/fetch tool definitions (`web_search`, `web_fetch`).
  - **NDJSON Stream Support & Text Parts Collapsing**: Automatically parsed raw JSON lines in SSE streams and collapsed text parts into simple strings for strict OpenAI-compatible endpoints.
  - **Fuzzy Token Fallback for Cursor Auto-Import**: Performed fuzzy scans for tokens and machine IDs if Cursor updated internal storage keys across versions.
- **Preserved 100% T-Router Constraints**:
  - Preserved primary brand theme Azure (`#3B82F6` / `#1D4ED8`) and Azure T icons.
  - Preserved database location at `~/.trouter/db/data.sqlite` and data directory `~/.trouter`.
  - Maintained default listening port `20126`.
  - Ensured Round Robin routing strategy in Settings can be toggled on/off reliably.
  - Preserved Universal Proxy Pools & Rotation for all providers.

---

## Upstream Sync (9router 0.5.109, 9router-pro 0.5.109-pro.12)

- **Upstream 9Router Pro v0.5.109-pro.12 Synchronization**:
  - Integrated slim npm distribution packaging patch from upstream 9router-pro v0.5.109-pro.12.
  - Maintained variant-based prompt injection, fixed prompt injection crash, and optimized proxy pool pagination.
  - Preserved Universal Proxy Pools & Rotation, port 20126, path `~/.trouter`, and Azure theme (#3B82F6).
- **Variant-Based Prompt Injection**:
  - Transitioned prompt injection to variant-based mechanisms: prompts bind to custom variant names rather than raw underlying models.
  - A variant links an alias name with exactly one underlying provider/model and injected prompt. Calling by variant name applies the prompt; calling by raw model name remains untouched.
  - Automatically created and synchronized corresponding single-member combos for each variant.
  - Migrated legacy model-based prompt injection configurations to variants on initial read.
- **Prompt Injection Crash Fix**:
  - Removed dangling UI copy-to-providers code blocks that caused complete page crashes during browser rendering.
- **Proxy Pools Pagination & Filtering**:
  - Added server-side pagination (pageSize 10, 20, 50) and name search (`search`), optimizing performance and memory footprint when managing large proxy pool collections.
  - Supported per-page selection with cross-page preservation for bulk operations.
  - 100% compatible with T Router's Universal Proxy Pools & Rotation.

---

## v0.5.111-pro.13-t.1 (2026-10-26)

- Automated sync and release via Telegram Bot.

## v0.5.109-pro.13-t.1 (2026-10-26)

- **Antigravity / Gemini Multi-turn Function Calling & System Instruction Loss Fix**:
  - Full support for `role: "developer"` (OMP, Codex) in Gemini/Antigravity request translation (`openaiToGeminiRequest`), preventing loss of core agent system instructions.
  - Accumulated all `system` and `developer` messages into `systemInstruction.parts` instead of overwriting earlier instructions.
  - Fixed `thoughtSignatureStore.js`: allowed reusing `thoughtSignature` strictly by `toolCallId` regardless of model aliases (preventing multi-turn tool call failures when mapping `claude-sonnet-5` to Gemini).
  - Automatically detected and extracted leaked tool call syntax (`call:default_api:...`) in Gemini stream responses and converted them back to standard OpenAI `tool_calls` deltas with `finish_reason: "tool_calls"`.

## v0.5.109-pro.12-t.8 (2026-10-26)

- **Proxy Direct Guard Condition Refinement**:
  - Applied direct IP fallback prevention strictly when a provider explicitly opts into proxies (via Proxy Pool, Rotation Strategy, or connection proxy).
  - Providers without proxy configuration route directly as normal (even if the 'Direct' pool in Proxy Pools is toggled inactive).
  - Ensured complete IP leak protection for proxy-enabled connections without impacting direct-routing providers.

## v0.5.109-pro.12-t.6 (2026-10-26)

- **Fixed Direct Proxy in Proxy Pools & No Direct IP Leaks**:
  - Proxy Pools always maintains a default "Direct" entry representing direct connections without proxies.
  - Allowed users to deactivate the "Direct" pool to strictly forbid fallback to host network when active proxies fail or are rate-limited.
  - Rejected requests with an explicit error when Direct is disabled and proxies fail, safeguarding server IP anonymity.
- **OpenCode Free Active Toggle**:
  - Added an active toggle switch for OpenCode Free provider matching other standard providers.
  - When disabled, OpenCode Free appears dimmed at 50% opacity and is excluded from `/v1/models`.
- **Synchronized Rotation Strategies & Proxy Settings for All Providers**:
  - Extended all rotation strategies (None, Round-robin, Random, Fallback Priority) to every provider.
  - Provided consistent Proxy Pool & Rotation UI across all provider detail views.
- **Dynamic Tool Gating & Protobuf Schema Sanitization**:
  - Automatically compressed and pruned MCP tools exceeding 64 tools, preserving 100% Core Tools and Context Tools.
  - Sanitized nested JSON Schemas to prevent Google Gemini Protobuf validation errors and eliminate silent retry loops in Claude Code CLI.

---

## v0.5.109-pro.12-t.5 (2026-10-25)

- **Advanced Proxy Management & Dynamic IP Rotation (aligned with opencode2api)**:
  - **Rotate Link & Dynamic IP Rotation**: Full support for `rotateLink` (IP rotation webhook URL) in Proxy Pools UI (create, edit, batch import).
  - **Rotate IP Button**: Instantly trigger IP rotation per pool or in bulk from the dashboard with notification feedback and last-rotated timestamps.
  - **Proxy Source Selection**: Added proxy source filter (`both` | `static` | `rotating`) in provider rotation settings.
  - **Auto-Rotate on 429/403/Error**: Automatically invoked rotate link on rate limits (429) or IP blocks (403), with a 60-second cooldown to prevent API spam.
  - **Socket Cache Eviction on IP Rotation**: Evicted and closed stale keep-alive connections in `proxyDispatchers` immediately upon IP rotation, ensuring subsequent requests use the fresh outbound IP.
  - **Auto-Rotate on Schedule**: Periodically rotated IPs for dynamic proxy pools with timestamps older than 30 minutes.
  - **Comprehensive Shorthand Parsing**: Supported `host:port`, `host:port:user:pass`, `host:port:user:pass|rotateLink`, `host:port|rotateLink`, SOCKS5, and standard proxy URLs.

## v0.5.109-pro.12-t.4 (2026-10-25)

- Monotonic +1 version bump: upgraded to 0.5.109-pro.12-t.4 aligned with latest upstream 9router-pro.12.

## v0.5.109-pro.12-t.1 (2026-10-25)

- Automated sync and release via Telegram Bot.

## v0.5.109-pro.10-t.3 (2026-10-24)

- Automated sync and release via Telegram Bot.

## v0.5.109-pro.10-t.1 (2026-10-24)

- **Upstream Sync**: Synchronized latest updates from upstream 9router (v0.5.109) and 9router-pro (v0.5.109-pro.10).
- **9Router-Pro.10 Integration**: Integrated Windowed-LRU in-memory overlay ($O(n)$ latency on ~18k keys), single-pass windowed LRU rotation tests, direct `provider/model` prompt injection architecture, and auto-normalization filters.
- **Skills Catalog**: Synchronized drop-in capability skills (`skills/`) for chat, image, video, TTS, STT, embeddings, web search, and web fetch.
- **Usage Observability Endpoints**: Added `/api/usage/history` and `/api/usage/request-logs` endpoints from 9router 0.5.109.

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
