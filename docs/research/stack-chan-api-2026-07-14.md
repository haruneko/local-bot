# スタックチャン API・ファームウェア事前調査（口・首・目・耳の HTTP 化）

> 状態: 2026-07-14 実施・未引用

## 目的

自宅 AI エージェント（WSL2・LAN 内）から **スタックチャンを HTTP で叩いて 口（音声再生）・首（パンチルト）・目（カメラ画像取得）・耳（マイク）として使う**ための事前調査。狙いの理想 API は `docs/ARCH-NEXT.md §スタックチャン統合スケッチ` の通り: 口=文単位の wav を LAN で鳴らす／首=`/look?pan=&tilt=`／目=`/frame.jpg`。WSL2 は USB 直挿しが地雷なので全て LAN/HTTP。以下は「うちの設計にどう繋がるか」判定を優先。

## 完成品候補と出荷ファーム

| 製品 | ハード | サーボ | マイク/スピーカー/カメラ | 完成品? | 出荷ファーム |
|---|---|---|---|---|---|
| **M5 スタックチャン（公式・Switch Science）** ¥18,150（+¥22,990 ジョイスティック版） 2026-05-08 発売・**7月出荷** | CoreS3（ESP32-S3・16MB flash/8MB PSRAM）+ 専用ベース | **2軸**（水平360°連続＋垂直90°） | デュアルマイク / 1W スピーカー / 0.3MP カメラ(GC0308 640×480) あり | **完成品（CoreS3 プリインストール・OTA 更新）** | 公式 AI エージェント（クラウド連携・ESP-NOW リモコン・スマホアプリ `StackChan World` でセットアップ）。**通信は WebSocket＋Opus 音声（サーバが合成音声を push）** |
| タカオ版組立キット（@mongonta0716 / SG90・SCS0009） | Core2/Basic 等 + SG90 or SCS0009 サーボ | 版により1〜2軸（首振りは2軸パンチルトが定番） | 本体内蔵（Core2 マイク/スピーカー、カメラ無し） | キット（要組立・3Dプリント or 頒布筐体） | 素の stack-chan firmware（Moddable）。AI 化は AI_StackChan2 等を各自書き込み |

要点: **今すぐ買える「完成品」は実質 公式 M5 スタックチャン（CoreS3）一択**。カメラ・2軸首・デュアルマイク・スピーカーが全部入りで、うちの口/首/目/耳の全チャンネルに物理的には対応する。ただし**出荷ファームはクラウド前提**（後述）。

## ファーム別 API 一覧

| ファーム | 制御経路 | 発話 | 表情 | 音量/設定 | 首(サーボ) | カメラ | マイク→LAN | 対象HW |
|---|---|---|---|---|---|---|---|---|
| **AI_StackChan2 系**（robo8080・de-facto 標準・派生多数） | **LAN HTTP(REST)** | `/chat?voice=&text=`（**テキスト→本体側TTS**。VOICEVOX web/OpenAI等） | 未確認（README に `/face` 記載なし・下記CONNECTでは有） | `/setting?speaker=&volume=` `/role` `/role_get` `/apikey` | **HTTP 直制御は未文書**（画面タッチで首振り停止のみ） | 無（DevCam 派生は本体表示/顔検出のみ・**LAN配信なし**・未確認） | 無（本体で Whisper/Google STT→クラウド） | 主に Core2 |
| **StackChan CONNECT 対応**（yh1224・スマホアプリが叩く LAN REST の事実上の共通仕様） | **LAN HTTP(REST)** | `/speech`(say=) `/chat`(text=) | **`/face`** あり | `/setting` `/role` `/role_get` `/role_set` `/apikey` | 未確認（アプリは首制御あるが HTTP 個別 EP は未確認） | 無 | 無 | Core2/CoreS3/Core・Fire |
| **stack-chan 本家 firmware**（Moddable SDK・TS/JS） | **物理ボタン中心・HTTP サーバは README に無し（`/docs/api.html` に別途 API あり・未読）** | クラウドTTS（VOICEVOX/ElevenLabs）を JS から呼ぶ | JS で avatar 制御 | — | JS driver で制御（Feetech/FUTABA/DYNAMIXEL/PWM）。**LAN からの直叩きは未確認** | 無 | 無 | Basic/Gray/Fire/Core2（CoreS3 は Issue #177 で対応要望） |
| **公式 M5 スタックチャン出荷ファーム**（m5stack/StackChan・**OSS**） | **WebSocket＋Opus**（device⇄server） | **サーバが合成音声(Opus)を push→本体が再生**。本体TTSではない | サーバ JSON コマンドで制御（拡張可） | config.json でサーバ URL 差替 | サーバ側から制御想定（ESP-NOW リモコンでも pan/tilt） | スマホアプリで映像監視（LAN 配信 EP は未確認） | Opus フレームをサーバへ送出（WS 経由） | CoreS3 |

**最重要判定（音声の入口）**: AI_StackChan2 系／CONNECT 系はいずれも **テキストを送って本体側で TTS**（VOICEVOX/OpenAI）。外部で合成した wav/mp3 をアップロードして鳴らす HTTP エンドポイントは**確認できず（未確認＝おそらく無い）**。一方 **公式出荷ファームは WebSocket で "サーバが合成した Opus 音声を本体が再生"** する構造＝**外部音声を鳴らす経路は公式ファームの WS 側に既にある**（ただし HTTP POST /play ではなく WS＋Opus）。

## うちの設計への接続判定

- **口（最重要）**: うちは VOICEVOX（Windows ホスト）で文ごとに wav を作り「その wav を LAN で鳴らす」設計。
  - AI_StackChan2 の `/chat?text=` は**テキストを渡すと本体が別TTSで喋る**＝うちの「VOICEVOX の声で・文単位ストリーミング」と噛み合わない（声が二重、テンポも本体TTS律速）。**そのままでは不適**。
  - 公式ファームの **WS＋Opus 音声 push は思想が一致**（外部で作った音声を本体が鳴らす）。うちの wav を Opus 化して WS で流せば「口」になる。ただし WS プロトコル実装＋Opus エンコードのコストがかかる（HTTP より重い）。
  - **理想の `POST /play`(wav) は既存ファームに無い**。作るなら Arduino/PlatformIO で AI_StackChan2 の HTTP サーバに `/play`（body=wav/opus→I2S 再生）を1本足すのが最短（後述）。
- **首**: 2軸パンチルトのハードは公式・タカオ版とも有り。**`/look?pan=&tilt=` に相当する LAN HTTP EP は既存ファームで未確認**（サーボ制御は本体内/アプリ/ESP-NOW 経由）。自作で追加が要る。
- **目**: CoreS3 は 0.3MP カメラ内蔵。だが **`/frame.jpg` 相当を返すファームは確認できず**（DevCam は本体表示/顔検出のみ・未確認）。ただし **ESP32 の CameraWebServer（`/capture`・MJPEG stream）は定番中の定番**で、CoreS3 カメラを `/capture` で JPEG 配信するのは技術的に軽い。うちの `readFrames→image_feed` にそのまま乗る。
- **耳**: 本体マイク音声を LAN 側へ生で流す仕組みは、公式ファーム（WS＋Opus 送出）以外に確認できず。AI/CONNECT 系は本体内で STT する。**→「耳は当面 PC マイク」の裏付けになる**（ARCH-NEXT の耳は当面 PC で正しい）。公式 WS を使えば将来 Opus 受信で耳も賄える可能性はあるが未検証。

## 推奨経路

- **第一候補: 公式 M5 スタックチャン（CoreS3・完成品）を入手し、ファームは自作/改造**。出荷ファームのクラウド WS 依存を外し、**Arduino/PlatformIO で AI_StackChan2 をベースに、うちの理想 API を薄く増設**する:
  - `POST /play`（body=wav or opus → I2S 再生。M5Unified の Speaker で実装可）
  - `GET /capture`（CoreS3 カメラ → JPEG。ESP32 CameraWebServer をほぼ流用）
  - `GET /look?pan=&tilt=`（M5Unified/ServoEasing でサーボ2軸）
  - 既存の `/setting` `/role` `/face` はそのまま流用。改造コストは**中**（HTTP サーバ骨格・サーボ・スピーカー・カメラの各サンプルが全て揃っているため、貼り合わせが主）。
- **フォールバック（手数最小・声が本体TTSで良ければ）**: AI_StackChan2 系ファームをそのまま焼き、**`/chat?text=` にテキストだけ渡す**。VOICEVOX ストリーミングは諦め、口は本体TTS任せ、首/目は後追いで自作追加。まず「喋る箱」を最短で立てたい時の逃げ道。
- Moddable 本家は TS で書けて魅力だが、**LAN HTTP 制御が未確認＋CoreS3 対応が弱い**ので、うちの HTTP 前提とは相性が落ちる（第三候補）。

## 運用上の注意（分かる範囲）

- **技適**: M5Stack 公式製品（CoreS3）は技適取得済みが通例（要最終確認・未確認）。自作 ESP32 モジュールを別途足す場合は技適に注意。
- **電源**: サーボ2軸＋カメラ＋スピーカーは瞬時電流が大きい。USB 給電だと弱いことがあり、サーボは別電源 or 余裕ある 5V が定番。
- **OTA**: 公式ファームは OTA 更新前提。自作ファームに載せ替えると公式アプリ/OTA の管を外すことになる（戻すのは再フラッシュ）。
- **カメラ画質**: 0.3MP（640×480・GC0308）＝「見にいく」用途には十分だが精密認識には非力（recognition faculty は別途の想定と整合）。
- **WSL2**: 全て LAN/HTTP で叩く前提は既存結論通り正しい（USB 直挿し回避）。デバイスは固定 IP or mDNS 名で参照する運用が楽。

## 出典 URL 一覧

- 公式 M5 スタックチャン 販売（Switch Science プレスリリース・2026-05-08）: https://prtimes.jp/main/html/rd/p/000000244.000064534.html
- 公式製品ページ: https://www.switch-science.com/products/11129
- m5-docs StackChan（OSS・app/firmware/remote/server・CoreS3・OTA）: https://docs.m5stack.com/en/StackChan
- m5stack/StackChan リポジトリ（Go/C/C++/Dart・server 同梱）: https://github.com/m5stack/StackChan
- 標準クラウド置換の自作 TS サーバ（WebSocket＋Opus プロトコル解説・ckoshien）: https://zenn.dev/ckoshien/articles/a534b7cf15dff1
- AI_StackChan2 README（`/chat` `/setting` `/role` 等の HTTP API）: https://github.com/robo8080/AI_StackChan2_README/
- AI_StackChan2 本体: https://github.com/robo8080/AI_StackChan2
- StackChan CONNECT（`/speech` `/chat` `/face` `/setting` `/role*` の LAN REST 共通仕様・yh1224）: https://notes.yh1224.com/stackchan-connect/
- AIStackchan-hrs（`/speech` `/chat` `/settings`・CoreS3/Core2 対応・yh1224）: https://github.com/yh1224/AIStackchan-hrs
- AI_StackChan2_DevCam（CoreS3 カメラ・本体表示/顔検出・ronron-gh）: https://github.com/ronron-gh/AI_StackChan2_DevCam
- stack-chan 本家 firmware（Moddable SDK・TS）: https://github.com/stack-chan/stack-chan/blob/main/firmware/README.md ／ https://stack-chan.github.io/stack-chan/firmware/
- CoreS3 対応 Issue #177: https://github.com/stack-chan/stack-chan/issues/177
- ESP32 CameraWebServer（`/capture`・MJPEG の定番）: https://github.com/m5stack/M5Stack-Camera ／ https://randomnerdtutorials.com/esp32-cam-video-streaming-web-server-camera-home-assistant/
