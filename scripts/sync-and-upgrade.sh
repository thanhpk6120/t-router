#!/usr/bin/env bash
set -eo pipefail

export PATH="/home/thanhpk/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export HOME="/home/thanhpk"
export ANTHROPIC_BASE_URL="http://127.0.0.1:20130/v1"
export ANTHROPIC_AUTH_TOKEN="sk-bd802b6b81d63797-2ed6ws-9c6f28c7"
export CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=1

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
log "Checking for updates of 9router and 9router-pro..."

# 1. Fetch latest versions from npm
LATEST_9ROUTER=$(npm view 9router version 2>/dev/null || echo "")
LATEST_PRO=$(npm view 9router-pro version 2>/dev/null || echo "")

if [ -z "$LATEST_9ROUTER" ] || [ -z "$LATEST_PRO" ]; then
  log "ERROR: Failed to fetch versions from npm registry."
  exit 1
fi

log "Current npm registry versions: 9router=$LATEST_9ROUTER, 9router-pro=$LATEST_PRO"

# 2. Read stored versions
SAVED_9ROUTER=""
SAVED_PRO=""
SAVED_TROUTER=""

if [ -f "$VERSIONS_FILE" ]; then
  SAVED_9ROUTER=$(node -e "try { const d=require('$VERSIONS_FILE'); console.log(d.upstream_9router||''); } catch {}")
  SAVED_PRO=$(node -e "try { const d=require('$VERSIONS_FILE'); console.log(d.upstream_pro||''); } catch {}")
  SAVED_TROUTER=$(node -e "try { const d=require('$VERSIONS_FILE'); console.log(d.t_router||''); } catch {}")
fi

log "Saved baseline versions: 9router=$SAVED_9ROUTER, 9router-pro=$SAVED_PRO, t-router=$SAVED_TROUTER"

FORCE=false
if [ "$1" = "--force" ]; then
  FORCE=true
  log "Force flag detected. Proceeding with sync regardless of version match."
fi

# 3. Check if update is needed
UPDATE_NEEDED=false
if [ "$FORCE" = true ]; then
  UPDATE_NEEDED=true
elif [ "$LATEST_9ROUTER" != "$SAVED_9ROUTER" ] || [ "$LATEST_PRO" != "$SAVED_PRO" ]; then
  UPDATE_NEEDED=true
fi

if [ "$UPDATE_NEEDED" = false ]; then
  log "No new upstream versions detected. Everything is up to date."
  exit 0
fi

log "Update triggered! 9router ($SAVED_9ROUTER -> $LATEST_9ROUTER), 9router-pro ($SAVED_PRO -> $LATEST_PRO)"

# 4. Pull all 3 repositories
log "Pulling latest code for 9router..."
git -C "$DIR_9ROUTER" pull origin master || true

log "Pulling latest code for 9router-pro..."
git -C "$DIR_PRO" pull origin master || true

log "Pulling latest code for t-router..."
git -C "$DIR_TROUTER" pull origin main || true

# 5. Determine target version for t-router
CURRENT_PKG_VER=$(node -e "try { console.log(require('$DIR_TROUTER/package.json').version); } catch {}")
PRO_SUFFIX="${LATEST_PRO}"
if [[ "$PRO_SUFFIX" == *"-"* ]]; then
  PRO_SUFFIX="${PRO_SUFFIX#*-}"
fi

CURRENT_T_NUM=$(echo "$CURRENT_PKG_VER" | grep -o -E "t\.[0-9]+" | cut -d. -f2 || echo "1")
NEXT_T_NUM=$((CURRENT_T_NUM + 1))
TARGET_VERSION="v${LATEST_9ROUTER}-${PRO_SUFFIX}-t.${NEXT_T_NUM}"
PKG_VERSION="${LATEST_9ROUTER}-${PRO_SUFFIX}-t.${NEXT_T_NUM}"

log "Target version calculated: $TARGET_VERSION (package.json: $PKG_VERSION)"

# 6. Run Claude Code CLI headless in t-router
log "Invoking Claude Code CLI headless in $DIR_TROUTER..."
OLD_HEAD=$(git -C "$DIR_TROUTER" rev-parse HEAD)

cd "$DIR_TROUTER"
claude -p "Nhiệm vụ tự động kiểm tra và nâng cấp t-router từ upstream:
- Phiên bản upstream 9router mới: $LATEST_9ROUTER
- Phiên bản upstream 9router-pro mới: $LATEST_PRO
- Mục tiêu phiên bản t-router mới: $TARGET_VERSION (trong package.json: $PKG_VERSION)

Bối cảnh:
Thư mục cha chứa:
- ../9router (bản gốc decolua)
- ../9router-pro (bản mod gienetic)
- Repo hiện tại: t-router (bản tùy chỉnh)

Yêu cầu thực hiện:
1. Kiểm tra các commit và diff mới nhất trong ../9router và ../9router-pro so với t-router.
2. Xác định các tính năng mới, cải tiến, bản sửa lỗi (bug fixes, provider updates) mà t-router chưa có.
3. Nâng cấp và tích hợp các thay đổi mới vào t-router.
   RÀNG BUỘC BẮT BUỘC:
   - Giữ nguyên màu chủ đạo Azure (#3B82F6) và icon Azure T.
   - Giữ nguyên cấu hình Database Location là ~/.trouter/db/data.sqlite và dataDir dùng ~/.trouter.
   - Tuyệt đối không đưa các thông tin tác giả Gienetic, Telegram, Donate vào t-router.
   - Các chuỗi OAuth secret nếu có phải tách mảng hoặc decode để không kích hoạt GitHub Secret Scanning.
4. Cập nhật version trong package.json và cli/package.json thành \"$PKG_VERSION\".
5. Cập nhật CHANGELOG-PRO.md với tiêu đề phiên bản mới \"## $TARGET_VERSION\" và tóm tắt thay đổi.
6. Kiểm tra syntax bằng 'node -c' trên các file JS thay đổi.
7. Commit toàn bộ thay đổi với thông điệp: '$TARGET_VERSION: sync upstream updates (9router $LATEST_9ROUTER, 9router-pro $LATEST_PRO)'." \
--dangerously-skip-permissions < /dev/null 2>&1 | tee -a "$LOG_FILE"

NEW_HEAD=$(git -C "$DIR_TROUTER" rev-parse HEAD)

if [ "$OLD_HEAD" != "$NEW_HEAD" ]; then
  log "New commit created: $NEW_HEAD. Pushing to GitHub..."
  git -C "$DIR_TROUTER" push origin main

  log "Reinstalling t-router CLI globally..."
  npm install -g "$DIR_TROUTER/cli"

  log "Updating $VERSIONS_FILE..."
  cat << JSON_EOF > "$VERSIONS_FILE"
{
  "upstream_9router": "$LATEST_9ROUTER",
  "upstream_pro": "$LATEST_PRO",
  "t_router": "$TARGET_VERSION",
  "updated_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "commit": "$NEW_HEAD"
}
JSON_EOF

  log "Sync and upgrade completed successfully for version $TARGET_VERSION!"
else
  log "No code changes were committed by Claude. Updating baseline version file."
  cat << JSON_EOF > "$VERSIONS_FILE"
{
  "upstream_9router": "$LATEST_9ROUTER",
  "upstream_pro": "$LATEST_PRO",
  "t_router": "$TARGET_VERSION",
  "updated_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "commit": "$OLD_HEAD"
}
JSON_EOF
fi

log "Job finished."
