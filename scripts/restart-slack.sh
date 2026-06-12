#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# .env 読み込み
set -a
source .env
set +a

# 既存プロセスを停止
EXISTING=$(pgrep -f "tsx src/cli/slack.ts" || true)
if [ -n "$EXISTING" ]; then
  echo "既存プロセス停止: PID $EXISTING"
  kill "$EXISTING"
  sleep 1
fi

# 起動（既定は info レベル。プロンプト全文を追う時は -- --verbose を付ける）
nohup npm run slack -- "$@" > /tmp/local-bot-slack.log 2>&1 &
echo "起動完了: PID $!"
