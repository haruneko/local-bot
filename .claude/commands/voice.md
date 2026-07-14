VOICEVOX ENGINE（WSL2 の Docker コンテナ `voicevox`）を起動/停止する。メイン機は DAW・ゲームと共用なので**常駐させない**（restart policy は `no` のまま変えない）方針。

引数: `$ARGUMENTS`（`start`（既定・空のときも start）/ `stop` / `status`）

## start（既定）

1. `docker start voicevox` を実行（コンテナが無ければ `docker run -d --name voicevox --restart=no -p 127.0.0.1:50021:50021 voicevox/voicevox_engine:cpu-latest` で作る）
2. `curl -s -m 2 http://127.0.0.1:50021/version` を 2 秒間隔で最大 30 秒リトライし、version が返ったら起動完了
3. `npm run smoke:voice` で合成＋再生まで確認し、結果を報告する

## stop

1. `docker stop voicevox` を実行
2. `docker ps --filter name=voicevox --format '{{.Status}}'` が空であることを確認して「停止した（メモリ解放済み）」と報告する

## status

1. `docker ps -a --filter name=voicevox --format '{{.Status}}'` と `curl -s -m 2 http://127.0.0.1:50021/version` の結果を1行で報告する

## 注意

- restart policy を `unless-stopped` 等に変えない（常駐させない方針・DECISIONS §口）
- エバ側は ENGINE が落ちていても degrade でテキスト続行するので、stop したままでも会話は壊れない
