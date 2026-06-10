Slack bot を再起動する。

1. `pgrep -f "tsx src/cli/slack.ts"` で既存プロセスを確認し、あれば kill する
2. プロジェクトルートの `.env` を読み込んで環境変数をセットする
3. `nohup npm run slack -- --verbose > /tmp/local-bot-slack.log 2>&1 &` でバックグラウンド起動する
4. 起動後 3 秒待って `/tmp/local-bot-slack.log` の末尾を表示し、正常起動を確認する
