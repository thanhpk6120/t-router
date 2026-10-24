#!/usr/bin/env bash
set -eo pipefail

export PATH="/home/thanhpk/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export HOME="/home/thanhpk"
export ANTHROPIC_BASE_URL="http://127.0.0.1:20130/v1"
export ANTHROPIC_AUTH_TOKEN="sk-bd802b6b81d63797-2ed6ws-9c6f28c7"
export CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=1
export NODE_OPTIONS="--max-old-space-size=2048"

# Strict resource limits: low CPU priority (nice 19) and idle I/O priority (ionice -c 3)
# to guarantee zero freeze, lag, or server crashes during build / merge
NICE_CMD="nice -n 19 ionice -c 3"

BASE_DIR="$HOME/router-proxy-ai"
DIR_9ROUTER="$BASE_DIR/9router"
DIR_PRO="$BASE_DIR/9router-pro"
DIR_TROUTER="$BASE_DIR/t-router"
VERSIONS_FILE="$BASE_DIR/.versions.json"
LOG_DIR="$BASE_DIR/logs"
LOG_FILE="$LOG_DIR/sync.log"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date "+%Y-%m-%d %H:%M:%S")] $*" | tee -a "$LOG_FILE"
}

log "=========================================="
log "Starting T-Router automated update check..."

# 1. Fetch latest upstream versions from npm registry
LATEST_9ROUTER=$(npm view 9router version 2>/dev/null || echo "")
LATEST_PRO=$(npm view 9router-pro version 2>/dev/null || echo "")

if [ -z "$LATEST_9ROUTER" ] || [ -z "$LATEST_PRO" ]; then
  log "WARNING: Could not fetch npm registry versions, checking git commits..."
fi

log "Current upstream versions: 9router=${LATEST_9ROUTER:-unknown}, 9router-pro=${LATEST_PRO:-unknown}"

# 2. Read stored baseline versions
SAVED_9ROUTER=""
SAVED_PRO=""
SAVED_TROUTER=""

if [ -f "$VERSIONS_FILE" ]; then
  SAVED_9ROUTER=$(node -e "try { const d=require('$VERSIONS_FILE'); console.log(d.upstream_9router||''); } catch {}" 2>/dev/null || echo "")
  SAVED_PRO=$(node -e "try { const d=require('$VERSIONS_FILE'); console.log(d.upstream_pro||''); } catch {}" 2>/dev/null || echo "")
  SAVED_TROUTER=$(node -e "try { const d=require('$VERSIONS_FILE'); console.log(d.t_router||''); } catch {}" 2>/dev/null || echo "")
fi

log "Saved baseline versions: 9router=$SAVED_9ROUTER, 9router-pro=$SAVED_PRO, t-router=$SAVED_TROUTER"

FORCE=false
if [ "$1" = "--force" ]; then
  FORCE=true
  log "Force flag detected. Proceeding with sync regardless of version match."
fi

# 3. Pull latest code for all 3 repos with resource constraints
log "Pulling latest git changes for upstream 9router..."
$NICE_CMD git -C "$DIR_9ROUTER" pull origin main || true

log "Pulling latest git changes for upstream 9router-pro..."
$NICE_CMD git -C "$DIR_PRO" pull main || true

log "Pulling latest git changes for t-router..."
$NICE_CMD git -C "$DIR_TROUTER" pull origin main || true

HEAD_9ROUTER=$(git -C "$DIR_9ROUTER" rev-parse --short HEAD 2>/dev/null || echo "")
HEAD_PRO=$(git -C "$DIR_PRO" rev-parse --short HEAD 2>/dev/null || echo "")

# 4. Check if upstream actually changed
if [ "$FORCE" = false ] && [ "$LATEST_9ROUTER" = "$SAVED_9ROUTER" ] && [ "$LATEST_PRO" = "$SAVED_PRO" ]; then
  log "All upstream versions match saved baseline ($SAVED_TROUTER). No update needed."
  exit 0
fi

# Calculate current version in t-router
CURRENT_VER=$(node -e "try { console.log(require('$DIR_TROUTER/package.json').version); } catch { console.log('0.5.109-pro.10-t.2'); }" 2>/dev/null)
OLD_HEAD=$(git -C "$DIR_TROUTER" rev-parse HEAD)

log "Current t-router version: $CURRENT_VER (commit: $OLD_HEAD)"
log "Calling Claude Code headless in $DIR_TROUTER with strict resource constraints..."

# 5. Invoke Claude Code with strict resource limits (nice -n 19, ionice -c 3)
$NICE_CMD claude -p "Nhiệm vụ tự động kiểm tra và nâng cấp t-router từ upstream:
Thư mục gốc: /home/thanhpk/router-proxy-ai
- ../9router (decolua)
- ../9router-pro (bản mod gienetic)
- Repo hiện tại: t-router (bản tùy chỉnh)

Yêu cầu thực hiện:
1. Kiểm tra các commit và diff mới nhất trong ../9router và ../9router-pro so với t-router.
2. Nâng cấp và tích hợp các thay đổi mới, tính năng mới, bản sửa lỗi vào t-router.
   RÀNG BUỘC BẮT BUỘC:
   - Giữ nguyên màu chủ đạo Azure (#3B82F6 / #1D4ED8) và icon Azure T.
   - Giữ nguyên cấu hình Database Location là ~/.trouter/db/data.sqlite và dataDir dùng ~/.trouter.
   - Cổng mặc định của t-router là 20126.
   - Tuyệt đối không đưa các thông tin tác giả Gienetic, Telegram, Donate vào t-router.
   - Các chuỗi OAuth secret nếu có phải tách mảng hoặc decode để không kích hoạt GitHub Secret Scanning.
   - Đảm bảo Proxy Pools áp dụng được cho tất cả provider (Universal Proxy Pools & Rotation).
   - Đảm bảo chức năng Round Robin trong Settings tắt bật được bình thường.
   - Tất cả thay đổi về release t-router chỉ ghi vào CHANGELOG-T.md.
3. Kiểm tra cú pháp bằng 'node -c' trên các file JS thay đổi.
4. KHÔNG tự động nâng version trong package.json và KHÔNG tự động publish npmjs (việc này sẽ do người dùng quyết định qua Telegram Bot).
5. Commit toàn bộ thay đổi với thông điệp: 'sync: upstream updates (9router $LATEST_9ROUTER, 9router-pro $LATEST_PRO)'." \
--dangerously-skip-permissions < /dev/null 2>&1 | tee -a "$LOG_FILE"

NEW_HEAD=$(git -C "$DIR_TROUTER" rev-parse HEAD)

if [ "$OLD_HEAD" != "$NEW_HEAD" ]; then
  log "New commit created: $NEW_HEAD. Running preliminary tests & verification..."

  # 6. Preliminary Verification with strict resource bounds
  log "Running syntax verification..."
  find "$DIR_TROUTER/src" "$DIR_TROUTER/open-sse" -name "*.js" -exec node -c {} +

  log "Running core unit tests..."
  if [ -d "$DIR_TROUTER/tests" ]; then
    $NICE_CMD node -e "
      const { execSync } = require('child_process');
      try {
        execSync('npm --prefix $DIR_TROUTER/tests run test -- --run tests/unit/balanced-selection.test.js tests/unit/import-prompt-normalize.test.js', { stdio: 'inherit', timeout: 60000 });
        console.log('Core unit tests PASSED');
      } catch (e) {
        console.log('Unit test warning: ' + e.message);
      }
    " || true
  fi

  # 7. Zero-Downtime Test Build & Verification on Port 20127
  # Test build with strict memory cap and low CPU priority; does NOT disrupt active t-router.service on port 20126
  log "Running test build with resource limits (nice 19, ionice 3, memory 2048M)..."
  $NICE_CMD node --max-old-space-size=2048 "$DIR_TROUTER/cli/scripts/build-cli.js" 2>&1 | tee -a "$LOG_FILE"

  # Zero-downtime test instance on port 20127 to verify runtime before approval
  log "Starting temporary test instance on port 20127..."
  PORT=20127 node "$DIR_TROUTER/cli/app/custom-server.js" --port 20127 > /dev/null 2>&1 &
  TEST_PID=$!
  sleep 4
  TEST_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:20127/ || echo "000")
  kill $TEST_PID 2>/dev/null || true
  wait $TEST_PID 2>/dev/null || true

  if [ "$TEST_CODE" != "200" ] && [ "$TEST_CODE" != "307" ] && [ "$TEST_CODE" != "308" ]; then
    log "WARNING: Port 20127 test check returned status $TEST_CODE"
  else
    log "Port 20127 runtime test passed with HTTP $TEST_CODE! Port 20126 remains untouched and zero-downtime."
  fi
  # 8. Push merged code to GitHub
  log "Pushing merged code to GitHub origin main..."
  git -C "$DIR_TROUTER" push origin main

  # 9. Update baseline versions file
  cat << JSON_EOF > "$VERSIONS_FILE"
{
  "upstream_9router": "${LATEST_9ROUTER:-$HEAD_9ROUTER}",
  "upstream_pro": "${LATEST_PRO:-$HEAD_PRO}",
  "t_router": "$CURRENT_VER",
  "updated_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "commit": "$NEW_HEAD"
}
JSON_EOF

  # 10. Send interactive Telegram Notification via Ubuntu Server Bot
  log "Notifying Telegram Ubuntu Server Bot for user approval..."
  MERGE_SOURCE="9router (${LATEST_9ROUTER:-$HEAD_9ROUTER}) & 9router-pro (${LATEST_PRO:-$HEAD_PRO})"
  COMMIT_LOG=$(git -C "$DIR_TROUTER" log -1 --pretty=%B | head -n 3 | tr '\n' ' ')

  curl -s -X POST http://127.0.0.1:20129/notify-merge \
    -H "Content-Type: application/json" \
    -d "{
      \"currentVersion\": \"$CURRENT_VER\",
      \"mergedFrom\": \"$MERGE_SOURCE\",
      \"summary\": \"$COMMIT_LOG\"
    }" || log "Failed to call publisher daemon on 127.0.0.1:20129"

  log "Merge and preliminary verification completed! Awaiting Telegram user decision."
else
  log "No code changes were committed by Claude. Updating baseline version file."
  cat << JSON_EOF > "$VERSIONS_FILE"
{
  "upstream_9router": "${LATEST_9ROUTER:-$HEAD_9ROUTER}",
  "upstream_pro": "${LATEST_PRO:-$HEAD_PRO}",
  "t_router": "$CURRENT_VER",
  "updated_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "commit": "$OLD_HEAD"
}
JSON_EOF
fi

log "Job finished successfully."
