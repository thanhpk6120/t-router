<div align="center">

# 🌐 T Router — AI Proxy & Prompt Injection Gateway

**Cổng kết nối AI hiệu năng cao, tối ưu chi phí và điều hướng thông minh**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)
[![NPM Version](https://img.shields.io/npm/v/t-router-proxy?color=007FFF)](https://www.npmjs.com/package/t-router-proxy)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![Cổng mặc định](https://img.shields.io/badge/Port-20126-3B82F6)](http://localhost:20126)
[![Màu sắc](https://img.shields.io/badge/Giao_diện-Azure-3B82F6)](https://github.com/thanhpk6120/t-router)

Một endpoint duy nhất tương thích chuẩn OpenAI & Anthropic cho hơn **40+ nhà cung cấp AI** và **100+ mô hình**, tích hợp công nghệ Prompt Injection, xoay vòng Proxy Pools cho mọi nhà cung cấp, kiểm soát hạn mức Token và cơ chế tự phục hồi tài khoản thông minh.

[🚀 Bắt đầu nhanh](#-bắt-đầu-nhanh) • [⚡ Tính năng nổi bật](#-tính-năng-nổi-bật) • [🔌 Tích hợp CLI Tools](#-tích-hợp-cli-tools) • [📁 Lưu trữ dữ liệu](#-lưu-trữ-dữ-liệu)

</div>

---

## ⚡ Tính năng nổi bật

### 🎯 Prompt Injection Engine
- **3 cấp độ linh hoạt**: Chèn prompt ở phạm vi **Toàn cục** (mọi request), **Theo API Key** (từng người dùng/persona), hoặc **Theo Mô hình** (tùy biến hành vi từng model).
- **2 chế độ**: Chèn system prompt (ở đầu/cuối) hoặc chèn **lịch sử hội thoại mẫu** (fake chat script - giúp định hình phong cách phản hồi của AI mạnh mẽ hơn nhiều so với system prompt đơn thuần).

### 🔄 Proxy Pools & Tự động xoay Proxy cho tất cả Provider
- **Hỗ trợ toàn diện**: Áp dụng Proxy Pools và xoay proxy tự động cho TẤT CẢ các nhà cung cấp (OpenAI, Anthropic Claude, Gemini, Groq, DeepSeek, Cursor, STT, Embedding...).
- **Cơ chế xoay vòng linh hoạt**:
  - `Round-Robin`: Xoay vòng tuần tự qua danh sách proxy theo từng request.
  - `Random`: Phân phối ngẫu nhiên đều giữa các proxy đang hoạt động.
  - `Subsets`: Chỉ định xoay vòng trên một nhóm proxy cụ thể đã chọn.

### 🛡️ Điều phối tài khoản & Chống phản hồi lỗi (Anti-Flaky)
- **Balanced LRU Fallback**: Tự động phân cấp sức khỏe tài khoản (`sạch` → `nghi ngờ` → `tạm nghỉ`), tự động điều hướng request qua tài khoản khỏe mạnh và được nghỉ lâu nhất.
- **Bảo vệ chống lỗi chập chờn**: Nhận diện tức thì các phản hồi bị ngắt quãng, rỗng body hoặc lỗi định dạng từ upstream để tự động thử lại với tài khoản tiếp theo.
- **Tùy chọn chiến lược Routing**: Chuyển đổi mượt mà giữa **Balanced (Pro)**, **Round Robin**, và **Fill First** trong menu Cài đặt.

### 🎨 Giao diện Azure hiện đại & Cơ sở dữ liệu độc lập
- **Theme Azure sang trọng**: Bộ màu Azure chủ đạo (`#3B82F6` / `#1D4ED8`) cùng bộ icon độ phân giải cao cho trình duyệt và khay hệ thống (System Tray Windows/macOS).
- **Cơ sở dữ liệu độc lập hoàn toàn**: Toàn bộ dữ liệu lưu tại `~/.trouter/db/data.sqlite` (`%APPDATA%\trouter` trên Windows) và chạy trên cổng **`20126`**, đảm bảo không bao giờ xung đột với các router proxy khác.

---

## 🚀 Bắt đầu nhanh

### Cài đặt qua NPM (Khuyên dùng)

```bash
# Cài đặt toàn cục
npm install -g t-router-proxy

# Khởi chạy T Router (tự động mở giao diện tại http://localhost:20126)
t-router
```

Hoặc chạy nhanh không cần cài đặt qua npx:

```bash
npx t-router-proxy
```

### Chạy từ mã nguồn

```bash
git clone https://github.com/thanhpk6120/t-router.git
cd t-router
npm install
npm run dev
```

> **Thông tin đăng nhập mặc định:**
> - Đường dẫn: `http://localhost:20126`
> - Mật khẩu mặc định: `123456`

---

## 🔌 Tích hợp CLI Tools

T Router hỗ trợ cấu hình 1-click cho các công cụ lập trình AI phổ biến:

| Công cụ | Chuẩn kết nối | Cấu hình / Biến môi trường |
|---|---|---|
| **Claude Code** | Anthropic Messages | `ANTHROPIC_BASE_URL="http://localhost:20126"` |
| **Cursor** | OpenAI / Claude | Base URL: `http://localhost:20126/v1` |
| **Codex CLI** | OpenAI Compatible | Cấu hình profile nhà cung cấp `trouter` |
| **OpenCode** | OpenAI Compatible | Cấu hình profile nhà cung cấp `trouter` |
| **OpenClaw** | OpenAI / Anthropic | Gateway URL: `http://localhost:20126/v1` |
| **GitHub Copilot** | MITM | Tạo script hook Copilot trực tiếp từ Dashboard |

---

## 📁 Lưu trữ dữ liệu

T Router lưu trữ dữ liệu tại thư mục riêng biệt:
- **Linux/macOS:** `~/.trouter/db/data.sqlite`
- **Windows:** `%APPDATA%\trouter\db\data.sqlite`

## 📄 Giấy phép

Mã nguồn mở theo giấy phép [MIT License](../LICENSE).
