#!/bin/bash
set -e

DATA_DIR="/data"
TMP_DIR="/tmp"
BACKUP_DIR="/backups"
LOG="/logs/parsers.log"

SITE_DATA="$DATA_DIR"
TMP_OUT="$TMP"
DATE=$(date +%Y-%m-%d)

BOT_TOKEN="${BOT_TOKEN}"
CHAT_ID="${CHAT_ID}"

send_tg() {
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "text=$1" >/dev/null
}

log() {
  echo "[$(date)] $1" | tee -a "$LOG"
}

fail() {
  log "❌ $1"
  send_tg "❌ Parser failed: $1"
  exit 1
}

mkdir -p "$TMP_OUT" "$BACKUP_DIR" "$(dirname $LOG)"

log "📦 Backup current data"
mkdir -p "$BACKUP_DIR/$DATE"
cp -r "$SITE_DATA"/* "$BACKUP_DIR/$DATE/" || true

log "▶ Running parsers"

node parser_tr1.js --out "$TMP_OUT/tr1.json" || fail "parser_tr1"
node parser_tr2.js --out "$TMP_OUT/tr2.json" || fail "parser_tr2"

log "🔎 Validating JSON"

for f in tr1.json tr2.json; do
  jq empty "$TMP_OUT/$f" || fail "$f broken"
done

log "🚀 Deploying new data"

cp "$TMP_OUT/tr1.json" "$SITE_DATA/"
cp "$TMP_OUT/tr2.json" "$SITE_DATA/"

log "♻ Restarting web"
curl -X POST http://web:3000/api/restart || true

log "✅ Done"
send_tg "✅ Расписание обновлено"