<div align="center">

# 🌐 T Router

**Cổng Điều Phối AI Hiệu Năng Cao & Router Prompt Engineering Đa Nhà Cung Cấp**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![NPM Version](https://img.shields.io/npm/v/t-router-proxy?color=007FFF)](https://www.npmjs.com/package/t-router-proxy)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![Default Port](https://img.shields.io/badge/Port-20126-3B82F6)](http://localhost:20126)
[![Theme](https://img.shields.io/badge/Theme-Azure-3B82F6)](https://github.com/thanhpk6120/t-router)

Một endpoint duy nhất tương thích hoàn toàn chuẩn OpenAI & Anthropic cho hơn **40+ nhà cung cấp AI** và **100+ mô hình**, tích hợp engine Prompt Injection đa quy tắc, xoay vòng Proxy Pools động đa giao thức, cơ chế kiểm soát model bị vô hiệu hóa đa tầng, tối ưu hóa Prompt Caching tối đa, quản lý hạn mức token và cơ chế tự phục hồi tài khoản thông minh.

[English](README.md) • [Tiếng Việt](README-vi.md) • [Bắt đầu nhanh](#-bắt-đầu-nhanh) • [Bảng so sánh tính năng](#-bảng-so-sánh-chi-tiết-t-router-vs-9router-vs-9router-pro) • [Điểm nổi bật](#-các-tính-năng-nổi-bật) • [Tích hợp CLI Tools](#-tích-hợp-các-công-cụ-cli--ide) • [Kiến trúc](#-kiến-trúc-hệ-thống)

</div>

---

## 📊 Bảng So Sánh Chi Tiết: T Router vs. 9Router vs. 9Router Pro

T Router được phát triển nhằm giải quyết triệt để các bài toán thực tế của môi trường doanh nghiệp và người dùng nâng cao mà cả 9Router gốc và 9Router Pro chưa đáp ứng được.

| Khả năng / Tiêu chí | 9Router (Bản Gốc) | 9Router Pro | 🌐 T Router (Dự án này) |
|---|---|---|---|
| **Định hướng cốt lõi** | Proxy trung gian & chuyển đổi giao thức đơn giản | Prompt injection đơn mục tiêu & hạn ngạch token bán lại | **Enterprise AI Gateway, Prompt Engine đa quy tắc & Hạ tầng Proxy xoay vòng mạnh mẽ** |
| **Quy tắc Prompt Injection** | ❌ Không hỗ trợ | ⚠️ Giới hạn 1 injection duy nhất cho mỗi đối tượng (1 Global, 1 Key, 1 Model) | **✅ Không giới hạn Rules + nhắm mục tiêu nhiều model & nhiều key cùng lúc + xem stack ưu tiên** |
| **Thứ tự xếp chồng Prompt** | ❌ Không có | ⚠️ Cố định 3 tầng (Global → Key → Model) | **✅ Độ ưu tiên linh hoạt, tự động nhận diện backing model của Variant & hiển thị Stack Preview** |
| **Kiểm soát Model Disabled** | ⚠️ Một phần (Model tắt vẫn gọi được trực tiếp hoặc qua combo) | ⚠️ Chỉ ẩn trên giao diện danh sách (vẫn gọi API được) | **✅ Đa tầng triệt để: chặn API 404, tự động lọc khỏi combo, ẩn khỏi danh mục & capabilities** |
| **Tối ưu Prompt Caching** | ⚠️ Thụ động (Phụ thuộc cấu hình mặc định của upstream) | ⚠️ Thụ động (Claude caching chỉ kích hoạt cho native tool) | **✅ Tự động gắn 4 breakpoints Claude cho cả client OpenAI (DSH, Cursor, Cline) + chuẩn hóa prefix** |
| **Chống ngắt Stream giữa chừng** | ❌ Dễ bị ngắt SSE stream đột ngột | ⚠️ Cơ chế retry cơ bản (thường xuyên bắt nhầm Antigravity/Gemini) | **✅ Phân tích chuẩn wrapper SSE của Gemini trong `emptyFailover` + bảo vệ kết nối client** |
| **Hạ tầng Proxy** | ⚠️ Hỗ trợ proxy đơn giản | ⚠️ Kiểm tra sức khỏe & xoay theo danh sách chọn lọc | **✅ Universal Proxy Pools: gán theo connection/provider, Xoay IP động (`rotateLink`), kiểm tra Exit IP** |
| **Cô lập Môi trường & Dữ liệu** | Cổng `20126`, đường dẫn chia sẻ chung | Cổng `20126`, đường dẫn chia sẻ chung | **✅ Cơ sở dữ liệu SQLite cô lập hoàn toàn (`~/.trouter/db/data.sqlite`) & cổng riêng biệt `20126`** |
| **Giao diện & Trải nghiệm** | Dark theme mặc định | Neumorphism phong cách kính tối | **✅ Giao diện Azure Blue hiện đại (`#3B82F6`), chia đều 50/50 bảng thống kê Usage, icon tối ưu nhẹ** |
| **Kiểm tra & Chẩn đoán Combo** | ❌ Không có | ❌ Không có | **✅ Modal Test Combo chuyên dụng: `peekRotatedModels()` không làm lệch thứ tự, đo latency & báo disabled** |
| **Lưu trữ Danh mục Model** | ❌ Gọi upstream mỗi lần tải trang | ❌ Gọi upstream mỗi lần tải trang | **✅ Lưu cache danh mục trong SQLite (`loadedModels`), mở trang tức thì & làm mới khi yêu cầu** |
| **Bảo mật & Gia cố Hệ thống** | Lọc dữ liệu cơ bản | Lọc dữ liệu tiêu chuẩn | **✅ Chống SSRF khi test proxy, chặn giả mạo header nội bộ, che giấu token/mật khẩu & chống XSS** |

---

## ⚡ Các Tính Năng Nổi Bật

### 🎯 Engine Prompt Injection Đa Quy Tắc Toàn Diện
- **Thiết lập Rule linh hoạt**: Khác với 9Router Pro chỉ cho phép duy nhất 1 prompt cho mỗi loại, T Router cho phép bạn tạo số lượng Rule không giới hạn, áp dụng đồng thời cho nhiều model và nhiều API key cùng lúc.
- **Xếp chồng thông minh (Prompt Stacking)**: Tùy biến thứ tự ghép nối prompt hệ thống (chèn trước hoặc chèn sau) và kịch bản hội thoại mẫu (giả lập lịch sử chat giúp định hình hành vi model sâu hơn nhiều so với system prompt). Hệ thống tự động phân giải model gốc của Variant để áp dụng chính xác.
- **Xem trước Stack (Stack Preview) & Thống kê**: Dễ dàng kiểm tra các rule sẽ được áp dụng trước khi gửi request thật và theo dõi số lần kích hoạt theo từng model và rule.

### 🛡️ Cơ Chế Vô Hiệu Hóa Model Đa Tầng Triệt Để
- **Bảo vệ toàn diện**: Khi một model bị disable trong dashboard, nó sẽ bị khóa hoàn toàn trên toàn bộ hệ thống.
- **Tự động lọc trong Combo**: Khi gọi combo, router sẽ tự động bỏ qua các model đã bị tắt. Nếu tất cả model trong combo đều bị tắt, hệ thống trả về mã lỗi HTTP 404 rõ ràng thay vì cố gắng gọi upstream gây lỗi.
- **Ẩn khỏi Danh mục & Năng lực**: Model bị disable sẽ tự động biến mất khỏi danh sách `/v1/models` và không tham gia vào việc tổng hợp capabilities (vision, thinking, tool calls).

### ⚡ Tối Đa Hóa Prompt Caching & Chống Ngắt Stream
- **Đầy đủ 4 Breakpoints Caching cho Claude**: Tự động tính toán và gắn cờ cache ephemeral (system 1h, tools 1h, assistant turn 5m, tool results 5m) cho các model Claude ngay cả khi client gửi định dạng OpenAI (như DSH, Cursor, Cline).
- **Chuẩn hóa Prefix Caching**: Hoạt động chính xác theo tiêu chuẩn kỹ thuật chính thức của OpenAI, DeepSeek, Google Gemini / Antigravity và Codex.
- **Khắc phục lỗi ngắt stream giữa chừng**: Sửa tận gốc cơ chế `emptyFailover` giúp router nhận diện chính xác các gói SSE chunk từ Antigravity/Gemini, chấm dứt hoàn toàn tình trạng đang stream chữ thì bị ngắt kết nối.

### 🔄 Universal Proxy Pools & Tự Động Xoay IP Động
- **Hỗ trợ Proxy cho tất cả 40+ Provider**: Dễ dàng thiết lập HTTP, HTTPS, SOCKS5 hoặc Serverless Relay cho từng provider hoặc ghi đè riêng cho từng connection.
- **Xoay IP động qua API**: Tích hợp các endpoint đổi IP (`rotateLink`) của nhà cung cấp proxy xoay, kèm nút bấm "Rotate IP" trực tiếp từ giao diện dashboard.
- **Kiểm tra IP Thực tế (Exit IP)**: Tính năng kiểm tra IP đầu ra thực tế (`probeExitIp`) giúp xác minh đường truyền mạng ra internet của proxy có thực sự hoạt động hay không.

### 🎨 Giao Diện Azure Hiện Đại & Lưu Trữ Độc Lập
- **Phong cách Azure Blue**: Tông màu xanh hiện đại (`#3B82F6` / `#1D4ED8`), bố cục bảng Usage chia đều 50% / 50% giúp đọc trọn vẹn tên model mà không bị che khuất.
- **Không xung đột dữ liệu**: Toàn bộ dữ liệu được lưu độc lập tại `~/.trouter/db/data.sqlite` và chạy mặc định trên cổng **`20126`**.

---

## 🚀 Bắt Đầu Nhanh

### Cách 1: Cài đặt toàn cục qua CLI (Khuyên dùng)

Cài đặt package npm toàn cục và khởi chạy bằng một lệnh duy nhất:

```bash
# Cài đặt toàn cục
npm install -g t-router-proxy

# Khởi chạy T Router (tự động mở dashboard tại http://localhost:20126)
t-router
```

Hoặc chạy trực tiếp mà không cần cài đặt:

```bash
npx t-router-proxy
```

### Cách 2: Chạy từ Mã Nguồn Git

```bash
# Clone repository
git clone https://github.com/thanhpk6120/t-router.git
cd t-router

# Cài đặt thư viện
npm install

# Khởi chạy chế độ phát triển (development)
npm run dev

# Hoặc biên dịch và khởi chạy production
npm run build
npm start
```

### Cách 3: Chạy bằng Docker Container

```bash
docker build -t t-router .
docker run -d \
  -p 20126:20126 \
  -v ~/.trouter:/root/.trouter \
  --name t-router \
  t-router
```

> **Thông tin đăng nhập mặc định:**
> - Đường dẫn Dashboard: `http://localhost:20126`
> - Mật khẩu mặc định: `123456` (Hệ thống sẽ yêu cầu đổi mật khẩu trong lần đầu đăng nhập)

---

## 🔌 Tích Hợp Các Công Cụ CLI & IDE

T Router hỗ trợ cấu hình một chạm cho tất cả các công cụ lập trình AI phổ biến:

| Công cụ | Giao thức hỗ trợ | Lệnh cấu hình / Biến môi trường |
|---|---|---|
| **Claude Code** | Anthropic Messages | `ANTHROPIC_BASE_URL="http://localhost:20126"` |
| **Cursor** | OpenAI / Claude | Base URL: `http://localhost:20126/v1` |
| **Codex CLI** | OpenAI Compatible | Cấu hình profile nhà cung cấp `trouter` |
| **OpenCode** | OpenAI Compatible | Cấu hình profile nhà cung cấp `trouter` |
| **OpenClaw** | OpenAI / Anthropic | Gateway URL: `http://localhost:20126/v1` |
| **GitHub Copilot** | MITM / Custom Provider | Tạo lệnh hook Copilot tự động trong Dashboard |
| **Hermes Agent** | OpenAI / Anthropic / STT | `hermes config` trỏ về endpoint `trouter` |

---

## 🏗️ Kiến Trúc Hệ Thống

```text
┌─────────────────────────────────────────────────────────────────┐
│                        Các Ứng Dụng Client                      │
│    Claude Code • Cursor • Codex • OpenCode • DSH • REST Tools   │
└───────────────────────────────┬─────────────────────────────────┘
                                │ HTTP / SSE (Cổng 20126)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                           T Router                              │
│                                                                 │
│  ┌────────────────────┐  ┌──────────────────┐  ┌─────────────┐  │
│  │ Xác thực & Quota   │  │  Engine Prompt   │  │ Bản đồ Mẫu  │  │
│  │ RateLimit/429/Keys │  │  Đa Quy Tắc      │  │ Combos/Caps │  │
│  └─────────┬──────────┘  └────────┬─────────┘  └──────┬──────┘  │
│            │                      │                   │         │
│            ▼                      ▼                   ▼         │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │       Kiểm Soát & Tự Động Lọc Model Bị Disable Đa Tầng    │  │
│  │           Chặn 404 • Lọc Combo • Ẩn Danh mục API          │  │
│  └────────────────────────────┬──────────────────────────────┘  │
│                               │                                 │
│                               ▼                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │      Điều Phối Fallback Tài Khoản & Chống Ngắt Stream     │  │
│  │        Balanced LRU • Anti-Flaky • Cache Breakpoints      │  │
│  └────────────────────────────┬──────────────────────────────┘  │
│                               │                                 │
│                               ▼                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │     Universal Proxy Pool, Xoay IP Động & Đo Exit IP       │  │
│  │       Round-Robin • Random • rotateLink • SOCKS/HTTP      │  │
│  └────────────────────────────┬──────────────────────────────┘  │
└───────────────────────────────┼─────────────────────────────────┘
                                │ Gửi request tới Upstream
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Các Nhà Cung Cấp Mô Hình AI                 │
│   Anthropic • OpenAI • Google Gemini • DeepSeek • Groq • v.v.   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📂 Cấu Trúc Thư Mục Dự Án

- `~/.trouter/` — Thư mục dữ liệu độc lập lưu trữ SQLite database, nhật ký vận hành và bộ nhớ đệm.
- `src/app/` — Dashboard Next.js App Router và các REST API endpoints.
- `src/sse/` — Động cơ stream thời gian thực, bộ điều phối combo và bộ lọc prompt injection.
- `open-sse/` — Lõi xử lý độc lập giao thức, các bộ chuyển đổi định dạng và executor adapter.
- `cli/` — Package CLI độc lập (`t-router-proxy`) tích hợp khay hệ thống (tray) và quản lý tiến trình nền.
- `CHANGELOG-T.md` — Lịch sử cập nhật và phát hành chuyên biệt cho T Router (tiếng Anh chuẩn mực).

---

## 📄 Bản Quyền

Dự án được phân phối dưới giấy phép nguồn mở [MIT License](LICENSE).
T Router kế thừa nền tảng từ 9Router và 9Router-Pro với các cải tiến kiến trúc chuyên sâu, môi trường thực thi độc lập và các tính năng mở rộng phục vụ môi trường thực tế.
