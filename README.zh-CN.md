<div align="center">

# 🌐 T Router — AI 代理与提示词注入网关

**高性能、智能调度与多提供商统一 AI 路由网关**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![NPM Version](https://img.shields.io/npm/v/t-router-proxy?color=007FFF)](https://www.npmjs.com/package/t-router-proxy)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![默认端口](https://img.shields.io/badge/Port-20126-3B82F6)](http://localhost:20126)
[![主题](https://img.shields.io/badge/Theme-Azure-3B82F6)](https://github.com/thanhpk6120/t-router)

统一兼容 OpenAI & Anthropic 格式的端点，支持 **40+ AI 提供商** 和 **100+ 模型**，具备深度提示词注入（Prompt Injection）、全提供商通用代理池轮询（Universal Proxy Pools）、Token 配额管理以及多账号自愈负载均衡。

[快速开始](#-快速开始) • [核心特性](#-核心特性) • [CLI 工具集成](#-cli-工具集成) • [配置与存储](#-数据存储)

</div>

---

## ⚡ 核心特性

- **🎯 提示词注入（Prompt Injection）**：支持全局、按 API Key、按模型三种注入范围；支持单条系统提示词或伪造对话历史（Fake Chat Script）。
- **🔄 全提供商代理池与智能轮换**：支持为所有提供商（OpenAI、Anthropic、Gemini、DeepSeek 等）配置代理池，支持 Round-Robin 轮询、随机分发或指定子集轮询。
- **🛡️ 均衡多账号容灾**：按健康等级（Clean → Suspect → Cooldown）调度多账号，遇到偶发网络截断自动重试下一账号。
- **🎨 Azure 蔚蓝主题与独立存储**：精美 Azure 蓝色主题（`#3B82F6`），独立数据库 `~/.trouter/db/data.sqlite`，默认监听独立端口 **`20126`**。

---

## 🚀 快速开始

```bash
# 全局安装
npm install -g t-router-proxy

# 启动 T Router（自动在浏览器中打开 http://localhost:20126）
t-router
```

或使用 npx 直接运行：

```bash
npx t-router-proxy
```

默认登录凭据：
- 地址：`http://localhost:20126`
- 默认密码：`123456`

---

## 🔌 CLI 工具集成

在控制面板的 CLI Tools 选项卡中，可直接获取各工具配置：
- **Claude Code**: `ANTHROPIC_BASE_URL="http://localhost:20126"`
- **Cursor**: Base URL: `http://localhost:20126/v1`
- **Codex / OpenCode**: 提供商名称 `trouter`
- **OpenClaw**: Gateway URL: `http://localhost:20126/v1`

---

## 📄 开源许可

本项目基于 [MIT License](LICENSE) 开源。
