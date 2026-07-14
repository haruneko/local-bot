#!/usr/bin/env bash
# data/（記憶の実体: lancedb / notes / steps / state.json ほか）のバックアップ。
# git 管理外の grow-only データに復旧手段が無いため、tar 世代でロールバック可能にする。
# frames は視覚センサーの使い捨てフィードなので含めない。
#
#   npm run backup            # backups/data-<timestamp>.tar.gz を作成、KEEP 世代より古いものを削除
#   BACKUP_DIR=... KEEP=14 npm run backup
#
# cron 例（毎日 4:00）: 0 4 * * * cd /home/shuraba_p/projects/local-bot && npm run backup >/dev/null
set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-backups}"
KEEP="${KEEP:-7}"

if [ ! -d data ]; then
  echo "data/ が無い（リポジトリ直下で実行すること）" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
stamp="$(date +%Y%m%d-%H%M%S)"
archive="$BACKUP_DIR/data-$stamp.tar.gz"

tar czf "$archive" --exclude='data/frames' data
echo "backup: $archive ($(du -h "$archive" | cut -f1))"

# 世代ローテーション: 新しい順に KEEP 件残して削除
ls -1t "$BACKUP_DIR"/data-*.tar.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
  rm -f "$old"
  echo "rotate: removed $old"
done
