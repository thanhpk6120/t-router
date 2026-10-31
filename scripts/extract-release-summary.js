#!/usr/bin/env node

/**
 * extract-release-summary.js
 * Trích xuất bản tóm tắt các điểm cập nhật mới của T-Router
 * từ CHANGELOG-T.md và git commit log.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function escapeHtml(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function markdownToTelegramHtml(mdText) {
  if (!mdText) return '';
  let text = escapeHtml(mdText);
  // **bold** -> <b>bold</b>
  text = text.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  // `code` -> <code>code</code>
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  return text;
}

function extractChangelogSection(changelogContent, targetVersion) {
  if (!changelogContent) return null;
  const sections = changelogContent.split(/^##\s+/m).slice(1);
  if (sections.length === 0) return null;

  const cleanTarget = (targetVersion || '').replace(/^v/, '').trim();
  let foundSection = null;

  if (cleanTarget) {
    foundSection = sections.find(s => {
      const firstLine = s.trim().split('\n')[0].replace(/^v/, '').trim();
      return firstLine.startsWith(cleanTarget);
    });
  }

  const isTrivial = (sec) => {
    if (!sec) return true;
    const lines = sec.trim().split('\n').slice(1).map(l => l.trim());
    const bullets = lines.filter(l => {
      const isBullet = l.startsWith('-') || l.startsWith('+') || l.startsWith('*');
      const isGeneric = l.toLowerCase().includes('automated sync and release');
      return isBullet && !isGeneric;
    });
    return bullets.length === 0;
  };

  // Nếu targetVersion không có hoặc chỉ là bump trivial (-t.1 release qua bot),
  // lấy section có nội dung thực tế gần nhất
  if (!foundSection || isTrivial(foundSection)) {
    foundSection = sections.find(s => !isTrivial(s));
  }
  return foundSection;
}

function parseBulletsFromSection(sectionText) {
  if (!sectionText) return [];
  const lines = sectionText.trim().split('\n').slice(1);
  const bullets = [];

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('---') || line.startsWith('===')) continue;
    if (line.toLowerCase().includes('automated sync and release')) continue;

    // Kiểm tra gạch đầu dòng markdown: -, +, *, +-, v.v. (luôn theo sau bởi khoảng trắng)
    const match = line.match(/^([-+*]+(?:\s+[-+*]+)*\s+)(.*)$/);
    if (match) {
      let content = match[2].trim();
      if (content && content !== '--' && content !== '---') {
        bullets.push(content);
      }
    }
  }
  return bullets;
}

function extractGitCommits(dirTRouter, oldHead, newHead, limit = 6) {
  try {
    let cmd = 'git log --no-merges --pretty=format:%s';
    if (oldHead && newHead && oldHead !== newHead) {
      cmd = `git log ${oldHead}..${newHead} --no-merges --pretty=format:%s`;
    } else {
      cmd += ` -n ${limit}`;
    }
    const raw = execSync(cmd, { cwd: dirTRouter, encoding: 'utf8', timeout: 10000 });
    return raw
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('release:') && !l.startsWith('sync: upstream'));
  } catch (e) {
    return [];
  }
}

function getReleaseSummary(options = {}) {
  const dirTRouter = options.dirTRouter || path.join(__dirname, '..');
  const targetVersion = options.targetVersion || options.version || '';
  const oldHead = options.oldHead || null;
  const newHead = options.newHead || null;
  const format = options.format || 'html'; // 'html' | 'markdown' | 'text'

  const rawBullets = [];

  // 1. Đọc từ CHANGELOG-T.md
  const changelogPath = path.join(dirTRouter, 'CHANGELOG-T.md');
  if (fs.existsSync(changelogPath)) {
    try {
      const changelogContent = fs.readFileSync(changelogPath, 'utf8');
      const section = extractChangelogSection(changelogContent, targetVersion);
      if (section) {
        const parsed = parseBulletsFromSection(section);
        rawBullets.push(...parsed);
      }
    } catch (e) {}
  }

  // 2. Nếu thiếu bullet, bổ sung từ git commit log
  if (rawBullets.length < 3) {
    const commits = extractGitCommits(dirTRouter, oldHead, newHead, 6);
    for (const c of commits) {
      if (!rawBullets.includes(c)) {
        rawBullets.push(c);
      }
    }
  }

  // Lấy tối đa 7 bullet quan trọng nhất
  const selectedBullets = rawBullets.slice(0, 7);

  if (selectedBullets.length === 0) {
    const fallback = '• Cập nhật các bản sửa lỗi và tối ưu hóa hệ thống.';
    return fallback;
  }

  if (format === 'html') {
    return selectedBullets.map(b => {
      let line = b;
      if (line.length > 250) {
        line = line.slice(0, 247) + '...';
      }
      return '• ' + markdownToTelegramHtml(line);
    }).join('\n');
  } else if (format === 'markdown') {
    return selectedBullets.map(b => {
      let line = b;
      if (line.length > 250) line = line.slice(0, 247) + '...';
      return '• ' + line;
    }).join('\n');
  }

  return selectedBullets.map(b => '• ' + b).join('\n');
}

module.exports = {
  getReleaseSummary,
  markdownToTelegramHtml,
  escapeHtml,
};

// Cho phép chạy độc lập từ CLI để test hoặc nhúng vào bash script
if (require.main === module) {
  const args = process.argv.slice(2);
  let dir = path.join(__dirname, '..');
  let ver = '';
  let format = 'html';
  let oldHead = null;
  let newHead = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') dir = args[++i];
    else if (args[i] === '--version') ver = args[++i];
    else if (args[i] === '--format') format = args[++i];
    else if (args[i] === '--old-head') oldHead = args[++i];
    else if (args[i] === '--new-head') newHead = args[++i];
  }

  const result = getReleaseSummary({ dirTRouter: dir, targetVersion: ver, format, oldHead, newHead });
  console.log(result);
}
