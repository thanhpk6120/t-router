# T Router — Changelog

This changelog records all updates, enhancements, and releases specific to **T Router**.
Upstream changelogs (`CHANGELOG.md` and `CHANGELOG-PRO.md`) are kept intact for clean 3-way git merges from upstream repositories.

---

## Upstream Sync (9router 0.5.109, 9router-pro 0.5.109-pro.13)

- **Đồng bộ Upstream 9Router Pro v0.5.109-pro.13**:
  - **Sticky-random routing**: Bổ sung chiến lược điều hướng tài khoản mới — gắn kết với một API key đang hoạt động cho đến khi bị khóa/lỗi (429/403/cooldown), sau đó random chọn sang key khả dụng khác. Tối ưu prompt-cache retention và hạn chế phân tán key.
  - **Variant Backing AUTO Resolution**: Tự động chuẩn hóa prefix alias của custom provider thành routable node id khi lưu variant, lưu combo và import backup (loại bỏ hoàn toàn lỗi 404-alias runtime).
  - **Variant Prompt Injection qua Combo Members**: Hỗ trợ luồng prompt injection cho các variant khi là thành viên của Combo (combo members), đảm bảo prompt của variant được kích hoạt đúng đắn ngay cả khi gọi qua combo.
  - **Nhãn hiển thị Backing thân thiện (Friendly Backing Labels)**: Hiển thị `<prefix>/<model>` thay vì UUID nội bộ trên mọi giao diện (thẻ combo, form chỉnh sửa, modal chọn model, trang prompt injection); tự động bỏ qua request 404 cho icon của custom provider nodes.
  - **Tối ưu hóa render Provider/Combo**: Memoize danh sách active provider IDs giúp tăng tốc độ kiểm tra trạng thái và render tức thì.
  - **Tự động nhận diện Capability Search cho Combo**: Hỗ trợ tự động chuyển đổi sang model có khả năng search khi request gửi kèm tool dạng search/fetch (`web_search`, `web_fetch`).
  - **Hỗ trợ NDJSON stream và text parts collapsing**: Tự động parse các dòng JSON thô trong SSE stream và collapse các text parts thành chuỗi đơn giản khi gửi sang endpoint OpenAI-compatible nghiêm ngặt.
  - **Fuzzy Token Fallback cho Cursor Auto-Import**: Tự động tìm kiếm token và machine ID theo cơ chế fuzzy scan nếu Cursor đổi tên storage key qua các phiên bản mới.
  - **Bảo toàn 100% ràng buộc T-Router**:
    - Giữ nguyên màu chủ đạo Azure (#3B82F6 / #1D4ED8) và icon Azure T.
    - Giữ nguyên Database Location tại `~/.trouter/db/data.sqlite` và dataDir `~/.trouter`.
    - Cổng mặc định duy trì là 20126.
    - Đảm bảo chức năng Round Robin trong Settings tắt bật bình thường.
    - Giữ nguyên hệ thống Universal Proxy Pools & Rotation cho mọi provider, bao gồm Direct proxy guard, `rotateLink` (Dynamic IP Rotation), nút Rotate IP, Proxy Source (`both`/`static`/`rotating`), auto-rotate trên 429/403/cooldown và shorthand parser.

---

## Upstream Sync (9router 0.5.109, 9router-pro 0.5.109-pro.12)

- **Đồng bộ Upstream 9Router Pro v0.5.109-pro.12**:
  - Tích hợp bản vá đóng gói packaging fix cho phân phối slim npm từ upstream 9router-pro v0.5.109-pro.12.
  - Duy trì toàn diện tính năng variant-based prompt injection, sửa lỗi crash trang injection và tối ưu phân trang proxy pools.
  - Bảo đảm tương thích toàn bộ hệ thống Universal Proxy Pools & Rotation cho tất cả provider, giữ nguyên cổng 20126, đường dẫn `~/.trouter`, theme Azure (#3B82F6) và icon Azure T.
- **Prompt Injection (Variant-based)**:
  - Chuyển đổi prompt injection sang cơ chế variant-based: prompt gắn với tên variant tùy chỉnh thay vì model gốc.
  - Variant là một tên tùy chỉnh liên kết với chính xác 1 provider/model gốc kèm prompt. Khi gọi theo variant name sẽ áp dụng prompt; khi gọi theo raw model name sẽ không bị ảnh hưởng.
  - Tự động tạo và đồng bộ single-member combo tương ứng cho variant.
  - Tự động migrate các cấu hình prompt injection dạng model cũ sang variants trên lần đọc đầu tiên.
- **Sửa lỗi crash trang Prompt Injection**:
  - Loại bỏ hoàn toàn khối code thừa từ UI copy-to-providers gây crash toàn bộ trang khi render trên trình duyệt.
- **Phân trang Proxy Pools (Pagination & Filtering)**:
  - Bổ sung phân trang phía server (hỗ trợ pageSize 10, 20, 50) và tìm kiếm theo tên pool (`search`), giúp tối ưu hóa hiệu năng và bộ nhớ khi quản lý số lượng lớn proxy pools.
  - Lựa chọn theo trang kết hợp lưu trữ cross-page selection cho bulk actions.
  - Tương thích 100% với Universal Proxy Pools & Rotation của T Router.

---

## v0.5.109-pro.13-t.1 (2026-10-26)

- **Fix Antigravity / Gemini Multi-turn Function Calling & System Instruction Loss**:
  - Hỗ trợ đầy đủ `role: "developer"` (OMP, Codex) khi chuyển đổi sang Gemini/Antigravity (`openaiToGeminiRequest`), tránh việc rơi rụng toàn bộ system prompt cốt lõi của agent.
  - Tích lũy toàn bộ các `system` và `developer` messages vào `systemInstruction.parts` thay vì gán đè làm mất system prompt trước đó.
  - Sửa `thoughtSignatureStore.js`: cho phép tái sử dụng `thoughtSignature` theo đúng `toolCallId` bất kể model alias (tránh việc ánh xạ `claude-sonnet-5` sang Gemini bị từ chối signature dẫn đến hỏng trạng thái gọi tool nhiều lượt).
  - Tự động phát hiện và bóc tách các cú pháp tool call bị rò rỉ vào text (`call:default_api:...`) trong stream response của Gemini để chuyển đổi ngược về OpenAI `tool_calls` delta chuẩn với `finish_reason: "tool_calls"`.

## v0.5.109-pro.12-t.8 (2026-10-26)

- **Proxy Direct Guard Condition Refinement**:
  - Chỉ áp dụng logic chặn fallback về IP trực tiếp (Direct) khi provider đã chủ động bật/chọn sử dụng proxy (qua Proxy Pool, Rotation Strategy hoặc connection proxy).
  - Đối với các provider không kích hoạt proxy, hệ thống tự động kết nối trực tiếp bình thường (kể cả khi pool 'Direct' trong Proxy Pools đang ở trạng thái tắt).
  - Đảm bảo an toàn tuyệt đối chống leak IP cho các kết nối proxy nhưng không ảnh hưởng đến các provider chạy trực tiếp.

## v0.5.109-pro.12-t.6 (2026-10-26)

- **Cố định Proxy Direct trong Proxy Pools & Chống rò rỉ IP (No Direct Leak)**:
  - Proxy Pools luôn có một proxy mặc định tên "Direct" đại diện cho đường truyền trực tiếp không qua proxy.
  - Cho phép người dùng chủ động tắt (inactive) proxy "Direct" này để cấm hoàn toàn việc tự động fallback về mạng trực tiếp khi các proxy active bị lỗi hoặc quá tải.
  - Khi Direct bị tắt, hệ thống từ chối fallback về IP máy chủ và trả về lỗi rõ ràng để bảo vệ an toàn danh tính IP.
- **Hỗ trợ Bật/Tắt (Toggle Active) OpenCode Free**:
  - Bổ sung công tắc bật/tắt hoạt động cho provider OpenCode Free như mọi provider khác.
  - Khi tắt, OpenCode Free chuyển sang trạng thái Disabled mờ 50% và không xuất hiện trong danh mục `/v1/models`.
- **Đồng bộ Rotation Strategies & Cấu hình Proxy cho tất cả Provider**:
  - Mở rộng đầy đủ các chế độ xoay vòng: None, Round-robin, Random, Fallback (Priority) cho toàn bộ các nhà cung cấp.
  - Giao diện cấu hình Proxy Pool & Rotation nhất quán trên tất cả các trang chi tiết provider.
- **Dynamic Tool Gating & Protobuf Schema Sanitization**:
  - Tự động nén và lọc thông minh danh sách MCP Tools khi vượt ngưỡng 64 tools, giữ trọn vẹn 100% Core Tools và Context Tools.
  - Làm sạch sâu JSON Schema, loại bỏ lỗi Protobuf của Google Gemini và ngăn ngừa vòng lặp retry ngầm trên Claude Code CLI.

---

## v0.5.109-pro.12-t.5 (2026-10-25)

- **Advanced Proxy Management & Dynamic IP Rotation (aligned with opencode2api)**:
  - **Rotate Link & Dynamic IP Rotation**: Hỗ trợ đầy đủ trường `rotateLink` (URL đổi IP) trên giao diện Proxy Pools (thêm mới, chỉnh sửa, batch import).
  - **Nút Xoay IP Ngay (Rotate IP)**: Cho phép đổi IP ngay lập tức trên từng Proxy Pool hoặc thực hiện hàng loạt (Bulk Rotate) trực tiếp từ giao diện với thông báo và hiển thị thời gian đổi IP gần nhất.
  - **Proxy Source Selection**: Bổ sung bộ lọc nguồn proxy (`both` | `static` | `rotating`) trong cấu hình xoay proxy của provider.
  - **Tự Động Đổi IP Khi Bị Chặn (Auto-Rotate on 429/403/Error)**: Tự động gọi rotate link khi gặp lỗi rate limit (429) hoặc bị chặn (403), kèm cơ chế cooldown 60s để chống spam API xoay proxy.
  - **Evict Socket Cache Khi Đổi IP**: Tự động giải phóng và đóng các kết nối keep-alive cũ trong `proxyDispatchers` ngay khi IP được xoay, đảm bảo request tiếp theo lập tức dùng IP mới thoát ra ngoài.
  - **Tự Động Xoay Định Kỳ (Auto-Rotate Due)**: Tự động đổi IP định kỳ cho các proxy pool xoay có thời gian đổi IP cũ hơn 30 phút.
  - **Hỗ trợ định dạng Shorthand đa dạng**: Hỗ trợ `host:port`, `host:port:user:pass`, `host:port:user:pass|rotateLink`, `host:port|rotateLink`, socks5 và URL chuẩn.

## v0.5.109-pro.12-t.4 (2026-10-25)

- Monotonic +1 version bump: upgraded to 0.5.109-pro.12-t.4 aligned with latest upstream 9router-pro.12.



- Automated sync and release via Telegram Bot.

## v0.5.109-pro.12-t.1 (2026-10-25)

- Automated sync and release via Telegram Bot.

## v0.5.109-pro.10-t.3 (2026-10-24)

- Automated sync and release via Telegram Bot.



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
