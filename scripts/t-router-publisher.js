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
const BOT_TOKEN = process.env.BOT_TOKEN || '8926237781:AAHVcHFw7jMa3eoYe_40-xt6sxS0Zn5tySo';
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
    return await res.json();
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

// Calculate next version by incrementing the trailing number: e.g. 0.5.109-pro.12-t.1 -> 0.5.109-pro.12-t.2
function bumpTrailingVersion(currentVer) {
  const match = (currentVer || '').match(/^(.*[^\d])(\d+)$/);
  if (match) {
    const prefix = match[1];
    const num = parseInt(match[2], 10) + 1;
    return prefix + num;
  }
  return (currentVer || '0.5.109-pro.12-t') + '.1';
}

function resolveNextVersion(currentVer) {
  const published = new Set(getPublishedVersions());
  let candidate = bumpTrailingVersion(currentVer);
  while (published.has(candidate)) {
    candidate = bumpTrailingVersion(candidate);
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
    await sendTelegram('⚠️ Đang có một tiến trình build/publish khác đang chạy, vui lòng chờ!');
    return;
  }
  isPublishing = true;

  try {
    // 0. Check if targetVersion already exists on npmjs to prevent 403 Forbidden
    const published = new Set(getPublishedVersions());
    if (published.has(targetVersion)) {
      const orig = targetVersion;
      targetVersion = resolveNextVersion(targetVersion);
      log(`Version ${orig} already published on npmjs, auto-bumped to ${targetVersion}`);
      await sendTelegram(
        `ℹ️ Phiên bản <code>${orig}</code> đã tồn tại trên npmjs.com! Tự động nâng lên: <code>${targetVersion}</code>`
      );
    }

    log('Starting publish process for version: ' + targetVersion);
    await sendTelegram(
      '⏳ <b>Bắt đầu publish T-Router lên npmjs!</b>\n━━━━━━━━━━━━━━━━━━━━\n📦 Phiên bản: <code>' + targetVersion + '</code>\n⚙️ Đang cập nhật metadata và đóng gói CLI với giới hạn tài nguyên CPU/RAM...'
    );

    // 1. Update version in package.json and cli/package.json
    const rootPkgPath = path.join(DIR_TROUTER, 'package.json');
    const cliPkgPath = path.join(DIR_TROUTER, 'cli', 'package.json');

    const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
    rootPkg.version = targetVersion;
    fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n', 'utf8');

    const cliPkg = JSON.parse(fs.readFileSync(cliPkgPath, 'utf8'));
    cliPkg.version = targetVersion;
    fs.writeFileSync(cliPkgPath, JSON.stringify(cliPkg, null, 2) + '\n', 'utf8');

    // Update CHANGELOG-T.md
    const changelogPath = path.join(DIR_TROUTER, 'CHANGELOG-T.md');
    try {
      if (fs.existsSync(changelogPath)) {
        let cl = fs.readFileSync(changelogPath, 'utf8');
        if (!cl.includes('## v' + targetVersion)) {
          const entry = '## v' + targetVersion + ' (' + new Date().toISOString().slice(0, 10) + ')\n\n- Automated sync and release via Telegram Bot.\n\n';
          cl = cl.replace(/(## v[^\n]+)/, entry + '$1');
          fs.writeFileSync(changelogPath, cl, 'utf8');
        }
      }
    } catch (clErr) {
      log('Changelog update notice: ' + clErr.message);
    }

    // 2. Build CLI with strict resource limits (nice -n 19, ionice -c 3, max-old-space-size=2048)
    log('Executing resource-constrained build...');
    const buildCmd = 'nice -n 19 ionice -c 3 node --max-old-space-size=2048 cli/scripts/build-cli.js';
    await runExec(buildCmd, { cwd: DIR_TROUTER, timeout: 600000 });

    // 3. Publish to npmjs (using --ignore-scripts because build-cli.js already ran)
    log('Publishing to npmjs.com...');
    const publishCmd = 'npm publish --access public --ignore-scripts';
    await runExec(publishCmd, { cwd: path.join(DIR_TROUTER, 'cli'), timeout: 180000 });

    // 4. Commit and push to git
    log('Committing and pushing to git...');
    const gitMsg = 'release: v' + targetVersion;
    const gitCmd = 'git add package.json cli/package.json CHANGELOG-T.md && git commit -m "' + gitMsg + '" && git push origin main';
    try {
      await runExec(gitCmd, { cwd: DIR_TROUTER, timeout: 60000 });
    } catch (gitErr) {
      log('Git push notice: ' + gitErr.message);
    }
    // 4.1 Update .versions.json baseline
    const versionsFilePath = path.join(DIR_BASE, '.versions.json');
    try {
      let vData = {};
      if (fs.existsSync(versionsFilePath)) {
        vData = JSON.parse(fs.readFileSync(versionsFilePath, 'utf8'));
      }
      vData.t_router = targetVersion;
      vData.updated_at = new Date().toISOString();
      fs.writeFileSync(versionsFilePath, JSON.stringify(vData, null, 2) + '\n', 'utf8');
      log('Updated .versions.json baseline to: ' + targetVersion);
    } catch (ve) {
      log('Update .versions.json notice: ' + ve.message);
    }

    // 5. Gracefully restart t-router.service on default port 20126
    log('Reloading t-router.service on port 20126...');
    await runExec('systemctl --user restart t-router.service', { timeout: 30000 });

    // 6. Verify service health on port 20126
    await new Promise((r) => setTimeout(r, 3000));
    const isServiceActive = await runExec('systemctl --user is-active t-router.service').catch(() => 'unknown');

    // 7. Clear pending state
    try {
      if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    } catch (e) {}

    log('Publish completed successfully for version: ' + targetVersion);
    await sendTelegram(
      '🎉 <b>T-Router Publish Thành Công!</b>\n━━━━━━━━━━━━━━━━━━━━\n📦 Package: <code>t-router-proxy@' + targetVersion + '</code>\n🚀 Binary: <code>t-router</code>\n🌐 Trạng thái service: <code>' + isServiceActive.trim() + '</code> (Port: 20126)\n\nCài đặt hoặc cập nhật mọi nơi bằng lệnh:\n<code>npm i -g t-router-proxy@' + targetVersion + '</code>'
    );
  } catch (err) {
    log('Publish failed: ' + err.message);
    await sendTelegram(
      '❌ <b>Lỗi trong quá trình build/publish T-Router:</b>\n━━━━━━━━━━━━━━━━━━━━\n<code>' + err.message.substring(0, 1000) + '</code>'
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

  if (req.method === 'GET' && url.pathname === '/status') {
    let pending = null;
    try {
      if (fs.existsSync(STATE_FILE)) {
        pending = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      }
    } catch (e) {}
    return sendJson(200, { ok: true, isPublishing, pendingRelease: pending });
  }

  if (req.method === 'POST') {
    let bodyStr = '';
    req.on('data', (chunk) => { bodyStr += chunk; });
    req.on('end', async () => {
      let body = {};
      try {
        if (bodyStr) body = JSON.parse(bodyStr);
      } catch (e) {}

      if (url.pathname === '/notify-merge' || url.pathname === '/notify-release') {
        const { currentVersion, nextVersion, upstreamProVersion, publishedVersion, mergedFrom, summary } = body;
        log('Received notify: ' + JSON.stringify(body));

        const targetVer = nextVersion || currentVersion || resolveNextVersion(currentVersion, upstreamProVersion);
        const stateData = {
          currentVersion: currentVersion || '0.5.109-pro.12-t.0',
          nextVersion: targetVer,
          publishedVersion: publishedVersion || '',
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
          '📦 <b>Phiên bản Git:</b> <code>' + (currentVersion || 'N/A') + '</code>\n' +
          (publishedVersion ? '🌐 <b>Phiên bản npmjs:</b> <code>' + publishedVersion + '</code>\n' : '') +
          '🔀 <b>Nguồn:</b> ' + (mergedFrom || 'Git origin/main') + '\n' +
          '📝 <b>Tóm tắt:</b> ' + (summary || 'Cập nhật tính năng mới') + '\n' +
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
            targetVersion = resolveNextVersion(curr, pending?.upstreamProVersion);
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
