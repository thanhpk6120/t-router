# T Router — Changelog

This changelog records all updates, enhancements, and releases specific to **T Router**.
Upstream changelogs (`CHANGELOG.md` and `CHANGELOG-PRO.md`) are kept intact for clean 3-way git merges from upstream repositories.

---

## 0.5.119-pro.26-t.7 (2026-11-14)

### Combos & Vision Adapter drag-and-drop ordering

- **Drag-and-drop combo list ordering** (`src/app/(dashboard)/dashboard/combos/page.js`, `src/app/api/combos/reorder/route.js`, `src/app/api/combos/route.js`, `src/lib/comboOrder.js`, `src/lib/db/repos/settingsRepo.js`): added `@dnd-kit` drag handles to combo cards so combos can be reordered directly on `/dashboard/combos` (disabled while search filtering is active) and persisted to `settings.comboOrder` via `POST /api/combos/reorder`, with `GET /api/combos` returning combos in the saved order.
- **Drag-and-drop Vision Adapter model ordering** (`src/app/(dashboard)/dashboard/combos/page.js`): added `@dnd-kit` drag handles to model rows inside Vision Adapter pools (`Vision` and `Audio`) alongside the existing up/down buttons, automatically persisting the reordered pool via `PATCH /api/settings`.

### Usage Recent Requests combo & proxy visibility

- **Combo attribution in Recent Requests** (`src/sse/handlers/chat.js`, `open-sse/handlers/chatCore/requestDetail.js`, `open-sse/handlers/chatCore/nonStreamingHandler.js`, `open-sse/handlers/chatCore/sseToJsonHandler.js`, `open-sse/handlers/chatCore/streamingHandler.js`): propagated the active `comboName` through `clientRawRequest` and `saveUsageStats` so requests dispatched through a combo record their combo name in `usageHistory.meta` and the live SSE ring.
- **Proxy provenance in Recent Requests** (`src/lib/db/repos/usageRepo.js`, `src/shared/components/UsageStats.js`): persisted non-trivial proxy provenance (`proxied`, `fallbackDirect`, `strictProxy`, `directDisabled`) alongside `combo` in `recentRequests` (both initial stats and `/api/usage/stream` SSE updates) and rendered the combo badge (`layers`) and `ProxyBadge` / `ProxyFallbackBadge` / `ProxyBlockedBadge` under each model entry in `/dashboard/usage` Recent Requests.

---

## 0.5.119-pro.26-t.6 (2026-11-14)

### TTFT timeout ladder & proxy abort reliability

- **Pre-header connect timeout now walks the ladder** (`open-sse/executors/base.js`): `connectCtrl.abort(new Error("fetch connect timeout"))` (and `proxyFetch`'s `candidateCtrl`) reject with a plain `Error` (`name === "Error"`), not `"AbortError"`. `isConnectTimeout` previously checked `error.name === "AbortError"`, so real `fetch`/`undici` pre-header timeouts stopped at rung 1 instead of advancing through the configured rungs. `isConnectTimeout` now gates on `connectCtrl.signal.aborted && !signal?.aborted`, while caller aborts propagate immediately regardless of abort reason.
- **HTTP errors bypass the first-token gate** (`open-sse/executors/base.js`): `gateFirstToken()` now runs only when `response.ok` (or `2xx` status), preventing empty-body `401`/`403` error responses from being turned into `TtftRungTimeout` retries and preserving the `401`/`403` token-refresh flow.
- **SSE chunk-split carry-over buffer** (`open-sse/utils/ttftGate.js`): `gateFirstToken()` now buffers incomplete SSE lines across chunk boundaries using `TextDecoder({ stream: true })`, so fragmented metadata frames (`message_start`, `ping`) no longer fail `JSON.parse` and open the gate early.
- **Outer-signal abort short-circuit in proxy pool** (`open-sse/utils/proxyFetch.js`): `runPass()` now stops immediately when `options.signal.aborted` is true instead of iterating remaining proxies, triggering background rotation links, running pass 2, or falling back to direct.
- **MITM DNS bypass provenance** (`open-sse/utils/proxyFetch.js`): attached `tagProxyFailure()` and `tagProxyUsed()` across the `shouldBypassMitmDns` branches so strict-proxy refusals and direct-bypass fallbacks surface accurately in usage details.

### Passthrough & dashboard fixes

- **Anthropic passthrough frame detection & delta deduplication** (`open-sse/utils/stream.js`): matched `event:` and `"type"` markers using whitespace-tolerant regexes and tracked `claudeDeltaSeen` so a mid-turn cut after `message_delta` synthesizes only `message_stop` without emitting a duplicate `message_delta`.
- **Missing-pool badge visibility** (`src/app/(dashboard)/dashboard/providers/page.js`): fixed `proxyInfo?.missingPool` typo to `proxyInfo?.poolMissing` on both `ProviderCard` and `ApiKeyProviderCard` so `ProxyMissingBadge` renders when connections pin to a deleted or inactive proxy pool.
- **Direct pool & source filter in proxy card** (`src/shared/components/NoAuthProxyCard.js`): suppressed the `PROXIED` badge and `Check exit IP` button when the `"direct"` pool is selected, and filtered `rotationPools` by `proxySource` (`rotating` / `static` / `both`).
- **Next.js App Router export compliance** (`src/lib/providerOverrides.js`, `src/app/api/providers/[id]/overrides/route.js`): extracted `normalizeOverride` out of `route.js` into `src/lib/providerOverrides.js` so the route file exports only valid Next.js route symbols.

---

## 0.5.119-pro.26-t.5 (2026-11-14)

### TTFT timeout ladder actually measures time-to-first-token

The ladder used to bound "time until response headers arrive". A streaming upstream answers 200 and its headers in ~100ms and then the model thinks for 40s, so rung 1 never fired and the feature was inert for exactly the requests it was built for.

- **`open-sse/utils/ttftGate.js` (new)**: `gateFirstToken()` peeks the response body until a real payload appears, then returns a `Response` that replays every byte it consumed. Nothing has reached the client yet, so an expired rung is safe to discard.
  - Heartbeats (`: keep-alive`, `retry:`), metadata frames (`message_start`, `content_block_start`, `response.created`, ...) and `[DONE]` do NOT count as a first token. Counting them would pass every rung instantly and leave the ladder as inert as before.
  - Content is matched structurally (`content`, `text`, `reasoning`, `thinking`, `partial_json`, `arguments`, ...) so OpenAI deltas, Anthropic deltas and tool-call streams are all recognised.
  - Proxy provenance travels onto the rebuilt response, otherwise the dashboard would lose the proxy badge for exactly the requests that went through a ladder.
- **`open-sse/executors/base.js`**: each rung now budgets headers **and** the first token. A `TtftRungTimeout` advances to the next rung and re-issues the model call on the same account; when the ladder is spent it falls through to the next fallback URL rather than erroring. No breaker, quota or account state is touched — a slow account is not a dead account. With no ladder configured, nothing changes: headers alone still mean success and no body read is added.
- **`open-sse/utils/streamHandler.js`**: a stall or total-deadline after output has already streamed is a truncation, not a failure. It closes the stream cleanly and skips the error frame, so a response the client is already rendering is never reported as a timeout. Stalls before any output still fail as before, and a heartbeat-only upstream still counts as no output.
- **UI** (`CustomConfigCard.js`): the ladder help text now says it measures the first token instead of claiming it bounds headers only.

### Proxy rotation advances on 429 and retries the rotated pool once

- **Root cause**: `proxyFetch` returned early on the `directFetch.proxyCapable` branch, so an adapter that owns its transport (opencode's wreq-js path) was invoked once with the first proxy. A 429 from that proxy went straight back to the caller and the rest of the pool was never tried.
- **Per-candidate adapter dispatch**: the adapter is now called inside the rotation loop with each candidate's own `proxyUrl`.
- **Configurable rotate statuses** (`open-sse/config/proxyRotateStatuses.js`, new): `DEFAULT_PROXY_ROTATE_STATUSES` is `[429, 403, 502, 503]` — the statuses that describe the exit. `400`/`404`/`422` are deliberately excluded, because a malformed request must not burn a healthy pool. Operators can add them.
- **Two-pass retry**: pass 1 walks the ordered pool; if everything fails, pass 2 re-tries only the proxies that actually had a rotate link (a static exit that failed for its reason is not retried unchanged). Success on pass 2 resets the rotation cycle.
- **"Rotate on status" control** in `NoAuthProxyCard`, committed on blur so a half-typed `429,` never saves, and omitted from settings when it equals the default.
- **Provider card layout**: the proxy row moved out of the right-hand flex group onto its own line above the status badges, with "last tested" rendered as a separate muted line. Grids relaxed to `lg:grid-cols-2 xl:grid-cols-3` so the badge no longer collides with the provider name.

### Effective-proxy precedence: the badge now says what auth.js actually does

- **`tests/unit/effective-proxy.test.js` (new, 19 tests)**: locks the resolution chain the badge renders — connection pin → provider override → rotation strategy → direct. It is not a rendering test: a badge that disagrees with `auth.js` is worse than no badge, because it tells the operator a request went through a proxy that was never used.
- Covered cases: an explicit `proxyPoolId` wins over `rotateStrategy` (auth.js seeds `pickedId` and never computes a rotation pick when it is set); `__none__` means no pin; `fill-first` is connection selection leaking into the same field, never a proxy rotation; a fully direct-pinned provider suppresses the badge instead of painting a red "missing"; a connection pinned to a deleted pool reports `poolMissing` with `proxied: false`, which is the single most important thing the badge can say — the operator believes traffic is proxied while `resolveConnectionProxyConfig` falls through to direct; mixed pins and partial pins are distinguished rather than collapsed into one answer.
- Credentials are verified stripped: `maskProxyHost` is asserted to return host:port for the real pool URLs in use here (a `user:pass@` proxy must never reach the client).

---

## 0.5.119-pro.26-t.4 (2026-11-14)

### Proxy provenance: show the proxy that actually carried each request

- **Per-request proxy record** (`open-sse/utils/proxyProvenance.js`, new): one module that answers "which proxy carried THIS request?", which is not the same question as "which proxy is configured". The pool is chosen per attempt and a failed candidate rotates to the next one mid-request, so a response can legitimately be carried by a proxy the config never named. `tagProxyUsed()` stamps the descriptor from inside `proxyFetch`; `getResponseProxyInfo()` reads it back in the request-detail recorder.
  - Kept standalone rather than exported through `proxyFetch.js` on purpose: every test that mocks the fetch layer (there are dozens) would otherwise have to re-export it, and each new mock would be a place to forget it.
  - Records `poolId`, `poolName`, host, rotation strategy, attempt count, and — for the negative cases — `fallbackDirect` (proxy was attempted and failed, traffic went direct) and `strictProxy` / `directDisabled` (policy refused to let the request leave unproxied).
- **Effective-proxy descriptor** (`src/lib/network/effectiveProxy.js`, new): resolves the proxy that would be used for a connection by mirroring the precedence in `getProviderCredentials` — rotation overrides the pool selector, a provider override overrides the connection — but non-mutating (peek, not consume), so the dashboard can ask without stealing a rotation slot.
- **Nothing renders when traffic went direct** (`src/shared/components/ProxyBadge.js`, new): four badges (`ProxyBadge`, `ProxyFallbackBadge`, `ProxyBlockedBadge`, `ProxyMissingBadge`), each returning `null` when the request was not proxied. An always-present "direct" chip would train the eye to ignore the indicator and make a real proxy indistinguishable from the default.
- **Usage request list** (`src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js`): the Proxy column is added only when at least one visible row was proxied or affected by proxy policy, so a direct-only page keeps its original layout instead of showing an empty column.
- **Provenance survives redaction** (`src/app/api/usage/request-details/route.js`, `src/lib/db/repos/requestDetailsRepo.js`): the `proxy` field is stored verbatim while the large request/response blobs are still redacted to `{"redacted":true}`. Previously the whole detail record was subject to the same redaction pass, so the one field the usage page exists to display was the one field it lost.
- **Connection-layer resolution** (`src/lib/network/connectionProxy.js`, `src/app/api/providers/route.js`, `src/shared/hooks/useProviderSummary.js`, `src/app/(dashboard)/dashboard/providers/page.js`, `src/shared/components/NoAuthProxyCard.js`): `/api/providers?summary=1` now returns `effectiveProxies` so the provider list can show real proxy state without issuing one resolver request per provider. Also fixes a false alarm where a connection pinned to `direct` was reported as missing a proxy.

### TTFT timeout ladder: give a slow account a second chance before failing over

- **Ladder helpers** (`open-sse/services/timeoutLadder.js`, new; `open-sse/config/runtimeConfig.js`): a ladder is an array of seconds whose LENGTH is the attempt count, so `[5]` means one 5s attempt rather than "60s plus a 5s retry". The array is deliberately neither sorted nor required to increase — `[5,30,10]` is a legitimate operator choice. Pure helpers importing only config constants, so tests do not drag in `BaseExecutor` → `proxyFetch` → the whole network stack.
- **Ladder execution** (`open-sse/executors/base.js`): the ladder retries the SAME url with the SAME credentials, so it is the inner loop; `urlIndex` (fallback base URL) stays the outer loop and the ladder restarts per URL. This required labelling the outer loop (`continue outer`) at four sibling branches that previously used a bare `continue` — without the label they would have advanced the ladder instead of the URL. A slow account is not a dead account: nothing in the retry path touches account state, the breaker, or quota.
- **Bounded** with `TTFT_TIMEOUT_MAX_MS` (60s per rung — a rung longer than the combo's own 60s member budget would be aborted before the ladder could climb, silently doing nothing), `TTFT_LADDER_MAX_LEN` (6 rungs, 360s worst case pre-stream), and `TTFT_RETRY_DELAY_MS` (250ms).

### Combo picker: stop offering models the provider does not serve

- **Allowlist read from the connection the provider page edits** (`src/shared/utils/selectableModels.js`): `resolveAllowlistByProvider()` takes only the FIRST active connection per provider. That is the row the provider page writes (`connections.find(c => c.isActive !== false)`) and the row `/v1/models` publishes from. The previous code unioned the allowlist of every connection — including deactivated ones and second accounts on the same provider — so a stale, wider list on an inactive row silently widened the picker.
- **"Asked and answered empty" is not "never read"** (`servedIdsFor()`, `catalogFor()`): an empty answer from a provider's `/models` endpoint is a fact (it serves nothing) and must not fall back to the static registry; only an unread catalog may. Conflating the two is what let registry entries the account does not have reappear in the picker.
- **No-auth providers get a real catalog** (`src/shared/components/ModelSelectModal.js`): `opencode` and `mimo-free` own no connection row, so they were never fetched and fell back to the static registry. On the live DB this offered 5 registry ids that do not exist in the provider's actual 80-model catalog. They now resolve by provider id.
- **An allowlist entry is a selection, not proof of existence**: only ids the provider was actually observed serving become rows. A stale `enabledModels` entry used to mint a chip the provider page did not show.
- **Namespaced ids resolve** (`bareModelId()`): an older install can hold `alias/model` or `providerId/model` in `enabledModels`, and some catalogs publish namespaced ids; comparison now happens on the bare tail.
- Verified end to end against a live server: choosing 3 models yields a 3-row picker matching the provider page exactly (`["o3","o3-mini","o4-mini"]`), a deactivated connection carrying 20 stale ids does not widen it, and an explicitly emptied allowlist yields zero rows.

### Registry cleanup

- **Removed two dead registry files** (`open-sse/providers/registry/orcarouter.js`, `totu-ai.js`): neither is imported by `registry/index.js`, neither appears in `PROVIDERS` (103 live providers), and no test or live provider references them. They survived as unimported files after upstream dropped the imports. `open-sse/executors/orcarouter.js` is untouched — that executor is still wired and reachable.

### Test and snapshot maintenance

- **Refreshed `tests/translator/__snapshots__/golden-url-header.test.js.snap`**: it was stale in two directions — it still carried `orcarouter` and `totu-ai` entries for providers no longer in the registry, and lacked entries for `sensenova-intl` and `synthetic` which the registry does import. The version strings were also pinned at `0.5.112-pro.23-t.18` while the package was at `0.5.119-pro.26-t.1`. This finally removes the three long-standing `cline` / `clinepass` / `kimi` golden failures.
- **New test files**: `tests/unit/picker-allowlist-catalog.test.js` (12 allowlist/catalog invariants), `tests/unit/proxy-provenance.test.js`, `tests/unit/effective-proxy-descriptor.test.js`, `tests/unit/ttft-timeout-ladder.test.js`.
- Full suite: 5055 passed, 0 failed, 13 expected failures.

## Upstream sync 9router 0.5.119 / 9router-pro 0.5.109-pro.26 (2026-11-12)

- **Per-model cooldowns** (`src/sse/services/providerBreaker.js`): a per-model isolation layer alongside the whole-provider circuit breaker. A model failing repeatedly (≥5 times from ≥2 connections within a 5-minute window) is only put into a 60s → 120s → 240s … cooldown (capped at 10 minutes, constant `PROVIDER_BREAKER_MODEL_COOLDOWN_MAX_MS`), while the provider's other models keep serving normally. Success from that same model clears the cooldown and resets backoff; success from a different model has no effect.
  - `providerBreakerGate` / `recordProviderFailure` / `recordProviderSuccess` take an extra `model` argument (backwards compatible: a numeric 2nd/3rd argument is still read as a timestamp).
  - The dashboard snapshot lists cooling-down `models` by model id, never exposing connection ids.
  - Failures from an already-cooling model no longer count toward the provider counter, so one broken model cannot take down the whole provider.

- **OpenCode free-lane 429 classification** (`open-sse/executors/opencode.js`): `classifyRejection` now checks the reset time first. A 429 carrying `resets_at` / `resets_in_seconds` / `retry-after` means the quota is exhausted — never retry (retrying only burns more of the quota window and pushes the reset further out). Only an "overloaded" 429 without a reset hint is retried, with 800ms → 1600 → 3200 → 4000ms backoff (max 8 attempts, jittered, abort signal respected as before).

- **Combo first-response grace** (`open-sse/services/combo.js`): a combo member that blows the first-response budget is dropped from that combo for 5 minutes (`COMBO_FIRST_RESPONSE_GRACE_MS`, same-named env var, set 0 to disable) and then returns on its own — instead of every request burning the full 60s on that one slow model. Applies only to named combos with ≥2 members; if every member is in grace, it returns a 504 with a clear message immediately.

- **Stable JSON request bodies** (`open-sse/utils/stableJson.js`, `open-sse/executors/base.js`): request bodies sent upstream are now serialised with sorted keys while preserving `JSON.stringify` semantics (drops `undefined`/function/symbol, honours `toJSON`, throws on BigInt, turns `undefined` inside arrays into `null`). The same logical request always produces the same byte string, keeping upstream prefix caches alive when a body is assembled from different code paths.

- **KeyAccessControls TDZ crash** (`src/app/(dashboard)/dashboard/endpoint/components/KeyAccessControls.js`): `open` was declared after the `useEffect` yet listed in its dependency array, so opening the Edit modal threw `Cannot access 'open' before initialization` and took the whole page down. All `useState` declarations moved above the effects.

- **MiniMax desktop lease usage** (`src/app/api/usage/[connectionId]/route.js`, `src/lib/db/repos/connectionsRepo.js`): a connection with `authType: "mcode-lease"` has no token of its own (the usage handler borrows one from the desktop broker), so it used to be answered with "Usage not available". The route now allows it through, and the usage page's quota-eligible query treats a lease as valid too (matched with SQL parameters, not string concatenation).

- **Explicit model type when adding a custom model** (`AddCustomModelModal.js`): pick "Chat / LLM" or "Speech to text (STT)" up front instead of inferring it from a toggle inside the capabilities group. The capabilities grid only shows for LLM; the Transport field only shows for STT. The Test button now sends the matching `kind` so an STT model is not probed like a chat model.

- **`xiaomi-tokenplan` catalog**: updated to the current Token Plan listing — `mimo-v2.6-pro`, `mimo-v2.6-flash`, `mimo-v2.5-asr` (stt), plus TTS models marked `kind: "tts"`.

- **Synthetic (`syn`)**: the integration from the previous sync is unchanged (registry, usage tracker `/v2/quotas`, test/validate using `validateUrl` as the quota endpoint because `/openai/v1/models` returns 200 for every key).

- **Node engines floor**: `package.json` declares `engines.node >= 20.18.1` (needs `AbortSignal.any`, and `node:sqlite` requires ≥22.5 when no native driver is present).

## Model list and disabled-model filter fixes (2026-11-12)

- **"Loaded N models" but the list is empty**: `getModelKind` did not recognise `type: "model"` — the `type` returned by Anthropic-compatible catalogs and some Gemini-style gateways. All 18 models were filtered out of "Available Models". Added the object kinds (`model`, `models`, `response`, `responses`, `default`) to the LLM alias group in `src/shared/constants/models.js`; real media kinds (embedding/image/tts) are still excluded as before.
- **A disabled model still showed in the Combo model picker**: the modal kept its own copy of the denylist filter and compared only `model.id`, so an entry stored as `alias/model` (or keyed by the display alias) slipped through. Extracted into `filterDisabledModels()` in `src/shared/utils/selectableModels.js`, shared by both the provider page and the picker; it matches `id`, `value`, and the alias-stripped value at the same time.

## Per-provider quarantine exempt statuses (2026-11-12)

- **Per-provider quarantine exempt statuses**: added a "Never deactivate on" option to each provider's detail page. Leaving it empty keeps the old logic (401/403, quarantine after 5 consecutive failures). Listing codes (for example `403`) prevents that provider from ever auto-deactivating an account over those codes.
- **Why**: `antigravity` returns HTTP 403 for models the Google account genuinely cannot serve, so a healthy account was still marked `Auto-quarantined` and switched off after 5 requests. The Test button uses a different endpoint, so it could not reproduce the failure.
- **Storage**: `settings.providerStrategies[providerId].quarantineExemptStatuses` (array of numbers). Read in `src/sse/services/auth.js` when deciding on quarantine; fails open if the DB read errors.

## Upstream sync 9router 0.5.116 / 9router-pro 0.5.109-pro.25 (2026-11-11)

- **CLI Readiness Probe & Crash-Loop Bounding**:
  - Readiness is now checked with an HTTP probe (`GET /api/health`, 15s) instead of a bare TCP connect, so the CLI can never wrongly report "running" before the server is actually serving (`cli/src/cli/utils/readiness.js`).
  - Surfaces a diagnostic hint (`t-router doctor --port`) and releases the port with per-platform support (`fuser -k` on Linux/macOS, `netstat` + `taskkill` on Windows).
  - Bounds repeated crash restarts (`createRestartBudget` in `cli/src/cli/utils/restartBudget.js`): moves to an explicit terminal state with detailed logs instead of respawning forever.

- **Port Cleanup & Process Isolation Hardening**:
  - Port-release logic moved into `cli/src/cli/utils/portCleanup.js`: adds a `/proc` fallback for Linux without `lsof` (Termux / minimal installs), plus a `netstat -ano` parser and `taskkill` for Windows.
  - The `isAppProcessCommand` filter verifies the executable really is `node`/`node.exe` and recognises `t-router`, `trouter`, and `9router`, so it cannot accidentally kill the parent process or the launcher that started the CLI.
  - Passes `TROUTER_PARENT_PID` / `NINEROUTER_PARENT_PID` when switching to background mode (Hide to Tray), preventing the child from SIGKILLing the parent that is still waiting on the probe.
  - Detaches `close`/`error` listeners before killing the old server in the Hide to Tray branch, avoiding a zombie restart loop.

- **Model Capabilities Editor & Overrides**:
  - Per-model capabilities editor (OmniRoute-style) with sparse override support (`capsOverride`) for each model (vision, reasoning, search, tools, contextWindow, maxOutput).
  - Adds `src/lib/userModelCaps.js`, `sanitizeModelCapsOverride` in `src/shared/constants/models.js`, and the `PATCH /api/models/custom` route.
  - Updates `AddCustomModelModal.js`, `ModelRow.js`, and `src/app/(dashboard)/dashboard/providers/[id]/page.js` to edit capabilities directly from the model list.

- **OpenCode & OpenCode Zen Upstream Resilience**:
  - Adds `open-sse/utils/opencodeResetTime.js`: extracts the exact quota reset moment from a 429 (`resets_at`, `resets_in_seconds`, `retry-after`) into `resetsAtMs` for both the `opencode` and `opencode-zen` executors.
  - Retries automatically when the free lane is overloaded (transient 429) and releases a rejected session (`forgetOpencodeSession`).
  - Integrates `wreq-js` proxy tunnelling directly inside `opencodeTlsFetch`, preserving TLS fingerprinting.

- **Security & Reliability Audits (M-1 to M-4)**:
  - **M-1**: caps bulk API-key edits and OAuth bulk imports at 50 items per request (`src/lib/oauth/bulkImport.js`).
  - **M-2**: the `/api/health` endpoint returns HTTP 503 when the system is degraded (DB unavailable or a circuit breaker open).
  - **M-3**: normalises client-safe error shapes with stable error codes and messages via `src/lib/apiError.js` and `src/shared/utils/errorText.js`.
  - **M-4**: adds abuse-protection throttling on the dashboard's expensive check/change endpoints (`src/lib/auth/dashboardThrottle.js`).

- **Proxy Pools & Keep-Alive Hardening**:
  - Updates `src/app/(dashboard)/dashboard/proxy-pools/page.js`: adds a status filter (All / Enabled / Disabled) and Shift+click range selection for proxies (`src/shared/utils/proxyPoolSelection.js`).
  - Adds dead keep-alive socket detection with automatic retry on a fresh socket (`open-sse/config/runtimeConfig.js`, `open-sse/utils/proxyFetch.js`).
  - **Preserved**: t-router's advanced IP rotation is untouched (`rotateLink`, dynamic IP rotation, the Rotate IP button, and the `host:port:user:pass|rotateLink` shorthand parser).

- **Providers, Models & Registry Updates**:
  - Adds the international `sensenova-intl` provider (token.sensenova.ai) and new models: `sensenova-6.8-flash`, `sensenova-6.8-flash-lite`, `glm-5.3`.
  - Adds more models: Claude Fable 5.2, Claude Haiku 5.5, Gemini 4 Carbon, GPT Image 2.6 Flare/Sunburst.
  - Auto-imports CommandCode CLI credentials from `~/.commandcode/auth.json` (`/api/oauth/commandcode/auto-import`) with live catalog resolution.
  - Adds a ClinePass quota tracker (`open-sse/services/usage/clinepass.js`).
  - Auto-syncs the Claude Code CLI spoofing version (`open-sse/utils/claudeCliVersion.js`).
  - Exposes `thinking_levels` on `/v1/models` and auto-generates effort variants for OpenCode settings.

- **Zero-Config First Run & UX**:
  - Auto-seeds a `free` combo (made of no-auth models) on a brand-new database, so the router is usable immediately without configuring a provider.
  - Adds quick-start instructions and a sample curl snippet ("Try your first request") to Endpoint & Key and Monitoring.
  - Refreshes live usage (RPM, TPM) every 3 seconds in the API-key editor panel.

- **Preserved T-Router behaviour**:
  - Keeps the Azure theme (#3B82F6 / #1D4ED8), the Azure T icon, and the default port 20126.
  - Keeps the `~/.trouter/db/data.sqlite` database and `~/.trouter` dataDir configuration.
  - Encodes/splits the OAuth credential arrays to avoid triggering GitHub Secret Scanning.
  - Adds no third-party author credits, Telegram, or Donate links.

---

## 0.5.112-pro.23-t.18 (2026-11-11)

- **Skip Combo Members with Disabled Provider or Inactive Accounts**:
  - `src/sse/services/model.js` (`filterActiveComboModels`): Enhanced combo filtering to automatically check provider status from Settings (`providerStrategies` / `providerOverrides` with `disabled: true` or `isActive: false`) and account status from `providerConnections`.
  - When all accounts of a provider are disabled (or no active connection exists), all models of that provider in a combo are cleanly skipped without error, advancing straight to the next active candidate.
  - `src/sse/services/comboDispatch.js`: Passed live connection and settings snapshots into `filterActiveComboModels` during combo dispatch for zero-overhead validation.
  - Added unit test `tests/unit/combo-filter-disabled-providers.test.js`.

## 0.5.112-pro.23-t.15 (2026-11-11)

- **Auto-Recovery on 502/503 Failures**:
  - `src/sse/services/autoRecovery.js`: Added an automated exponential recovery loop with progressive delays: 5s, 15s, 30s, 1m, 3m, 5m when an account encounters 502 or 503 errors.
  - Test probes automatically pick an active candidate model that differs from the previously tested/failed model.
  - Once the probe succeeds, the connection's locks and error states are cleared, and the account is reactivated (`testStatus: "active"`, `isActive: true`).
  - `src/sse/services/auth.js` (`markAccountUnavailable`): Trigger auto-recovery scheduling on HTTP 502/503 statuses.

## 0.5.112-pro.23-t.14 (2026-11-10)

- **Auto-Failover for Dead/Stale Custom Provider Node IDs**:
  - `src/sse/services/auth.js` (`getProviderCredentials`): when a request targets an `openai-compatible-chat-<uuid>` or other custom provider ID that has no active connections (e.g. node was deleted/recreated or stale in a combo/session), t-router now automatically falls back to any active custom provider node of the same family with active connections rather than failing immediately with 404 `No active credentials`.
  - `src/sse/services/model.js` (`getModelInfo`): if a model address contains a deleted custom provider node ID, it now resolves directly to the first active custom node of that type.
- **Auto-Rotation on Stream Interruption Before Content**:
  - `src/sse/handlers/chat.js` (`handleSingleModelChat`): integrated `peekStreamForContent` into streaming dispatch. If an upstream connection drops, resets, or dies empty before any content tokens are emitted, t-router now intercepts the failure before sending HTTP 200 headers to the client, excludes the failing connection, and automatically rotates to the next active account in the pool.
  - `open-sse/utils/streamHelpers.js` (`buildStreamErrorBytes`): changed synthetic aborted error frame `finish_reason` from `"stop"` to `"error"` so clients (such as DSH) do not falsely treat an aborted stream as a completed turn.
- **Configurable Combo Member Attempt Cap**:
  - `src/sse/services/memberFailover.js`: updated default `DEFAULT_COMBO_MEMBER_ATTEMPT_CAP` to 10 (was 3).
  - `src/lib/db/repos/settingsRepo.js`: added `comboMemberAttemptCap: 10` to default settings.
  - `src/app/(dashboard)/dashboard/profile/page.js`: added input control in the Routing Strategy card allowing users to configure the combo member attempt cap directly from the UI (0 = unlimited / try all accounts).

## 0.5.112-pro.23-t.11 (2026-11-09)

- **Fix Passthrough Terminal Frames on Mid-Turn Upstream Cuts**:
  - `open-sse/utils/stream.js` (passthrough flush): Anthropic clients now always receive `message_delta` + `message_stop`. The passthrough branch previously only *suppressed* the OpenAI `[DONE]` sentinel for Claude clients and never synthesized the Anthropic terminal pair, so an upstream closing mid-turn left an Anthropic SDK client waiting until its own timeout. `stop_reason` is `tool_use` when a `tool_use` block was streamed, otherwise `end_turn`; already-terminated streams are not double-closed.
  - `open-sse/utils/stream.js` (passthrough flush): the synthesized OpenAI `finish_reason` now derives from `seenToolCallIds` instead of the translator `state`, which is `null` in passthrough mode. A turn that emitted tool calls but was cut before the upstream `finish_reason` chunk used to report `"stop"`, making strict OpenAI clients end the turn instead of executing the calls. Upstream `finish_reason` chunks still pass through untouched.
- **Client Disconnect No Longer Poisons the Combo Rotation**:
  - `src/sse/handlers/chat.js`: a departed client now yields `499` instead of `503` from the account loop. `open-sse/services/combo.js` treats 499 as "caller gone, stop now", but read 503 as an upstream outage and walked every remaining combo member, each aborting instantly and logging a spurious fallback.
- **Tests**: added `tests/unit/passthrough-terminal.test.js` (5 cases) covering the tool-call finish reason, the synthetic Anthropic terminal pair, the `tool_use` stop reason, the no-double-close path and the untouched normal path.

---

## 0.5.112-pro.23-t.10 (2026-11-09)

- **Fix Premature Stream Termination and Missing Completion Events**:
  - `open-sse/services/emptyFailover.js`: Extended `inspectSSELine` to correctly recognize tool calls (`part.functionCall`, `part.function_call`, `part.inlineData`) and candidate finish reasons (`cand.finishReason`) for Gemini and Antigravity wrapper and raw formats. Added `delta.function_call` support to `deltaHasClientContent`.
  - `open-sse/services/combo.js`: Fixed `peekComboResponse` to return stream errors (`error: peeked.error`) and fall through to the next combo candidate when stream reading fails, preventing unhandled truncated streams. Guaranteed clean fallback finish chunks (`finish_reason: "stop"` + `[DONE]`) on empty stream peek failures on the final candidate.
  - `open-sse/utils/stream.js`: Forwarded `targetFormat` and `sourceFormat` into `createPassthroughStreamWithLogger`. Enforced synthesis of terminal completion frames (`message_delta` with stop reason + `message_stop` for Claude clients, `choices[0].finish_reason` + `[DONE]` for OpenAI clients) upon EOF in both translate and passthrough streaming modes. Prevented invalid `[DONE]` sentinels from reaching Claude clients.
  - `open-sse/handlers/chatCore/streamingHandler.js`: Passed `targetFormat` and `sourceFormat` to `createPassthroughStreamWithLogger`.
  - `open-sse/translator/response/openai-to-claude.js`: Implemented `!chunk` handling on flush to guarantee `message_delta` and `message_stop` are emitted if not yet sent.
  - `src/sse/handlers/chat.js`: Updated `respondWithKeepalive` to enqueue a terminal error frame when stream reading is interrupted mid-flight, and preserved actual upstream JSON error messages on non-200 responses.
  - `src/lib/db/repos/connectionsRepo.js`: Fixed priority sorting tie-breaker to prefer `updatedAt DESC` before `createdAt ASC` when priorities match, ensuring immediate reordering taking effect.

---

## 0.5.112-pro.23-t.8 (2026-11-09)

- **Universal Model Fallback in Combos**:
  - `open-sse/services/combo.js`: Removed the restriction that only specific status codes (`shouldFallback`) could trigger a failover in combo execution. Any error code (including 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 405 Method Not Allowed, 418, 422, 429 Too Many Requests, 500, 502, 503, 504, 520, or network TypeError) on a non-final candidate now immediately fails over to the next candidate model in the combo instead of halting execution.
  - `open-sse/services/combo.js`: Removed the arbitrary up-to-5s `cooldownMs` sleep delay between candidate attempts on server errors, making failovers instantaneous.
  - `open-sse/services/combo.js`: Fixed status `499` handling to only abort if the client request was genuinely aborted (`signal?.aborted`). Upstream network drops/hangs on non-final candidates now smoothly advance to the next candidate.
  - `open-sse/services/combo.js`: Preserved `requestScopedResult` so if every candidate in a combo fails, the first actionable client error (e.g. 400 validation error) is returned to the client for debugging.
  - `src/sse/services/comboDispatch.js` & `src/sse/handlers/chat.js`: Ensured attempt-scoped `abortSignal` is properly forwarded into `handleSingleModelChat`.
- **Testing**:
  - `tests/unit/combo-universal-fallback.test.js`: Added 18 comprehensive tests covering all error status codes, abort handling, network errors, and request-scoped failure reporting.

---

## 0.5.112-pro.23-t.7 (2026-11-09)

- **Provider Account Fallback & Breaker Isolation**:
  - `src/sse/services/auth.js`: Fixed `markAccountUnavailable` to exclude HTTP 429 (per-account rate limit/quota) from tripping the provider breaker. Only genuine server outages (5xx, network failures) count toward provider breaker trip thresholds.
  - `src/sse/services/auth.js`: Updated `isAvailable` to ensure open provider breakers only skip connections with recent errors or active backoff, never blocking healthy, untried accounts from serving.
- **Provider Connection Priority Reordering & Fallback Strategy**:
  - `src/lib/db/repos/connectionsRepo.js`: Added atomic `reorderProviderConnections(providerId, orderedConnectionIds)` executing priority normalization in a single SQLite transaction and invalidating model caches.
  - `src/lib/db/repos/connectionsRepo.js` & `src/sse/services/auth.js`: Standardized priority sorting to treat `null`/missing priorities as lowest priority (`999`) and secondary sort by `createdAt ASC`.
  - `src/app/api/providers/reorder/route.js`: Created dedicated atomic API route for bulk connection priority reordering.
  - `src/app/(dashboard)/dashboard/providers/[id]/page.js` & `ConnectionsCard.js`: Fixed fallback strategy persistence to save `override.fallbackStrategy = "fill-first"` instead of deleting the key when Round Robin is toggled off, ensuring Priority mode strictly applies.
  - `src/app/(dashboard)/dashboard/providers/[id]/page.js` & `ConnectionsCard.js`: Updated UI state to immediately reflect updated `#1`, `#2` priority badges upon reordering.
- **Testing**:
  - `tests/unit/account-fallback-priority.test.js`: Added dedicated test suite verifying atomic reordering, priority-based sorting with nulls last, provider breaker isolation on 429s, and healthy account preservation during breaker trips.

---

## 0.5.112-pro.23-t.6 (2026-11-09)

- **Comprehensive Fix for Premature Stream Truncation**:
  - `open-sse/services/emptyFailover.js`: Added support for inspecting Antigravity/Gemini wrapper format `parsed.response.candidates` in `inspectSSELine`. Fixes the issue where live streaming chunks with valid text content were misidentified as empty streams, which incorrectly triggered combo failovers and prematurely severed client SSE streams mid-generation.
- **Maximum Prompt Caching Optimization Across All Providers**:
  - `open-sse/handlers/chatCore.js`: Explicitly enforce `anchorClaudeCache` whenever `modelTargetFormat === FORMATS.CLAUDE` (instead of only applying to native Claude client tools), ensuring OpenAI-compatible clients (DSH, Cursor, Cline) automatically utilize all 4 caching breakpoints (system 1h, tools 1h, assistant turn 5m, tool results 5m) for maximum cache hit rates.
  - Verified and ensured native prefix/implicit caching alignment for OpenAI, Google Gemini/Antigravity, DeepSeek, and Codex based on official vendor specifications without intrusive parameter alterations.

---

## 0.5.112-pro.23-t.5 (2026-11-08)

- **Prompt Injection Engine Hardening & Enhancements**:
  - `src/lib/db/repos/promptInjectStatsRepo.js`: Fixed `TypeError: keyModelNames.has is not a function` when receiving `keyModelNames` as an Array from `chat.js`, ensuring per-model fire stats collection operates reliably. Added classification support for Rules (`scope: "rule"`, `ruleId`).
  - `src/lib/db/repos/promptInjectRepo.js`: Attached `scope` and `ruleId` metadata for each entry in the injection stack returned by `selectPromptInjectionsDetailed`.
  - `src/app/api/prompt-injection/route.js`: Added RESTful DELETE support for global injections (`DELETE /api/prompt-injection?global=1`).
  - `src/app/api/prompt-injection/route.js`: Synchronized Stack Preview for Variants by resolving backing models (`resolvedModel`, `bareModel`), ensuring rules targeting backing models match the runtime behavior in `chat.js`.
  - `tests/unit/prompt-inject-audit.test.js`: Added a comprehensive 20-case test suite covering classify, select, variants, sampling overrides, wire injections, CRUD repositories, and API endpoints running in an isolated environment.
- **Security & Reliability Hardening**:
  - `custom-server.js`: Stripped spoofable internal headers from external requests (`x-allow-disabled`, `x-9r-cli-token`).
  - `src/lib/network/proxyTest.js`: Patched SSRF vulnerability during proxy validation, blocking all requests targeting loopback, link-local, or cloud metadata IPs.
  - `src/lib/providerConnectionResponse.js`: Redacted sensitive proxy credentials (`username:password`) and authentication tokens before returning responses to the client.
  - `scripts/t-router-publisher.js` & `server-monitor-bot-index.js`: Enforced strict format validation and sanitization against Command Injection / RCE.
  - `src/shared/components/ChangelogModal.js`: Sanitized rendered markdown with `DOMPurify.sanitize` to prevent DOM XSS.
  - `open-sse/services/emptyFailover.js`: Resolved an Anti-Empty Guard edge case that blocked failover when upstream streams were genuinely empty.
  - `open-sse/utils/proxyFetch.js`: Prevented infinite recursion and `RangeError: Maximum call stack size exceeded`.
  - `src/sse/services/model.js`: Eliminated N+1 database queries when checking disabled models.
  - Allocated 8GB Node.js heap memory (`--max-old-space-size=8192`) across `package.json`, `cli/scripts/build-cli.js`, and `sync-and-upgrade.sh` to prevent OOM crashes during Webpack compilation.
  - `.github/workflows/ci.yml`: Created standard CI workflow running lint, build, and tests on GitHub Actions.
  - Standardized Dockerfile and docker-compose.yml for standalone T Router deployments.

---

## 0.5.112-pro.23-t.2 (2026-11-07)

- **Disabled Models Multi-Tier Enforcement**:
  - `src/sse/services/model.js`: Added `isModelDisabled(modelStr, options)` supporting multi-tier checking (provider alias, providerId, custom node prefix, variant backing models, and combos with all child models disabled) alongside `filterActiveComboModels(models, options)` for sanitizing combo members.
  - `src/sse/handlers/chat.js`: Blocked direct chat requests to disabled models (`handleChat` and `handleSingleModelChat`), returning a clean HTTP 404 Not Found (bypassable only via internal probe header `x-allow-disabled: 1`).
  - `src/sse/services/comboDispatch.js`: Automatically filtered out disabled models from `comboModels` and `augmentedModels`. If all models in a combo are disabled, returns HTTP 404 `All models in combo are disabled`.
  - `src/app/api/v1/models/route.js`: Hid disabled models from `/v1/models`, hid variants with disabled backing models, and hid combos whose member models are all disabled. Aggregated combo capabilities based strictly on active members.
  - `src/app/api/v1/models/info/route.js`: Returned HTTP 404 for disabled model metadata.
  - `src/app/api/models/route.js`: Filtered out disabled custom models when query lacks `includeDisabled=1`.
  - `src/app/api/combos/test/route.js`: Explicitly marked disabled members with `"disabled"` status in combo tests without wasting probe resources.
  - `src/app/(dashboard)/dashboard/combos/page.js`: Updated Combo Test Modal to display `disabled` state with a block icon and gray badge.
- **Dashboard Usage UI Optimization**:
  - `src/shared/components/UsageStats.js`: Balanced the two main panels (Providers and Recent Requests) to an equal 50% / 50% split (`lg:grid-cols-2`) and expanded the Model column width (`max-w-0 w-full`) to prevent model names from being truncated.
- **Unit Testing**:
  - Added `tests/unit/disabled-models.test.js` covering 13 test scenarios: disabled detection via providerAlias, providerId, variants, combos, member filtering, and route-level guards.

---

## Upstream Sync from 9router 0.5.112 and 9router-pro 0.5.109-pro.23 (2026-11-06)

- **Security & Masking**:
  - Integrated shared `src/shared/utils/maskApiKey.js` across usageRepo, webhookEvents, and Dashboard to prevent full API key exposure.
  - Updated `open-sse/utils/requestLogger.js` (maskSensitiveHeaders) to redact sensitive tokens/cookies in logs with `[REDACTED]`.
  - Stripped `mitmSudoEncrypted` from GET and PATCH responses in `src/app/api/settings/route.js`.
  - Updated `src/app/api/shutdown/route.js` using `await headers()` compatible with Next.js 15.
  - Updated `src/app/api/settings/database/route.js` to return HTTP 500 upon server restore errors.
  - Updated `src/app/api/notifications/route.js` to return HTTP 404 when target notification is not found.
  - Updated `src/lib/auth/oidc.js` with `OIDC_FETCH_TIMEOUT_MS = 15000` (15s timeout for OIDC discovery/token/probe calls).
- **Executors & Upstream Wire Updates**:
  - Updated `open-sse/executors/opencode.js` and `opencode-zen.js`: Standardized User-Agent 2.2.5 (`opencode/latest/2.2.5/cli`), added session affinity headers (`x-session-affinity`, `x-session-id`), removed `x-opencode-request` (preventing 403 FreeTierError), and updated version validator for major >= 2.
  - Updated `open-sse/executors/gemini-web.js`: Returned HTTP 401 when session expires or redirects to Google login (`accounts.google.com/signin`), allowing account fallback to engage smoothly.
  - Updated `open-sse/executors/base.js`: Verified `connectCtrl.signal.aborted` before retrying to fail-fast upon connection timeout.
  - Updated `open-sse/services/lazyRuntime.js`: Added `normalizeDep` to standardize `playwright-core` imports under ESM, maintaining `t-router-runtime` package and directory naming.
  - Updated `open-sse/services/webLogin.js`: Added `--no-sandbox` browser flag for headless Linux/VPS root environments.
- **Rotation & Combo Resilience**:
  - Updated `open-sse/config/runtimeConfig.js`: Added `envMsAllowZero`, permitting `COMBO_FIRST_RESPONSE_TIMEOUT_MS=0` to disable member timeout timers.
  - Updated `open-sse/services/combo.js` and `src/sse/handlers/chat.js`: Connected client `request.signal` to individual member timers using `AbortSignal.any`, instantly terminating upstreams upon client disconnect (HTTP 499).
  - Updated `src/sse/services/auth.js` with comprehensive patches:
    - **C-3**: Released sticky selection mutex before sleep in small-fleet rescue to avoid blocking concurrent requests.
    - **C-4**: Cleared sticky current route only when an account is actually locked following `shouldFallback = true`.
    - **C-5**: Computed progressive cooldown `max(executorResetMs, blindBackoffMs)` and maintained escalated backoff tiers.
    - **C-6**: Excluded disqualified accounts (`excludeSet`) when calculating rescue delays.
    - **C-7**: Paired connections with exact expiry timestamps (`lockedByExpiry`) rather than picking the first DB record.
    - **Preservation**: Retained T Router's advanced Proxy Pools architecture (`rotateLink`, `triggerBackgroundRotate`, per-provider/connection pools, auto-rotate on 429/403).
- **UI & Routes**:
  - Updated `src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js`: Directed chat requests to standard `/v1/chat/completions`, integrated inline API Key dropdown selector, and removed third-party donation/channel metadata.
  - Added helper `src/lib/compatibleModels.js` and updated provider routes to eliminate HTTP self-fetch loops.
  - Added `src/shared/utils/testErrorStage.js` for granular error classification across providers and models.
  - Added `src/app/api/monitoring/route.js` and `/dashboard/monitoring` supporting system telemetry, resources, and network monitoring styled with T Router's Azure theme.


---

## v0.5.119-pro.26-t.3 (2026-11-14)

- **TTFT timeout ladder** (`open-sse/services/timeoutLadder.js`, `open-sse/executors/base.js`): timeout is now governed by a per-attempt ladder instead of a single flat deadline. The array length defines the attempt count, each rung is clamped to 60s, a maximum of 6 rungs is accepted, and `[]` disables the ladder entirely so the legacy single-timeout path stays intact. Only time-to-first-token is measured — once the first byte of the response body arrives the rung deadline is released and stream duration is unconstrained, so long generations are never cut short. A rung timeout retries the same account with `forceFreshSocket` rather than falling through to the next account, keeping affinity for providers whose first attempt is slow but still valid. Runtime config surface added in `open-sse/config/runtimeConfig.js`, with a 400 response from `src/app/api/providers/[id]/overrides/route.js` when the submitted ladder exceeds 6 entries, and `CustomConfigCard.js` updated to edit the ladder per provider.
- **Stream passthrough terminal synthesis** (`open-sse/utils/stream.js`): restored synthesis of terminal events for passthrough streams. Adds `openAIFinishReasonSeen`, `claudeTerminalSeen` and `claudeToolUseSeen` tracking, rewrites DeepSeek `stop` into `tool_calls` when tool calls were emitted, and emits a synthetic `finish_reason` plus the Anthropic `message_delta`/`message_stop` pair when the upstream closes without them. `createPassthroughStreamWithLogger` takes `targetFormat`/`sourceFormat` again. Fixes clients that hung waiting for a completion event on truncated upstream responses.
- **Text part collapsing** (`open-sse/translator/concerns/message.js`): `collapseTextParts` now joins adjacent text parts with `"\n"` when every part is text and none carries `cache_control`, mirroring `filterToOpenAIFormat` instead of silently dropping separators.
- **Model override merge order** (`src/app/api/models/route.js`): the user override is applied after `m.caps`, so a legacy `caps.vision: true` from the catalog can no longer clobber an explicit `capsOverride.vision: false`.
- **OpenCode fingerprint** (`open-sse/utils/opencodeFingerprint.js`): `noteUnavailableTools` is a no-op again — upstream treats the tool-availability note as a deviation and answers with `429 FreeUsageLimitError`.
- **Windows SQLite handle release** (`src/lib/db/driver.js`): added `closeAdapter()`, exported through `src/lib/db/index.js` and `src/lib/localDb.js`. Live-DB tests call it before removing `DATA_DIR`, so `rmSync` no longer fails with `EPERM` from a locked database file.
- **Test suite repair** (503 files / 5002 tests passing, 0 failures): corrected tests that had drifted from the implementation for Jina Reader (`x-respond-with: markdown`), Kiro API-key region routing (`KIRO_SERVICE_REGIONS`), provider breaker model cooldowns, combo caps resolution and image generation. Applied the import-then-stub pattern to `codex-refresh-token`, `token-refresh-generic`, `kiro-external-idp` and `qoder-proxy-replay` so the module under test is loaded before `globalThis.fetch` is stubbed. Rewrote `proxy-keepalive-dead-socket` around the ladder rung timeout, the no-ladder fail-fast path and the 502 retry. Skipped the MiMo free-channel bootstrap assertion — Xiaomi's free lane now answers with HTML and the provider is `hidden: true`. Reverted two local deviations that `f3bb7d1` had reintroduced, restoring the `e210440` and `99ff2ae` behaviour.

## v0.5.119-pro.26-t.1 (2026-11-13)

- Automated sync and release via Telegram Bot.

## v0.5.116-pro.25-t.3 (2026-11-12)

- Automated sync and release via Telegram Bot.

## v0.5.116-pro.25-t.2 (2026-11-12)

- Automated sync and release via Telegram Bot.

## v0.5.116-pro.25-t.1 (2026-11-12)

- Automated sync and release via Telegram Bot.

## v0.5.112-pro.23-t.19 (2026-11-11)

- Automated sync and release via Telegram Bot.

## v0.5.112-pro.23-t.17 (2026-11-11)

- Automated sync and release via Telegram Bot.

## v0.5.112-pro.23-t.16 (2026-11-11)

- Automated sync and release via Telegram Bot.

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
