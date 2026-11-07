# T Router — Changelog

This changelog records all updates, enhancements, and releases specific to **T Router**.
Upstream changelogs (`CHANGELOG.md` and `CHANGELOG-PRO.md`) are kept intact for clean 3-way git merges from upstream repositories.

---

## 0.5.112-pro.23-t.3 (2026-11-08)

- **Vá lỗi và Tối ưu hóa Toàn diện Prompt Injection Engine**:
  - `src/lib/db/repos/promptInjectStatsRepo.js`: sửa lỗi `TypeError: keyModelNames.has is not a function` khi nhận `keyModelNames` là Array từ `chat.js`, giúp việc ghi nhận thống kê (fire stats) của các injection dạng per-model (`byKeyModel`) hoạt động trơn tru. Bổ sung hỗ trợ phân loại thống kê cho cả Rules (`scope: "rule"`, `ruleId`).
  - `src/lib/db/repos/promptInjectRepo.js`: đính kèm metadata `scope` và `ruleId` cho từng entry trong stack của `selectPromptInjectionsDetailed`.
  - `src/app/api/prompt-injection/route.js`: hỗ trợ RESTful DELETE cho global injection (`DELETE /api/prompt-injection?global=1`).
  - `src/app/api/prompt-injection/route.js`: đồng bộ Stack Preview cho Variant bằng cách phân giải backing model (`resolvedModel`, `bareModel`), giúp hiển thị chính xác các Rule nhắm vào backing model đồng nhất với runtime chat (`chat.js`).
  - `tests/unit/prompt-inject-audit.test.js`: bổ sung bộ test suite toàn diện 20 test cases cho Prompt Injection Engine (classify, select, variants, sampling overrides, wire injections, CRUD repos, API endpoints), chạy cô lập hoàn toàn trong thư mục tạm.
- **Bảo mật và Khắc phục Lỗi Hệ thống**:
  - `custom-server.js`: lọc bỏ các header nội bộ giả mạo từ bên ngoài (`x-allow-disabled`, `x-9r-cli-token`).
  - `src/lib/network/proxyTest.js`: vá triệt để lỗ hổng SSRF khi kiểm tra proxy, chặn đứng mọi request trỏ tới loopback/link-local/metadata IP.
  - `src/lib/providerConnectionResponse.js`: che giấu bảo mật proxy credentials (`username:password`) và các token nhạy cảm trước khi trả về client.
  - `scripts/t-router-publisher.js` & `server-monitor-bot-index.js`: kiểm tra định dạng và sanitize nghiêm ngặt ngăn chặn Command Injection / RCE.
  - `src/shared/components/ChangelogModal.js`: lọc DOM XSS qua `DOMPurify.sanitize` trước khi render markdown.
  - `open-sse/services/emptyFailover.js`: khắc phục lỗi Anti-Empty Guard chặn nhầm failover khi upstream stream rỗng.
  - `open-sse/utils/proxyFetch.js`: ngăn ngừa đệ quy vô hạn `RangeError: Maximum call stack size exceeded`.
  - `src/sse/services/model.js`: loại bỏ hoàn toàn N+1 database queries khi kiểm tra model disabled.
  - Cấp 8GB heap memory Node.js (`--max-old-space-size=8192`) trong `package.json`, `cli/scripts/build-cli.js` và `sync-and-upgrade.sh` chống tràn RAM khi compile Webpack.
  - `.github/workflows/ci.yml`: tạo CI workflow chuẩn tự động chạy lint, build và full test suite trên GitHub Actions.
  - Chuẩn hóa Dockerfile & docker-compose.yml cho t-router độc lập.

## 0.5.112-pro.23-t.2 (2026-11-07)

- **Chặn và lọc toàn diện model đã bị disable (Disabled Models Enforcement)**:
  - `src/sse/services/model.js`: bổ sung `isModelDisabled(modelStr, options)` hỗ trợ kiểm tra đa tầng (provider alias, providerId, custom node prefix, variant backing model, và combo mà mọi model con đều bị disabled) cùng `filterActiveComboModels(models, options)` lọc sạch danh sách combo member.
  - `src/sse/handlers/chat.js`: chặn request gọi trực tiếp tới model bị disabled (`handleChat` và `handleSingleModelChat`), trả về HTTP 404 Not Found rõ ràng (bỏ qua nếu có header nội bộ `x-allow-disabled: 1`).
  - `src/sse/services/comboDispatch.js`: tự động lọc bỏ các model bị disabled khỏi `comboModels` và `augmentedModels`. Nếu tất cả model trong combo đều bị disabled, trả về HTTP 404 `All models in combo are disabled`.
  - `src/app/api/v1/models/route.js`: ẩn các model bị disabled khỏi danh sách `/v1/models`, ẩn các variant có backing model bị disabled, và ẩn các combo mà toàn bộ model thành viên đều bị disabled; đồng thời tính capabilities combo chỉ dựa trên các thành viên còn active.
  - `src/app/api/v1/models/info/route.js`: trả về HTTP 404 cho metadata của model bị disabled.
  - `src/app/api/models/route.js`: lọc bỏ các custom models bị disabled khi query không có cờ `includeDisabled`.
  - `src/app/api/combos/test/route.js`: đánh dấu status `"disabled"` rõ ràng cho các member bị disable trong combo test mà không gọi probe tốn tài nguyên.
  - `src/app/(dashboard)/dashboard/combos/page.js`: giao diện Combo Test Modal hiển thị trạng thái `disabled` với icon block và nhãn xám skipped.
- **Tối ưu layout giao diện Dashboard Usage**:
  - `src/shared/components/UsageStats.js`: chia đều 2 panel (Providers và Recent Requests) với tỷ lệ 50% / 50% (`lg:grid-cols-2`), đồng thời mở rộng độ rộng cột Model (`max-w-0 w-full`) tránh bị cắt ngắn tên model.
- **Unit Testing**:
  - Bổ sung bộ kiểm thử `tests/unit/disabled-models.test.js` kiểm tra đầy đủ 13 kịch bản: phát hiện disabled qua providerAlias, providerId, variants, combos, lọc combo members, và các static guards qua toàn bộ routes.

---

## Đồng bộ bản vá từ upstream 9router 0.5.112 và 9router-pro 0.5.109-pro.23 (2026-11-06)

- **Security & Masking**:
  - Tích hợp `src/shared/utils/maskApiKey.js` dùng chung giữa usageRepo, webhookEvents và Dashboard, bảo đảm không lộ full API key.
  - Cập nhật `open-sse/utils/requestLogger.js` (maskSensitiveHeaders) che giấu token/cookie thực tế trong logs (`[REDACTED]`).
  - Lọc bỏ `mitmSudoEncrypted` khỏi response GET và PATCH trong `src/app/api/settings/route.js`.
  - Cập nhật `src/app/api/shutdown/route.js` dùng `await headers()` tương thích Next.js 15.
  - Cập nhật `src/app/api/settings/database/route.js` trả về HTTP 500 khi server restore lỗi.
  - Cập nhật `src/app/api/notifications/route.js` trả về HTTP 404 khi không tìm thấy notification cần đánh dấu đã đọc.
  - Cập nhật `src/lib/auth/oidc.js` với hằng số `OIDC_FETCH_TIMEOUT_MS = 15000` (15s timeout cho tất cả OIDC discovery/token/probe calls).

- **Executors & Upstream Wire Updates**:
  - Cập nhật `open-sse/executors/opencode.js` và `opencode-zen.js`: chuẩn hóa User-Agent 2.2.5 (`opencode/latest/2.2.5/cli`), bổ sung cặp session affinity headers (`x-session-affinity`, `x-session-id`), loại bỏ `x-opencode-request` (chống lỗi 403 FreeTierError), cập nhật bộ validator version cho major >= 2.
  - Cập nhật `open-sse/executors/gemini-web.js`: trả về HTTP 401 khi session hết hạn hoặc trang redirect sang trang đăng nhập Google (accounts.google.com/signin), giúp account fallback chuyển sang tài khoản khác thay vì báo lỗi 400.
  - Cập nhật `open-sse/executors/base.js`: kiểm tra `connectCtrl.signal.aborted` trước khi thực hiện retry nhằm fail-fast ngay khi gặp connect timeout, tránh lặp lại request làm treo kết nối.
  - Cập nhật `open-sse/services/lazyRuntime.js`: thêm hàm `normalizeDep` chuẩn hóa import `playwright-core` (xử lý export chromium trên default của CJS module trong môi trường ESM), giữ nguyên tên package và thư mục `t-router-runtime`.
  - Cập nhật `open-sse/services/webLogin.js`: bổ sung cờ `--no-sandbox` khi khởi chạy browser, hỗ trợ môi trường root/VPS Linux.

- **Rotation & Combo Resilience**:
  - Cập nhật `open-sse/config/runtimeConfig.js`: bổ sung `envMsAllowZero`, cho phép biến `COMBO_FIRST_RESPONSE_TIMEOUT_MS` nhận giá trị `= 0` để tắt timer timeout thành viên.
  - Cập nhật `open-sse/services/combo.js` và `src/sse/handlers/chat.js`: kết nối `request.signal` của client với timer của từng member thông qua `AbortSignal.any`, ngắt ngay upstream khi client disconnect (trả về 499) thay vì tiếp tục thử phí phạm các model tiếp theo.
  - Cập nhật `src/sse/services/auth.js` với đầy đủ các bản vá:
    - **C-3**: Giải phóng sticky selection mutex trước khi sleep trong cơ chế small-fleet rescue để không chặn các request đồng thời khác.
    - **C-4**: Chỉ xóa sticky current route khi tài khoản thực sự bị khóa sau khi đã xác định `shouldFallback = true`.
    - **C-5**: Tính cooldown lũy tiến `max(executorResetMs, blindBackoffMs)` và duy trì leo thang cấp độ backoff.
    - **C-6**: Bỏ qua các account đã bị loại trừ (`excludeSet`) khi tính toán thời gian giải cứu small-fleet rescue.
    - **C-7**: Ghép đôi connection với thời điểm hết hạn chính xác (`lockedByExpiry`) thay vì lấy phần tử đầu tiên theo thứ tự DB.
    - **Bảo toàn**: Giữ nguyên vẹn logic Proxy Pools nâng cao của t-router (`rotateLink`, `triggerBackgroundRotate`, proxy pools theo provider/connection, auto-rotate trên 429/403).

- **UI & Routes**:
  - Cập nhật `src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js`: chuyển hướng gửi chat sang endpoint chuẩn `/v1/chat/completions`, tích hợp dropdown chọn API Key trực tiếp trên giao diện chat, loại bỏ hoàn toàn các thông tin donate/tele/author.
  - Thêm helper `src/lib/compatibleModels.js` và cập nhật `src/app/api/providers/[id]/models/route.js`, `test-models/route.js`, `compatible-models/route.js` loại bỏ hoàn toàn HTTP self-fetch.
  - Thêm `src/shared/utils/testErrorStage.js` phân loại trạng thái lỗi kiểm tra nhà cung cấp và model.
  - Bổ sung `src/app/api/monitoring/route.js` và `src/app/(dashboard)/dashboard/MonitoringPageClient.js` (cùng route `/dashboard/monitoring`) hỗ trợ theo dõi hiệu năng hệ thống, tài nguyên và lưu lượng mạng theo chuẩn Azure theme của t-router.

---

## v0.5.112-pro.23-t.1 (2026-11-06)

- Automated sync and release via Telegram Bot.

## v0.5.112-pro.16-t.16 (2026-11-04)

- **Proxy verified end-to-end**: a chat request with a pool bound to the connection reaches the provider through that proxy (a logging proxy recorded `CONNECT <upstream>` while the upstream logged the POST); with no pool bound the request goes direct; the provider-level rotation (`providerStrategies[provider].rotateStrategy` + `proxyPoolIds`) also routes through the pool. Same path is used for model tests, usage/ping and token refresh (`chatCore` → `BaseExecutor` → `proxyAwareFetch`).
- **Exit IP (new)**: "Test" on a proxy pool now also reports the address the outside world sees through it (`probeExitIp` via the proxy: ipify, then ifconfig.me), persists it as `lastExitIp`/`lastExitIpAt`, and the pool card shows "Exit IP: … · time". A passing health check alone proved nothing — a bypassing pool still answers.
- **Effective proxy on the provider page**: the proxy card now leads with `EFFECTIVE — <pool name> — http://host:port`, or `Rotation (<strategy>) over N pools: …`, or `Direct (no proxy)`, plus a **Check exit IP** button that runs the probe through the pool actually in use and prints `Exit IP via <pool>: <ip>`. It also states that a per-connection proxy overrides the provider setting.
- Regression guards: `tests/unit/proxy-visibility.test.js`.

## v0.5.112-pro.16-t.15 (2026-11-04)

- **"Loaded 101 models" but the list was empty**: OpenAI-compatible catalogs tag every row with their own `type` field — `api.cencori.com` answers `type: "chat"`. `getModelKind` returned that verbatim and every LLM filter compares against `"llm"`, so the whole catalog was filtered out of the provider page and the model picker right after it had been loaded and cached. `getModelKind` now maps the chat/text/completion aliases to `"llm"` (media kinds such as `image`, `tts`, `embedding` are untouched).
- Verified against a Cencori-shaped catalog (`type: "chat"`): models render under the search bar immediately after Load and again after a reload (served from the DB).
- Regression guards in `tests/unit/provider-model-rows.test.js`.

## v0.5.112-pro.16-t.14 (2026-11-04)

- **Test combo (new)**: every combo card now has a **Test** action that answers the three questions an operator asks about a combo — how it routes, whether each member works, and which model the next request will use. `POST /api/combos/test` sends one small real request per member (model = that member, never the combo name), reports `ok/error`, latency and the provider error, and returns the strategy plus the rotation-aware order. The dialog shows `x/y ready`, the predicted member (`next`), the judge for fusion combos, and labels nested combos.
- **Prediction never disturbs routing**: the order comes from `peekRotatedModels()` (new read-only sibling of `getRotatedModels`) — a preview would otherwise consume a round-robin slot and change what the next production request does.
- **Clear failure without a key**: model probes go through the normal `/v1` pipeline, so when `requireApiKey` is on and no active key exists the dialog says "No API key configured — create one under Endpoint & Key" instead of showing every member as `HTTP 401: Missing API key`.
- **Combos page crash on Smart combos**: the strategy badge's "Configure" link used `<Link>` without importing `next/link`, which threw during render for any `smart` combo.
- Regression guards: `tests/unit/combo-test.test.js`.

## v0.5.112-pro.16-t.13 (2026-11-04)

- **Models that would not disable**: user-added (custom) models were rendered straight from the custom-model table, so clicking X wrote the id to the denylist and the chip never moved — it looked like the model refused to disable. Custom rows now honour the denylist: X moves them to "Disabled models", where `+` restores them and X deletes the custom row. Verified end-to-end (disable → leaves the list, appears under Disabled models, restore brings it back).
- **Catalog stored in the DB**: `/api/providers/[id]/models` used to call the provider's `/models` endpoint on every provider-page visit. The catalog is now persisted (kv scope `loadedModels`, keyed by connection id — or provider id for no-auth providers) and served from there. Only "Load models from provider" (and the Qoder/Cline import buttons) sends `?refresh=1` to ask the provider again. Measured on the fixture: 1 upstream call for the first visit, still 1 after a reload, +1 only after clicking Load; the model picker reads the stored catalog with no upstream call.
- **Failed refresh no longer blanks the list**: if the provider is unreachable when refreshing, the stored catalog is returned with `stale: true` and a warning instead of an error, so the page keeps working.
- Regression guards added to `tests/unit/provider-model-rows.test.js`.

## v0.5.112-pro.16-t.12 (2026-11-04)

- **Provider icon 404s**: `/providers/vilao.png` (and any custom provider) 404'd on first render because the icon chain guessed a bundled mark from the id or the display name. `ProviderIcon` now only requests a mark listed in the generated `providerIconManifest.js` (162 bundled files, regenerated by `scripts/gen-provider-icon-manifest.mjs` on `predev`/`prebuild`), so an unknown provider falls straight through to favicon/type/initials instead of a dead request.
- **Model picker crash (critical)**: `Cannot read properties of undefined (reading 'localeCompare')` — OpenAI-shaped `/models` payloads have no display name, so a picker row got `name: undefined` and the alphabetical sort threw, blanking the whole dialog. Every models payload is normalized to `{ id, name }` at the API boundary (`src/shared/utils/modelRows.js`) and again when the picker reads it; both sorts (picker, Basic Chat) fall back to value/id.
- **Picker parity for compatible providers**: a custom (OpenAI/Anthropic-compatible) node with no alias/custom rows offered only a `model-id` placeholder while its provider page listed the whole catalog. The picker now merges the node's live catalog, so both show the same models.
- **One model list per provider**: custom rows used to render above the toolbar, splitting "Available Models" into a chip block on top and the rest below the search box. The action row → search → single list order now applies to every provider; X still disables (restorable in "Disabled models").
- Regression guards: `tests/unit/provider-model-rows.test.js`.

## v0.5.112-pro.16-t.11 (2026-11-04)

- **Model list = provider catalog (9router-pro style)**: the separate "Loaded models (x/y)" allowlist panel is gone. "Available Models" is one list; **X disables** a model (it moves to "Disabled models" and can be restored), and only a disabled custom model can be deleted. "Load models from provider" no longer writes nabledModels; a stale allowlist is cleared on load.
- **Live catalog for no-auth providers**: /api/providers/[id]/models now answers for provider ids without a connection. OpenCode Zen publishes https://opencode.ai/zen/v1/models and accepts the anonymous public credential (as opencode2api does) — verified 79 real models instead of the built-in list, with the static catalog only as fallback.
- **Bulk controls + search**: Enable all / Disable all and a model search box, styled with the shared Button (sm/secondary/icon) like the old header action; the duplicate header pair was removed.
- **Load after disable**: /api/models?includeDisabled=1 keeps a fully disabled provider re-listable.
## v0.5.112-pro.16-t.10 (2026-11-04)

- Re-release of t.9 (identical code): npm accepted `0.5.112-pro.16-t.9` into its staging queue and never promoted it, so `npm i -g t-router-proxy@latest` still resolved to t.8. Bumping the patch keeps the fixes publishable; t.9 stays staged and can be ignored/deprecated.

## v0.5.112-pro.16-t.9 (2026-11-04)

- **Provider switch (critical)**: re-enabling a provider from `/dashboard/providers` returned 500 — the "fresh chance" UPDATE named `consecutiveAuthFailures` / `quarantineReason` / `quarantinedAt`, which are fields inside the connection's `data` JSON, not columns. The transaction rolled back, so a provider could be switched off and never back on. The reset now rewrites the JSON of the rows that carry those fields.
- **Test image**: the probe is sent as a capability probe, so the router skips the capacity adapter (it used to answer with the vision pool model and report "image OK" for a model that never saw the image) and the modality strip (it removed the image and reported the capability table instead of the model). Both probe buttons are now offered for every model, not only for the ones the capability table pre-labels.
- **Test thinking**: the probe now streams and reads `delta.reasoning_content`. The non-stream handler deletes `reasoning_content` whenever the answer also has content, so a genuinely reasoning model read as "does not expose thinking" unless its provider reported `reasoning_tokens`.
- **Load models**: the loader (and the per-model switches that write `enabledModels`) was unreachable because it only rendered for active connections — which the switch bug kept inactive. Added Select all / Clear for the loaded list; `/v1/models` publishes exactly the left-on models.
- **Model picker**: applies each connection's `enabledModels` allowlist, so combos/injections offer the same models the provider publishes. Compatible providers no longer show a `model-id` placeholder while their real loaded models are missing.
- **Prompt Rule**: verified multi-select (picker stays open, second pick adds, save stores every chosen model).
- Regression guards added to `tests/unit/dashboard-fixes.test.js`.

## v0.5.112-pro.16-t.8 (2026-11-03)

- **UI load time**: the dashboard paid for the full Material Symbols font (all 4004 icons, 3.9 MB) on every page — including `/login` — because `material-symbols/outlined.css` pulled the whole file into the global stylesheet. It is now a generated subset (`src/app/fonts/material-symbols-outlined-subset.woff2`, 51 KB, 222 icons) referenced by a local `@font-face`; `scripts/build-icon-subset.py` regenerates it and pins the unused variation axes. Icon ligatures still resolve, since the generator keeps the letter glyphs the ligatures are built from (`layout_closure` off, or the subsetter would re-add every icon).
- **Font preloads**: the 21 display-name faces (header personal-name styles) are now `preload: false` — only Inter, which paints the UI, is preloaded. Every page previously issued ~21 extra font requests before settling.
- **Measured** (production build, dashboard, 25 Mbps / 30 ms RTT): 4629 KB → 447 KB transferred, 82 → 21 requests, `load` 1919 ms → 401 ms, icon font 3870 KB/1693 ms → 52 KB/165 ms. All 22 dashboard routes audited: 0 icons fall back to their literal name.

## v0.5.112-pro.16-t.7 (2026-11-03)

- **Request-hang hardening**: SSE→JSON body reads now share the client's total-request budget; flaky-body inspection is bounded and clears its timer on every read; proxy candidates share one sliced connect budget instead of one full window each; the provider connect timeout reaches the proxy phase; evicted proxy dispatchers are closed; token-refresh fetches are capped at 30s; the client abort signal is forwarded through the account loop; streaming clients get an SSE keepalive while combos/retries run.
- **Provider controls**: no-auth providers honour the dashboard on/off switch (settings gate in `auth`, `/v1/models`, and the no-auth fetch/search/tts/image/video handlers); the list switch no longer filters the bulk UPDATE by registry auth types (which matched zero stored rows); re-enabling clears quarantine state and invalidates the models-list cache.
- **Model catalog**: every provider's picker reads its live catalog (stable effect signature, no fetch loop); providers without a live resolver fall back to their built-in catalog instead of a 400; the active-model allowlist is enforced after the live override and on merged rows, with `enabledModelsExplicit` keeping an empty selection authoritative; the provider page lists every loaded model with a per-model switch.
- **Capability probes**: image probe (16×16 PNG, colour synonyms, rejects a silently stripped image) and thinking probe (requires real reasoning output, longer budget), with per-probe results kept independent.
- **Prompt injection**: the rule picker stays open for multi-select/deselect; an explicitly emptied model/key target list now persists as `[]` and matches nothing instead of widening to `*` (cleanRule + matching + tests).
- **Prompt variants**: variant saves route directly and no longer create shadow combos; the variant tests were updated to that contract.
- **Fixes**: the solo chat call passed the abort signal into the attempt-cap slot; flaky-guard timers leaked one armed timer per chunk; proxy rotation dropped the client abort chain once headers arrived.

## v0.5.112-pro.16-t.1 (2026-11-02)

- Automated sync and release via Telegram Bot.

## v0.5.112-pro.16 (2026-11-02)

- **Upstream Sync & Enhancements (9router v0.5.112, 9router-pro v0.5.109-pro.16)**:
  - **Re-audit Fixes & Security Hardening**:
    - Database export/import verifies CLI token value with machine-salted validation (`hasValidCliToken`) instead of header presence alone.
    - Fail-closed pre-import safety backup: imports cancel safely if the pre-import snapshot fails.
    - SSO-only test gate actively verifies connection tests whenever IdP fields change in passwordless modes.
    - Single-level deep merge for `responseCache` and `dbMaintenance` settings preventing accidental wipes of nested configs.
    - First-setup password accepts custom `INITIAL_PASSWORD` env value alongside built-in fallbacks.
    - Quota check endpoints neutrally refuse inactive connections before making upstream calls.
    - Bulk-enable wording refined with live post-toggle refetch.
    - Proxy health check strictly records test status without overwriting operator-disabled active flags; skips inactive pools on default runs.
    - Scrubbing authorization credentials from translator logs and responses.
    - Single-key PUT merges quota/limits instead of dropping untouched fields.
  - **New BYOK Providers**:
    - Added **OrcaRouter** (OpenAI-compatible gateway supporting 40+ providers) with live catalog fetching.
    - Added **TOTU AI** (NewAPI gateway with automated model pricing sync).
  - **Usage & Dashboard Polish**:
    - Usage today chart renders all 24 hourly buckets.
    - Usage overview sparklines with Catmull-Rom smoothing for Cached and Output metrics.
    - Usage recent requests displays serving provider sub-line under model and new Latency column.
    - Interactive topology map with solar-system circular layout, active electric current flow, and starfield canvas background.
    - Unified key edit modal with custom key / prefix support and expiry controls.
    - Cleaned up redundant catalog search and dead experimental code.
  - **T-Router Preservation**:
    - Preserved Azure branding (#3B82F6 / #1D4ED8), Azure T icon, and default port 20126.
    - Maintained database location `~/.trouter/db/data.sqlite` and dataDir `~/.trouter`.
    - Preserved advanced proxy features: dynamic IP rotation (rotateLink), Rotate IP button, Proxy Source filters, auto-rotate on 429/403, shorthand parsing, and Universal Proxy Pools for all providers.
    - Preserved multi-model, multi-key prompt injection rules with inline prompt editor and live templates.

## v0.5.112-pro.15-t.1 (2026-10-30)

- Automated sync and release via Telegram Bot.

## v0.5.112-pro.15 (2026-10-30)

- **Upstream Sync & Enhancements (9router v0.5.112, 9router-pro v0.5.109-pro.15)**:
  - **Shared Combo Dispatch Across All Modalities (P3-30)**: Replaced repeated combo dispatch boilerplate across top-level, nested, and solo branches with unified `comboDispatch.js` and consistent account-exhausted response across all 8 modalities.
  - **Honest `/v1/models` & Model Catalog (G2/G9)**: Zero stored connections no longer returns static catalog; noAuth-servable models list truthfully, and `auto:` targets are listed as servable models. Cached via `modelsListCache.js`.
  - **Health, Breaker Pre-Trip & Quarantine (G10/G11/P1-18)**: Added `providerBreaker.js` with pre-trip warnings and provider health summary (`/api/providers?summary=1`); automated quarantine for connections hitting repeated auth failures.
  - **Request-ID Correlation (P1-18)**: Standardized request correlation with `x-9router-request-id` and `x-t-router-request-id`, carried through usage history, logs, and response headers.
  - **Rival Features (R1-R15)**:
    - **Free-Stack & Tiered Combo Advisor (R1/R2/R4)**: Auto-discover healthy free-tier stacks and tiered combos via `/api/combos/advisor` and `comboAdvisor.js`.
    - **Persistent Trust Inbox Bell & Security Log (R3/R4)**: Added `TrustInboxBell.js` header notifications and security audit event logging (`/api/security-log`).
    - **Read-Only Gateway MCP Server & At-Rest Encryption (R5/R6)**: Added gateway MCP server (`/api/mcp/gateway`) and AES-256-GCM at-rest credential encryption (`atRestCrypto.js`).
    - **Locked Sampling Params & Semantic Cache (R7/R9/R13)**: Supported locked sampling params per variant, measured-latency auto-routing refinements, and opt-in per-key semantic cache (`semanticCache.js`).
    - **Usage Heatmap & Per-Card Sparklines (R8)**: Added usage heatmap and token saver savings view inside Usage page.
    - **Catalog Search Modal & Bulk Key Edit (R10/R11)**: Universal model search modal (`CatalogSearchModal.js`) and bulk key edit in Endpoint page.
    - **CLI Doctor, Setup & Dry-Run (R12)**: Diagnostic tools in CLI adapted for T-Router (`doctor`, `setup`, `dry-run` with port 20126 and `~/.trouter`).
    - **Eval Runner (R14)**: Added model evaluation runner (`/dashboard/evals`, `evalRunner.js`).
    - **PWA & Termux (R15)**: Added `manifest.json` and Termux installer script (`termux-install.sh`).
  - **Non-Chat Usage Accrual & Key Breakdown (G14)**: Precise non-chat usage accrual and dashboard per-key breakdown API (`/api/usage/by-key`).
  - **New Providers**: Added `runcrate` and `ollama-local` (TTS & embeddings).
  - **OpenCode 1.19+ CLI Protocol & TLS**: Aligned OpenCode executor with 1.19+ CLI request headers and session hashing while preserving BoringSSL TLS impersonation over Proxy Pools.
  - **Preserved T-Router Customizations**: Azure branding (#3B82F6/#1D4ED8, icon T), `~/.trouter` SQLite database location, default port 20126, Universal Proxy Pools & Dynamic IP Rotation on all providers.

## v0.5.112-pro.14-t.1 (2026-10-28)

- Automated sync and release via Telegram Bot.

## v0.5.111-pro.14-t.10 (2026-10-28)

- **Upstream Sync & Enhancements (9router v0.5.111..v0.5.112)**:
  - **MiniMax Code Desktop App Lease Mode**: Added auth lease client (`minimaxCodeLease.js`) communicating over local named pipes (Windows) / unix domain sockets (macOS/Linux) with length-prefixed JSON protocol; allows t-router to borrow credentials from the running MiniMax Code desktop app, avoiding single-use refresh token invalidation. Added "Use Desktop App" button on provider detail page and lease status checks.
  - **Nace Drex Provider**: Added `nace` decision models provider on the System One protocol (`drex-max`, `drex-v2.0`) with calibration probabilities and image payload support.
  - **CommandCode CLI 1.88.0 Header Alignment**: Added shared `commandCodeHeaders.js` matching official CLI 1.88.0 auth and session header generation.
  - **Codex GPT-6.1 Terra**: Added `gpt-6.1-terra` model with 500k context window on Codex responses-lite lane and GPT-6 Lite thinking levels.
  - **NVIDIA NIM Reasoning Normalization**: Normalized assistant `reasoning` aliases to canonical `reasoning_content` in `paramSupport.js` to prevent duplicate field 400 errors.
  - **Gemini Protobuf Type Predicates**: Enforced Gemini proto schema constraints (`items` only on `array`, `properties`/`required` only on `object`) in `formats/gemini.js`.
  - **Non-Streaming SSE Error Handling**: Surfaced upstream SSE error frames directly with their actual status code (4xx/5xx) in non-streaming responses rather than swallowing them into generic 502 Bad Gateway.
  - **DeepSeek PoW Engine**: Ported DeepSeek Proof-of-Work hashing to `noble-hashes` implementation (`deepseek-pow-hash.js`).
  - **Bulk Add Opaque Token Parsing**: Supported opaque `LLM|id|secret` token parsing without splitting on internal pipes.
  - **CodeBuddy Channel Verification**: Added official plugin request/conversation ID headers (`X-Request-ID`, `X-Conversation-ID`, `X-Conversation-Request-ID`, `X-Conversation-Message-ID`) to prevent 400 / 11128 "request illegal" rejections.
  - **GitHub Copilot Claude 5.5 Thinking**: Corrected thinking rules for Copilot's dotted Claude 5.5 model IDs (`claude-haiku-5.5`, `claude-sonnet-5.5`, `claude-opus-5.5`).
  - **Docker Runner**: Pre-bundled lazy runtime dependencies (`wreq-js`, `playwright-core`) in builder stage to guarantee synchronous resolution inside containers.

---

## v0.5.111-pro.14-t.9 (2026-10-28)

- **Proxy-Aware TLS Impersonation for OpenCode Free Tier**:
  +- **`wreq-js` Proxy Routing**: Enabled native proxy passing into `wreq.createSession({ proxy })` with isolated session caching per proxy URL (`opencodeTlsClient.js`).
  +- **`proxyAwareDirectFetch` Support**: Updated `proxyFetch.js` to delegate to `options.directFetch` even when routed through a proxy pool if `options.proxyAwareDirectFetch === true`.
  +- **Bypass Free Gate Over Proxy Pools**: Requests to OpenCode Free routed through Proxy Pools or when Direct is disabled now maintain the required BoringSSL TLS ClientHello fingerprint over the proxy tunnel, avoiding `429 FreeUsageLimitError`.
  +- **Proxy Eviction Sync**: Integrated `resetOpencodeTlsSession(proxyUrl)` into `evictProxyDispatcher(proxyUrl)` so IP rotation closes and clears the cached session tunnel cleanly.

---

## v0.5.111-pro.14-t.8 (2026-10-28)

- **Hardened Proxy Pool Configuration & Execution Pipeline**:
  +- **Database Persistence**: Ensured `autoRotate`, `minIntervalSeconds`, `maxIntervalSeconds`, and `failedIpCacheSize` are fully retained and saved upon new proxy pool creation (`createProxyPool`).
  +- **Configured Parameter Enforcement**: Applied each pool's custom `minIntervalSeconds` (cooldown) and `failedIpCacheSize` directly in `rotateProxyWithRangeCheck`, eliminating hardcoded limits.
  +- **AutoRotate Guard**: Respected `autoRotate: false` during runtime failures — records the failed exit range to prevent bad-range recurrence without firing unwanted background rotation calls.
  +- **Eliminated Redundant Exit Range Probes**: Removed un-awaited duplicate `noteFailureRange` calls from `proxyFetch.js`, ensuring sequential range-probing before `rotateLink` execution.
  +- **Candidate Proxy Source Filtering**: Filtered candidate pool list strictly by `proxySource` (`static`, `rotating`, or `both`) across all resolution and fallback branches.

---

## v0.5.111-pro.14-t.7 (2026-10-28)

- **Advanced Proxy Rotation, Fallback & Bad Exit Range Cache (Aligned with `opencode2api` Standard)**:
  - **Multi-Proxy In-Pool Fallback**: When a proxy fails or receives HTTP 429/403/502/503 from upstream, `proxyAwareFetch` now automatically falls back to subsequent active candidate proxies in the pool instead of throwing an immediate 502 or prematurely falling back to direct connection.
  - **Rotating Proxies First (`RotatingFirst`)**: In mixed (`both`) proxy source mode, rotating proxies (pools with a `rotateLink` / `rotateUrl`) are always prioritized ahead of static proxies across candidate generation and rotation selection.
  - **Auto-Adopt Active Proxies when Direct Disabled**: When Direct is disabled (`directActive === false`), if a provider/connection has no valid proxy assigned or was pointing to `direct`, it automatically adopts active real proxies from Proxy Pools (rotating first, then static) rather than throwing an immediate 502 IP leak prevention error.
  - **Subnet Normalization & Known-Bad Range Cache (`proxyRotator.js`)**:
    - Extracted exit IPs to network ranges: IPv4 to `/24` (e.g. `1.2.3.0/24`) and IPv6 to `/48` with full 8-group expansion of compressed `::` notation.
    - Maintained bounded FIFO cache of known-bad exit ranges. When a rotating proxy fails, its exit range is recorded before renewal to eliminate race conditions.
    - During IP rotation, probes the new exit IP via proxy; if the new IP lands in a known-bad range, automatically re-rotates (up to 5 attempts with backoff) to guarantee clean egress.
  - **Per-Pool Rotating Proxy Configuration**: Added configuration for `minIntervalSeconds` (cooldown between rotations, default 60s), `maxIntervalSeconds` (auto-rotate interval, default 1800s), `failedIpCacheSize` (max bad IPs to cache, default 10), and `autoRotate` toggle in Proxy Pools UI and API.
- **Direct 1-Click Update Screen**: Clicking **Update now** now opens the Copy & Shutdown install panel directly without an intermediate instructional dialog.
- **Claude Cowork CLI Tool Styling**: Adjusted height and alignment of the Model/Combos input area in `CoworkToolCard` to match the exact dimensions and spacing of the API Key input.
---

## v0.5.111-pro.14-t.6 (2026-10-27)

- **Hardened Runtime Dependency Loader (`lazyRuntime.js`)**:
  - Added `/* webpackIgnore: true */` comments to all dynamic `import(pathToFileURL(...))` calls to prevent Webpack from wrapping them with context modules that fail on `file://` URLs in bundled environments.
  - Ensured `<DATA_DIR>/runtime/package.json` exists before running `npm install`, isolating the runtime directory and preventing npm from traversing parent directories.

---

## v0.5.111-pro.14-t.5 (2026-10-27)

- **Fix: OpenCode Free 502 (wreq-js `Cannot read properties of undefined (reading 'resolve')`)**:
  - Replaced Webpack-broken dynamic `createRequire` in `open-sse/services/lazyRuntime.js` with direct filesystem package entry resolution (`resolvePackageEntry`), reading package metadata and resolving exports/main paths natively.
  - Completely eliminated Webpack compilation warning `module.createRequire failed parsing argument` and runtime `TypeError` when lazy-loading `wreq-js` or `playwright-core`.
- **Fix: Claude Cowork Combo Selection in CLI Tools**:
  - Added **Quick Combos** shelf directly on the Cowork tool card for 1-click selection of existing combos.
  - Added dedicated **Select / Browse** button and click-to-browse trigger on the model box to open `ModelSelectModal`, enabling selection of any existing combo or provider model.
  - Enhanced `handleCreateCombo` to automatically adopt and select an existing combo if the entered name already exists, preventing duplicate creation errors.

---

## v0.5.111-pro.14-t.4 (2026-10-27)

- **Fix: Prevent Triple-Count Stats on noAuth Providers**:
  - Standardized `noAuth` provider stat entries to a single key `${pId}|free` in `src/lib/db/repos/connectionsRepo.js`.
  - Restricted `dualAuthTypes` in `src/app/(dashboard)/dashboard/providers/page.js` to return `["free"]` for `noAuth` providers, ensuring accurate connection counts and status displays without over-aggregation.

---

## v0.5.111-pro.14-t.3 (2026-10-27)

- **Fix: TypeError on bulk-toggling providers**:
  - Corrected `getSettings` and `updateSettings` import target in `src/app/api/providers/route.js` from `@/models` to `@/lib/localDb`.

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
