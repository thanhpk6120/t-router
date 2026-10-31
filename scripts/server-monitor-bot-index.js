const TelegramBot = require("node-telegram-bot-api");
const { execSync } = require("child_process");
const fs = require("fs");

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONITOR_SERVER = process.env.MONITOR_SERVER || "localhost";
const OWNER_ID = parseInt(process.env.OWNER_ID, 10) || 5657249049;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN not set!");
  process.exit(1);
}

// Single-poll configuration: reusable socket, family: 4, 1s interval to prevent 409 conflict
const bot = new TelegramBot(BOT_TOKEN, {
  polling: { interval: 1000, autoStart: true, params: { timeout: 10 } },
  request: { timeout: 30000, agentOptions: { family: 4, keepAlive: true } },
});

// Watchdog: ignore temporary 409 conflicts, reset counter on transient errors without crashing container
let pollErrCount = 0;
let pollErrWindowStart = Date.now();
bot.on("polling_error", (e) => {
  const errMsg = e && e.message ? e.message : String(e);
  log("Poll err: " + errMsg);
  if (errMsg.includes("409") || errMsg.includes("Conflict")) {
    return; // Don't kill process on temporary 409 session closure
  }
  if (Date.now() - pollErrWindowStart > 10 * 60 * 1000) {
    pollErrCount = 0;
    pollErrWindowStart = Date.now();
  }
  pollErrCount++;
  if (pollErrCount >= 10) {
    log("Polling error count high, resetting counter without killing container");
    pollErrCount = 0;
  }
});

const userState = {};

bot.on("message", async (msg) => {
  pollErrCount = 0;
  const chatId = msg.chat?.id;
  const text = (msg.text || "").trim();

  if (chatId && userState[chatId]?.state === "waiting_trouter_custom_version") {
    if (text === "/cancel" || text.toLowerCase() === "cancel") {
      delete userState[chatId];
      await bot.sendMessage(chatId, "❌ Đã hủy nhập version custom.");
      return;
    }

    if (/^[0-9]+\.[0-9]+\.[0-9]+.*$/.test(text)) {
      delete userState[chatId];
      await bot.sendMessage(chatId, "⏳ Đã nhận phiên bản: <code>" + text + "</code>. Bắt đầu build & publish...", { parse_mode: "HTML" });
      try {
        await fetch("http://127.0.0.1:20129/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "custom", version: text }),
        });
      } catch (err) {
        log("Custom publish call err: " + err.message);
      }
    } else {
      await bot.sendMessage(
        chatId,
        "⚠️ Định dạng phiên bản không hợp lệ! Vui lòng nhập định dạng chuẩn (ví dụ: <code>0.5.109-pro.12-t.5</code>) hoặc gõ /cancel để hủy:",
        { parse_mode: "HTML" }
      );
    }
  }
});

// Stall detector: prevent false positives by updating timestamp even on errors
const STALL_LIMIT_MS = 15 * 60 * 1000;
let lastPollOk = Date.now();
const origRequest = bot._request.bind(bot);
bot._request = (path, options = {}) => origRequest(path, options).then(res => {
  if (path === "getUpdates") lastPollOk = Date.now();
  return res;
}).catch(err => {
  if (path === "getUpdates") lastPollOk = Date.now();
  throw err;
});
setInterval(() => {
  const stale = Date.now() - lastPollOk;
  if (stale > STALL_LIMIT_MS) {
    log("Polling stalled (no successful getUpdates for " + Math.round(stale / 1000) + "s), resetting socket");
    lastPollOk = Date.now();
  }
}, 30000);

function log(msg) { console.log("[" + new Date().toISOString() + "] " + msg); }

function runCmd(cmd, timeout = 30000) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout, cwd: "/tmp" });
  } catch (e) { return "Error: " + e.message; }
}

const ALERT_CONFIG = {
  cpuThreshold: 90, tempThreshold: 80, ramThreshold: 90, diskThreshold: 90,
  checkInterval: 5 * 60 * 1000, lastAlert: null, alertCooldown: 15 * 60 * 1000
};

function getUptime() {
  const s = parseFloat(runCmd("cat /proc/uptime").trim().split(" ")[0]);
  return Math.floor(s/86400) + "d " + Math.floor((s%86400)/3600) + "h " + Math.floor((s%3600)/60) + "m";
}

function getQuickStatus() {
  const memInfo = runCmd("cat /proc/meminfo");
  const memTotal = (parseInt(memInfo.match(/MemTotal:\s+(\d+)/)?.[1]||0, 10)/1024/1024).toFixed(1);
  const memAvail = (parseInt(memInfo.match(/MemAvailable:\s+(\d+)/)?.[1]||0, 10)/1024/1024).toFixed(1);
  const memUsed = (parseFloat(memTotal) - parseFloat(memAvail)).toFixed(1);
  const memPct = Math.round((parseFloat(memUsed)/parseFloat(memTotal))*100);
  const temp = runCmd("sensors 2>/dev/null | grep 'Package id 0'").match(/\+(\d+)/)?.[1] || "N/A";
  const disk = runCmd("df / | tail -1").trim().split(/\s+/)[4] || "N/A";
  return "🌐 **" + MONITOR_SERVER + " Quick**\n━━━━━━━━━━━━━━━━\n⏱️ " + getUptime() + "\n📊 Load: " + runCmd("cat /proc/loadavg").trim() + "\n💾 RAM: " + memUsed + "GB / " + memTotal + "GB (" + memPct + "%)\n💿 Disk: " + disk + "\n🌡️ Temp: " + temp + "°C\n🐳 Docker: " + runCmd("docker ps -q 2>/dev/null | wc -l").trim() + " containers";
}

function checkAlerts() {
  const cpu = parseFloat(runCmd("top -bn1 | head -5").match(/(\d+)%\s+(?:usr|sys)/)?.[1] || "0");
  const temp = parseInt(runCmd("sensors 2>/dev/null | grep 'Package id 0'").match(/\+(\d+)/)?.[1] || "0", 10);
  const memInfo = runCmd("cat /proc/meminfo");
  const memTotal = parseInt(memInfo.match(/MemTotal:\s+(\d+)/)?.[1] || 1, 10);
  const memAvail = parseInt(memInfo.match(/MemAvailable:\s+(\d+)/)?.[1] || 0, 10);
  const memPct = Math.round(((memTotal - memAvail) / memTotal) * 100);
  const diskPct = parseInt(runCmd("df / | tail -1").trim().split(/\s+/)[4]?.replace("%","") || "0", 10);
  const alerts = [];
  if (cpu > ALERT_CONFIG.cpuThreshold) alerts.push("⚠️ **CPU: " + cpu + "%**");
  if (temp > ALERT_CONFIG.tempThreshold) alerts.push("🔥 **TEMP: " + temp + "°C**");
  if (memPct > ALERT_CONFIG.ramThreshold) alerts.push("💾 **RAM: " + memPct + "%**");
  if (diskPct > ALERT_CONFIG.diskThreshold) alerts.push("💿 **DISK: " + diskPct + "%**");
  return { cpu, temp, mem: memPct, disk: diskPct, alerts };
}

function getTopProcesses(type = "cpu") {
  const flag = type === "cpu" ? "-%cpu" : "-%mem";
  const title = type === "cpu" ? "CPU" : "RAM";
  const out = runCmd("ps axo pid,user,%cpu,%mem,comm --sort=" + flag + " | head -11").trim();
  return "🔝 **Top 10 " + title + " Processes**\n```\n" + out + "\n```";
}

function getDockerStatus() {
  const running = runCmd("docker ps --format '{{.Names}} ({{.Status}})' 2>/dev/null").trim();
  const all = runCmd("docker ps -a --format '{{.Names}} ({{.Status}})' 2>/dev/null").trim();
  const total = all ? all.split("\n").length : 0;
  const runningCount = running ? running.split("\n").length : 0;
  return "🐳 **Docker Containers (" + runningCount + "/" + total + " running)**\n```\n" + (all || "No containers") + "\n```";
}

function dockerAction(action, name) {
  const valid = ["start", "stop", "restart"];
  if (!valid.includes(action)) return "❌ Invalid action. Use: start, stop, restart";
  const check = runCmd("docker ps -a --format '{{.Names}}' 2>/dev/null | grep -w '" + name + "'").trim();
  if (!check) return "❌ Container '" + name + "' not found";
  const result = runCmd("docker " + action + " " + name + " 2>&1").trim();
  if (result.includes("Error")) return "❌ " + result;
  return "✅ " + action.charAt(0).toUpperCase() + action.slice(1) + "ed '" + name + "'";
}

function getDockerLogs(name, lines) {
  const result = runCmd("docker logs --tail " + lines + " " + name + " 2>&1").trim();
  if (result.includes("Error") || !result) return "❌ Cannot read logs";
  return "📜 **" + name + "**\n```\n" + result.slice(-1500) + "\n```";
}

function getMainKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Full", callback_data: "full" }, { text: "⚡ Quick", callback_data: "quick" }, { text: "🚨 Alert", callback_data: "alerts" }],
        [{ text: "🌡️ Temp", callback_data: "temp" }, { text: "💾 RAM", callback_data: "memory" }, { text: "💿 Disk", callback_data: "disk" }],
        [{ text: "🔝 CPU", callback_data: "top_cpu" }, { text: "🔝 MEM", callback_data: "top_mem" }, { text: "⚙️ Svcs", callback_data: "services" }],
        [{ text: "🐳 Docker", callback_data: "docker" }, { text: "📈 Stats", callback_data: "docker_stats" }, { text: "🌐 Net", callback_data: "network" }],
        [{ text: "🚀 T-Router", callback_data: "trouter_menu" }, { text: "🔄 Refresh", callback_data: "refresh" }, { text: "❤️ Health", callback_data: "health" }],
        [{ text: "⚡ Auto", callback_data: "auto_alert" }]
      ]
    }
  };
}

const lastMsgId = {};
async function sendResult(chatId, text, kbd, delMsgId) {
  if (delMsgId && lastMsgId[chatId] && delMsgId === lastMsgId[chatId]) {
    try { await bot.deleteMessage(chatId, delMsgId); } catch(e) {}
  }
  try {
    const msg = await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kbd?.reply_markup || getMainKeyboard().reply_markup });
    lastMsgId[chatId] = msg.message_id;
  } catch (e) { log("Send: " + e.message); }
}

bot.onText(/\/start/, async (m) => { await sendResult(m.chat.id, "🎛️ **Server Monitor**\n\n" + MONITOR_SERVER, getMainKeyboard()); });
bot.onText(/\/menu/, async (m) => { await sendResult(m.chat.id, "🎛️ **Menu**", getMainKeyboard()); });
bot.onText(/\/quick/, async (m) => { await sendResult(m.chat.id, getQuickStatus(), getMainKeyboard()); });
bot.onText(/\/alert/, async (m) => { const a = checkAlerts(); await sendResult(m.chat.id, "🚨 **Alerts**\n━━━━━━━━━━━━━━━━\nCPU: " + a.cpu + "%\nTemp: " + a.temp + "°C\nRAM: " + a.mem + "%\nDisk: " + a.disk + "%\n\n" + (a.alerts.length ? a.alerts.join("\n") : "✅ OK"), getMainKeyboard()); });
bot.onText(/\/health/, async (m) => { const a = checkAlerts(); await sendResult(m.chat.id, "❤️ **Health**\n" + a.cpu + "% | " + a.temp + "°C | " + a.mem + "% | " + a.disk + "%\n\n" + (a.alerts.length ? a.alerts.join("\n") : "✅ OK"), getMainKeyboard()); });
bot.onText(/\/topcpu/, async (m) => { await sendResult(m.chat.id, getTopProcesses("cpu"), getMainKeyboard()); });
bot.onText(/\/topmem/, async (m) => { await sendResult(m.chat.id, getTopProcesses("mem"), getMainKeyboard()); });
bot.onText(/\/docker/, async (m) => { await sendResult(m.chat.id, getDockerStatus(), getMainKeyboard()); });
bot.onText(/\/dockerstats/, async (m) => { await sendResult(m.chat.id, "📊 " + runCmd("docker stats --no-stream 2>/dev/null").trim().substring(0,1500), getMainKeyboard()); });
bot.onText(/\/dockeraction (\w+) (.+)/, async (m, m2) => { await sendResult(m.chat.id, dockerAction(m2[1], m2[2]), getMainKeyboard()); });
bot.onText(/\/dockerlogs (.+)/, async (m, m2) => { await sendResult(m.chat.id, getDockerLogs(m2[1], 30), getMainKeyboard()); });

bot.onText(/\/trouter/, async (m) => {
  const chatId = m.chat.id;
  try {
    const res = await fetch("http://127.0.0.1:20129/status");
    const data = await res.json();
    let text = "🚀 **T-Router Management**\n━━━━━━━━━━━━━━━━\n";
    if (data.pendingRelease) {
      const summaryText = data.pendingRelease.summary || "• Cập nhật tối ưu hóa và sửa lỗi hệ thống.";
      text += "📦 **Bản cập nhật chờ duyệt:** `" + data.pendingRelease.nextVersion + "`\n" +
              "🔀 **Nguồn:** " + data.pendingRelease.mergedFrom + "\n\n" +
              "📋 **Những cập nhật mới:**\n" + summaryText + "\n\n" +
              "💡 Chọn hành động bên dưới:";
      const kbd = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🚀 Publish (" + data.pendingRelease.nextVersion + ")", callback_data: "trouter_pub_auto" }, { text: "✏️ Custom Version", callback_data: "trouter_pub_custom" }],
            [{ text: "❌ Cancel", callback_data: "trouter_pub_cancel" }]
          ]
        }
      };
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...kbd });
    } else {
      text += "✅ T-Router đang chạy ổn định trên cổng 20126.\nHiện không có bản cập nhật nào đang chờ duyệt.";
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
    }
  } catch (err) {
    await bot.sendMessage(chatId, "⚠️ Không thể kết nối với T-Router Daemon (127.0.0.1:20129): " + err.message);
  }
});

bot.on("callback_query", async (q) => {
  await bot.answerCallbackQuery(q.id, { text: "⏳" });
  const chatId = q.message?.chat?.id;
  const msgId = q.message?.message_id;
  const data = q.data;
  log("CB: " + data);
  if (!chatId) return;
  try {
    switch (data) {
      case "quick": await sendResult(chatId, getQuickStatus(), getMainKeyboard(), msgId); break;
      case "alerts": const a = checkAlerts(); await sendResult(chatId, "🚨 **Alerts**\n" + a.cpu + "% | " + a.temp + "°C | " + a.mem + "% | " + a.disk + "%\n\n" + (a.alerts.length ? a.alerts.join("\n") : "✅ OK"), getMainKeyboard(), msgId); break;
      case "temp": await sendResult(chatId, "🌡️ **Temp**\n```\n" + runCmd("sensors 2>/dev/null").trim() + "\n```", getMainKeyboard(), msgId); break;
      case "memory": await sendResult(chatId, "💾 **RAM**\n```\n" + runCmd("cat /proc/meminfo").trim() + "\n```", getMainKeyboard(), msgId); break;
      case "disk": await sendResult(chatId, "💿 **Disk**\n```\n" + runCmd("df -h").trim() + "\n```", getMainKeyboard(), msgId); break;
      case "top_cpu": case "top_mem": await sendResult(chatId, getTopProcesses(data === "top_cpu" ? "cpu" : "mem"), getMainKeyboard(), msgId); break;
      case "services": await sendResult(chatId, "⚙️ **Top**\n```\n" + runCmd("top -bn1 2>/dev/null | head -12").trim() + "\n```", getMainKeyboard(), msgId); break;
      case "docker": await sendResult(chatId, getDockerStatus(), getMainKeyboard(), msgId); break;
      case "docker_stats": await sendResult(chatId, "📊\n```\n" + runCmd("docker stats --no-stream 2>/dev/null").trim().substring(0,1500) + "\n```", getMainKeyboard(), msgId); break;
      case "network": await sendResult(chatId, "🌐 **Net**\n```\n" + runCmd("ip addr | grep inet").trim() + "\n```", getMainKeyboard(), msgId); break;
      case "refresh": await sendResult(chatId, getQuickStatus(), getMainKeyboard(), msgId); break;
      case "health": const h = checkAlerts(); await sendResult(chatId, "❤️ " + h.cpu + "% | " + h.temp + "°C | " + h.mem + "% | " + h.disk + "%\n" + (h.alerts.length ? h.alerts.join("\n") : "✅ OK"), getMainKeyboard(), msgId); break;
      case "auto_alert": await sendResult(chatId, "⚡ Auto Alert\n\n5 min check:\n• CPU > 90%\n• Temp > 80°C\n• RAM > 90%\n• Disk > 90%", getMainKeyboard(), msgId); break;
      case "trouter_menu":
        try {
          const res = await fetch("http://127.0.0.1:20129/status");
          const d = await res.json();
          let txt = "🚀 **T-Router Management**\n━━━━━━━━━━━━━━━━\n";
          if (d.pendingRelease) {
            const summaryText = d.pendingRelease.summary || "• Cập nhật tối ưu hóa và sửa lỗi hệ thống.";
            txt += "📦 **Chờ duyệt:** `" + d.pendingRelease.nextVersion + "`\n" +
                   "🔀 **Nguồn:** " + d.pendingRelease.mergedFrom + "\n\n" +
                   "📋 **Những cập nhật mới:**\n" + summaryText + "\n\n" +
                   "💡 Chọn hành động:";
            const kb = {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🚀 Publish (" + d.pendingRelease.nextVersion + ")", callback_data: "trouter_pub_auto" }, { text: "✏️ Custom Version", callback_data: "trouter_pub_custom" }],
                  [{ text: "❌ Cancel", callback_data: "trouter_pub_cancel" }]
                ]
              }
            };
            await sendResult(chatId, txt, kb, msgId);
          } else {
            txt += "✅ T-Router đang chạy ổn định trên cổng 20126.";
            await sendResult(chatId, txt, getMainKeyboard(), msgId);
          }
        } catch (e) {
          await sendResult(chatId, "⚠️ Lỗi kết nối T-Router: " + e.message, getMainKeyboard(), msgId);
        }
        break;
      case "trouter_pub_auto":
        try {
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
          await fetch("http://127.0.0.1:20129/publish", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "auto" }),
          });
        } catch (err) { log("trouter_pub_auto err: " + err.message); }
        break;
      case "trouter_pub_custom":
        try {
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
          userState[chatId] = { state: "waiting_trouter_custom_version" };
          await bot.sendMessage(
            chatId,
            "✏️ <b>Vui lòng gõ phiên bản bạn muốn publish lên npmjs</b>\n(Ví dụ: <code>0.5.109-pro.12-t.5</code> hoặc gõ /cancel để hủy):",
            { parse_mode: "HTML" }
          );
        } catch (err) { log("trouter_pub_custom err: " + err.message); }
        break;
      case "trouter_pub_cancel":
        try {
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
          await fetch("http://127.0.0.1:20129/publish", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "cancel" }),
          });
        } catch (err) { log("trouter_pub_cancel err: " + err.message); }
        break;
    }
  } catch (e) { log("CB err: " + e.message); }
});

async function sendAutoAlert() {
  if (ALERT_CONFIG.lastAlert && Date.now() - ALERT_CONFIG.lastAlert < ALERT_CONFIG.alertCooldown) return;
  const a = checkAlerts();
  if (a.alerts.length) {
    try {
      await bot.sendMessage(OWNER_ID, "🚨 **AUTO ALERT**\n" + a.cpu + "% | " + a.temp + "°C | " + a.mem + "% | " + a.disk + "%\n\n" + a.alerts.join("\n"), { parse_mode: "Markdown" });
      ALERT_CONFIG.lastAlert = Date.now();
      log("Auto alert sent");
    } catch (e) { log("Alert err: " + e.message); }
  }
}
setInterval(sendAutoAlert, ALERT_CONFIG.checkInterval);

const STARTUP_FILE = "/app/logs/last_startup_ts.txt";
function canSendStartup() {
  try {
    if (fs.existsSync(STARTUP_FILE)) {
      const last = parseInt(fs.readFileSync(STARTUP_FILE, "utf8"), 10);
      if (Date.now() - last < 60 * 60 * 1000) return false;
    }
  } catch (e) {}
  try {
    fs.writeFileSync(STARTUP_FILE, String(Date.now()), "utf8");
  } catch (e) {}
  return true;
}

log("Bot started. Monitoring: " + MONITOR_SERVER);
if (canSendStartup()) {
  bot.sendMessage(OWNER_ID, "🚀 **Server Monitor Bot Online!**\n\n" + MONITOR_SERVER + "\n\nNew: Top Processes, Docker Manager, Auto Alert\n\n/topcpu /topmem\n/docker\n/dockeraction [start|stop|restart] [name]\n/kill [PID]\n/trouter", { parse_mode: "Markdown", reply_markup: getMainKeyboard().reply_markup }).then(() => log("Startup sent")).catch(e => log("Startup err: " + e.message));
} else {
  log("Startup notification suppressed (1-hour cooldown active).");
}
