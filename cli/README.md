# 🚀 T Router CLI (`t-router-proxy`)

Command-line launcher and background service manager for **T Router** — the high-performance AI Proxy & Prompt Injection Gateway.

---

## 📦 Installation

Install globally via npm:

```bash
npm install -g t-router-proxy
```

Or run on-demand via npx:

```bash
npx t-router-proxy
```

---

## ⚡ Usage

Start the T Router server and open the web dashboard:

```bash
t-router
```

Or use the package alias:

```bash
t-router-proxy
```

The web dashboard automatically starts and listens on:
👉 **`http://localhost:20126`**

---

## 🛠️ CLI Options & Commands

```bash
t-router [options] [command]

Commands:
  start               Start the T Router server (default)
  stop                Stop any currently running T Router background instances
  restart             Restart the background instance
  status              Check server running state and port binding
  logs                View live server streaming logs

Options:
  -p, --port <port>   Custom HTTP port (default: 20126)
  -H, --host <host>   Custom bind host (default: 127.0.0.1)
  --no-open           Do not automatically open the browser dashboard on launch
  --no-tray           Disable system tray icon (Windows / macOS)
  -v, --version       Output current version
  -h, --help          Display help and usage instructions
```

---

## 📁 Data Storage

All configuration, provider connections, and API keys are stored in an isolated local database:
- **Linux/macOS:** `~/.trouter/db/data.sqlite`
- **Windows:** `%APPDATA%\trouter\db\data.sqlite`

This ensures full isolation from any other running router or proxy instances.

---

## 📄 License

MIT License.
