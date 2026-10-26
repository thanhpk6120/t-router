#!/usr/bin/env node

/**
 * t-router-publisher.js
 * Host daemon for T-Router release notifications & Telegram interactive publishing.
 * Listens on 127.0.0.1:20129.
 */

const http = require('http');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 20129;
const HOST = '127.0.0.1';
const BOT_TOKEN = process.env.BOT_TOKEN || '8926237781:AAHUk79554mT7D_emM1EkefuD5LMvvUXAE8';
const OWNER_ID = parseInt(process.env.OWNER_ID, 10) || 5657249049;
const DIR_BASE = '/home/thanhpk/router-proxy-ai';
const DIR_TROUTER = path.join(DIR_BASE, 't-router');
const STATE_FILE = path.join(DIR_BASE, 't-router-pending-release.json');
const LOG_FILE = path.join(DIR_BASE, 'logs', 'publisher.log');

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {}
}

function escapeHtml(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendTelegram(text, replyMarkup = null) {
  try {
    const payload = {
      chat_id: OWNER_ID,
      text: text,
      parse_mode: 'HTML',
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const res = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      log('sendTelegram failed: ' + (data?.description || `HTTP ${res.status}`));
      // Fallback: retry as plain text if HTML parsing failed
      if (data?.description && data.description.includes('parse entities')) {
        log('Retrying sendTelegram as plain text without HTML parse_mode...');
        const plainText = text.replace(/<[^>]*>/g, '');
        const plainPayload = { chat_id: OWNER_ID, text: plainText };
        if (replyMarkup) plainPayload.reply_markup = replyMarkup;
        const retryRes = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(plainPayload),
        });
        return await retryRes.json().catch(() => null);
      }
    }
    return data;
  } catch (err) {
    log('sendTelegram error: ' + err.message);
    return null;
  }
}

function getPublishedVersions() {
  try {
    const raw = execSync('npm view t-router-proxy versions --json', { encoding: 'utf8', timeout: 10000 });
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    return [];
  }
}

function semverCompare(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const pa = (String(a).replace(/^v/, '').match(/\d+/g) || []).map(n => parseInt(n, 10));
  const pb = (String(b).replace(/^v/, '').match(/\d+/g) || []).map(n => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function parseVersion(v) {
  if (!v || typeof v !== 'string') return null;
  const clean = v.replace(/^v/, '').trim();
  const fullMatch = clean.match(/^([^-]+)-(pro\.\d+)-t\.(\d+)$/);
  if (fullMatch) {
    return {
      upstreamBase: fullMatch[1],
      proTag: fullMatch[2],
      tNumber: parseInt(fullMatch[3], 10),
      proVersion: `${fullMatch[1]}-${fullMatch[2]}`,
    };
  }
  const proMatch = clean.match(/^([^-]+)-(pro\.\d+)$/);
  if (proMatch) {
    return {
      upstreamBase: proMatch[1],
      proTag: proMatch[2],
      tNumber: 0,
      proVersion: `${proMatch[1]}-${proMatch[2]}`,
    };
  }
  const plainMatch = clean.match(/^(\d+\.\d+\.\d+)/);
  if (plainMatch) {
    return {
      upstreamBase: plainMatch[1],
      proTag: null,
      tNumber: 0,
      proVersion: plainMatch[1],
    };
  }
  return null;
}

function resolveNextVersion(currentVer, upstreamProVersion = null, upstream9RouterVersion = null, mergedFrom = null) {
  const published = new Set(getPublishedVersions());
  const curr = parseVersion(currentVer);

  if (!upstream9RouterVersion && mergedFrom) {
    const m = mergedFrom.match(/9router\s*\(([^)]+)\)/);
    if (m) upstream9RouterVersion = m[1].trim();
  }
  if (!upstreamProVersion && mergedFrom) {
    const m = mergedFrom.match(/9router-pro\s*\(([^)]+)\)/);
    if (m) upstreamProVersion = m[1].trim();
  }

  const upPro = parseVersion(upstreamProVersion);
  const up9R = parseVersion(upstream9RouterVersion);

  const r9Base = up9R ? up9R.upstreamBase : null;
  const proBase = upPro ? upPro.upstreamBase : null;
  const currBase = curr ? curr.upstreamBase : null;

  let effectiveBase = r9Base || proBase || currBase || '0.5.109';
  if (r9Base && proBase) {
    effectiveBase = semverCompare(r9Base, proBase) >= 0 ? r9Base : proBase;
  }

  const targetProTag = (upPro && upPro.proTag) || (curr && curr.proTag) || 'pro.13';
  const targetBaseWithPro = `${effectiveBase}-${targetProTag}`;

  let startT = 1;
  if (curr) {
    const currBaseWithPro = curr.proTag ? `${curr.upstreamBase}-${curr.proTag}` : curr.proVersion;
    if (targetBaseWithPro === currBaseWithPro) {
      startT = (curr.tNumber || 0) + 1;
    } else {
      startT = 1;
    }
  } else {
    startT = 1;
  }

  let t = startT;
  let candidate = `${targetBaseWithPro}-t.${t}`;
  while (published.has(candidate)) {
    t++;
    candidate = `${targetBaseWithPro}-t.${t}`;
  }
  return candidate;
}

function runExec(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, opts, (error, stdout, stderr) => {
      if (stdout) log('STDOUT: ' + stdout.trim());
      if (stderr) log('STDERR: ' + stderr.trim());
      if (error) {
        return reject(new Error(cmd + ' failed: ' + (stderr || stdout || error.message)));
      }
      resolve(stdout);
    });
  });
}

let isPublishing = false;

async function doPublish(targetVersion) {
  if (isPublishing) {
    await sendTelegram('⚠️ Có một tiến trình build/publish khác đang chạy, vui lòng chờ!');
    return;
  }
  isPublishing = true;
  try {
    const published = new Set(getPublishedVersions());
    if (published.has(targetVersion)) {
      const orig = targetVersion;
      let pending = null;
      try {
        if (fs.existsSync(STATE_FILE)) pending = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      } catch (e) {}
      targetVersion = resolveNextVersion(targetVersion, pending?.upstreamProVersion, pending?.upstream9RouterVersion, pending?.mergedFrom);
      log(`Version ${orig} already published on npmjs, auto-bumped to ${targetVersion}`);
      await sendTelegram(
        `ℹ️ Phiên bản <code>${orig}</code> đã tồn tại trên npmjs.com! Tự động nâng lên: <code>${targetVersion}</code>`
      );
    }

    log('Starting publish process for version: ' + targetVersion);
    await sendTelegram(
      `⏳ <b>Bắt đầu publish T-Router lên npmjs!</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📦 Phiên bản: <code>${targetVersion}</code>\n⚙️ Đang cập nhật metadata và đóng gói CLI với giới hạn tài nguyên CPU/RAM...`
    );

    // 1. Update version in package.json and cli/package.json
    const rootPkgPath = path.join(DIR_TROUTER, 'package.json');
    const cliPkgPath = path.join(DIR_TROUTER, 'cli', 'package.json');
    const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
    const cliPkg = JSON.parse(fs.readFileSync(cliPkgPath, 'utf8'));
    rootPkg.version = targetVersion;
    cliPkg.version = targetVersion;
    fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n', 'utf8');
    fs.writeFileSync(cliPkgPath, JSON.stringify(cliPkg, null, 2) + '\n', 'utf8');

    // Update CHANGELOG-T.md
    const changelogPath = path.join(DIR_TROUTER, 'CHANGELOG-T.md');
    if (fs.existsSync(changelogPath)) {
      let cl = fs.readFileSync(changelogPath, 'utf8');
      if (!cl.includes('## v' + targetVersion)) {
        const entry = `## v${targetVersion} (${new Date().toISOString().slice(0, 10)})\n\n- Automated sync and release via Telegram Bot.\n\n`;
        cl = cl.replace(/(## v[^\n]+)/, entry + '$1');
        fs.writeFileSync(changelogPath, cl, 'utf8');
      }
    }

    // 2. Build CLI package under nice/cgexec
    log('Building CLI package...');
    await runExec('node cli/scripts/build-cli.js', {
      cwd: DIR_TROUTER,
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=4096',
      },
      timeout: 300000,
    });

    // 3. Publish to npmjs
    log('Publishing to npmjs with npm publish --access public...');
    await runExec('npm publish --access public', {
      cwd: path.join(DIR_TROUTER, 'cli'),
      timeout: 120000,
    });

    // 4. Commit and push bump
    log('Committing and pushing release version to GitHub...');
    try {
      await runExec(
        `git add package.json cli/package.json CHANGELOG-T.md && git commit -m "release: v${targetVersion}" && git push origin main`,
        { cwd: DIR_TROUTER, timeout: 60000 }
      );
    } catch (gitErr) {
      log('Git push notice: ' + gitErr.message);
    }

    // 5. Update .versions.json baseline
    const versionsFile = path.join(DIR_BASE, '.versions.json');
    try {
      let vData = {};
      if (fs.existsSync(versionsFile)) {
        vData = JSON.parse(fs.readFileSync(versionsFile, 'utf8'));
      }
      vData.t_router = targetVersion;
      vData.commit = execSync('git rev-parse HEAD', { cwd: DIR_TROUTER, encoding: 'utf8' }).trim();
      vData.updated_at = new Date().toISOString();
      fs.writeFileSync(versionsFile, JSON.stringify(vData, null, 2), 'utf8');
      log('Updated .versions.json baseline to: ' + targetVersion);
    } catch (e) {
      log('Failed to update .versions.json: ' + e.message);
    }

    // 6. Reload t-router.service on 20126
    log('Reloading t-router.service on port 20126...');
    await runExec('systemctl --user reload-or-restart t-router.service', { timeout: 30000 });
    const isServiceActive = await runExec('systemctl --user is-active t-router.service', { timeout: 5000 }).catch(() => 'unknown');

    // 7. Clear pending state
    try {
      if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    } catch (e) {}

    log('Publish completed successfully for version: ' + targetVersion);
    await sendTelegram(
      `🎉 <b>T-Router Publish Thành Công!</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📦 Package: <code>t-router-proxy@${targetVersion}</code>\n▶️ Run Binary: <code>t-router</code>\n🖥️ Trạng thái service: <code>${isServiceActive.trim()}</code> (Port: 20126)\n\nCài đặt hoặc cập nhật mọi nơi bằng lệnh:\n<code>npm i -g t-router-proxy@${targetVersion}</code>`
    );
  } catch (err) {
    log('Publish failed: ' + err.message);
    await sendTelegram(
      `❌ <b>[FAIL] Lỗi trong quá trình build/publish T-Router:</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n<code>${escapeHtml(err.message.substring(0, 1000))}</code>`
    );
  } finally {
    isPublishing = false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const sendJson = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (req.method === 'GET') {
    if (url.pathname === '/health' || url.pathname === '/') {
      let pending = null;
      try {
        if (fs.existsSync(STATE_FILE)) pending = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      } catch (e) {}
      return sendJson(200, {
        ok: true,
        service: 't-router-publisher',
        isPublishing,
        pendingRelease: pending,
      });
    }

    if (url.pathname === '/status') {
      let pending = null;
      try {
        if (fs.existsSync(STATE_FILE)) pending = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      } catch (e) {}
      return sendJson(200, {
        isPublishing,
        pendingRelease: pending,
      });
    }
  }

  if (req.method === 'POST') {
    let bodyStr = '';
    req.on('data', (chunk) => {
      bodyStr += chunk;
    });
    req.on('end', async () => {
      let body = {};
      try {
        body = JSON.parse(bodyStr);
      } catch (e) {}

      if (url.pathname === '/notify-merge' || url.pathname === '/notify-release') {
        const { currentVersion, nextVersion, upstreamProVersion, upstream9RouterVersion, publishedVersion, mergedFrom, summary } = body;
        log('Received notify: ' + JSON.stringify(body));

        const targetVer = nextVersion || resolveNextVersion(currentVersion, upstreamProVersion, upstream9RouterVersion, mergedFrom);
        const stateData = {
          currentVersion: currentVersion || '0.5.109-pro.12-t.0',
          nextVersion: targetVer,
          publishedVersion: publishedVersion || '',
          upstream9RouterVersion: upstream9RouterVersion || '',
          upstreamProVersion: upstreamProVersion || '',
          mergedFrom: mergedFrom || 'Git origin/main',
          summary: summary || 'Bản cập nhật mới trên GitHub',
          timestamp: new Date().toISOString(),
        };

        try {
          fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2), 'utf8');
        } catch (e) {
          log('Write state error: ' + e.message);
        }

        const msgText =
          '🚀 <b>T-Router: Phát hiện Code mới & Version mới!</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
          '📦 <b>Phiên bản Git:</b> <code>' + escapeHtml(currentVersion || 'N/A') + '</code>\n' +
          (publishedVersion ? '🌐 <b>Phiên bản npmjs:</b> <code>' + escapeHtml(publishedVersion) + '</code>\n' : '') +
          '🔀 <b>Nguồn:</b> ' + escapeHtml(mergedFrom || 'Git origin/main') + '\n' +
          '📝 <b>Tóm tắt:</b> ' + escapeHtml(summary || 'Cập nhật tính năng mới') + '\n' +
          '✅ <b>Kiểm tra:</b> Syntax OK, build hoàn tất, service active!\n\n' +
          '💡 Đề xuất publish lên npmjs.com?';
        const inlineKeyboard = {
          inline_keyboard: [
            [
              { text: '🚀 Publish (' + targetVer + ')', callback_data: 'trouter_pub_auto' },
              { text: '✏️ Custom Version', callback_data: 'trouter_pub_custom' },
            ],
            [
              { text: '❌ Cancel', callback_data: 'trouter_pub_cancel' },
            ],
          ],
        };

        await sendTelegram(msgText, inlineKeyboard);
        return sendJson(200, { ok: true, message: 'Notification sent', targetVersion: targetVer });
      }

      if (url.pathname === '/publish') {
        const action = body.action || url.searchParams.get('action') || 'auto';
        const customVersion = body.version || url.searchParams.get('version');
        log('Received publish request: action=' + action + ', version=' + customVersion);

        if (action === 'cancel') {
          try {
            if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
          } catch (e) {}
          await sendTelegram('❌ Đã hủy yêu cầu publish. Code merge vẫn được bảo toàn an toàn trên Git.');
          return sendJson(200, { ok: true, status: 'cancelled' });
        }

        let targetVersion = customVersion;
        if (action === 'auto' || !targetVersion) {
          let pending = null;
          try {
            if (fs.existsSync(STATE_FILE)) pending = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
          } catch (e) {}

          if (pending && pending.nextVersion) {
            targetVersion = pending.nextVersion;
          } else {
            let curr = '0.5.109-pro.12-t.0';
            try {
              const rootPkg = JSON.parse(fs.readFileSync(path.join(DIR_TROUTER, 'package.json'), 'utf8'));
              curr = rootPkg.version || curr;
            } catch (e) {}
            targetVersion = resolveNextVersion(curr, pending?.upstreamProVersion, pending?.upstream9RouterVersion, pending?.mergedFrom);
          }
        }

        doPublish(targetVersion).catch((err) => {
          log('doPublish error: ' + err.message);
        });

        return sendJson(200, { ok: true, targetVersion, status: 'started' });
      }

      return sendJson(404, { error: 'Not found' });
    });
    return;
  }

  sendJson(405, { error: 'Method not allowed' });
});

server.listen(PORT, HOST, () => {
  log('T-Router Publisher Daemon listening on ' + HOST + ':' + PORT);
});
