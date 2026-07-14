# スタックチャン公式ファーム WebSocket プロトコル仕様（サーバ⇄デバイス）

> 状態: 2026-07-14 実施・未引用
> 調査対象: https://github.com/m5stack/StackChan （公式・OSS・MIT）
> clone HEAD: `b72b3ede38b32d54f0b6ba51c62cfcef2ec3ae1e`（2026-07-02 "Merge pull request #100 from m5stack/firmware-dev"）
> 目的: エバが公式ファームの CoreS3 スタックチャンに対し**自前サーバとして振る舞い**、VOICEVOX 合成音声を鳴らし首・表情を制御するための実装仕様。
> 表記: 【事実】=コード出典つき（`server/…` `firmware/…` は上記リポジトリ内相対パス）。【外部】=別リポの確立仕様を WebFetch で確認。【推測】=コードから未確定。

## 0. 全体像（最重要・ここを外すと設計を誤る）

公式ファームには **WS 経路が 2 本**ある。前回調査の「WS+Opus」は 2 本を混同していた。

| 経路 | 相手 | 何が流れるか | 実装の所在 |
|---|---|---|---|
| **A: AI 音声ループ（口・耳の本命）** | **xiaozhi.me クラウド**（既定） | ASR/LLM/TTS。マイク Opus 上り＋TTS Opus 下り＋listen/tts/stt 制御 JSON | firmware は managed component `web_socket.h`（xiaozhi-esp32 由来）。**本リポには無い** |
| **B: リモート制御／通話リレー** | **本リポの Go サーバ**（`:12800`） | App(スマホ)⇄本体 の中継: 首/表情/カメラJPEG/ビデオ通話/テキスト | 【事実】`firmware/main/hal/hal_ws_avatar.cpp` ⇔ `server/internal/web_socket/web_socket.go` |

- 経路 B の Go サーバは **AI をしない**。App(`StackChan World`)とデバイスを MAC で突き合わせて中継するだけ。AI 会話は経路 A で xiaozhi.me に委譲（【事実】`server/internal/xiaozhi/xiaozhi.go` は xiaozhi.me の**管理 API**=デバイス登録/agent 設定のみで、音声は扱わない）。
- **エバの取りうる 2 案**:
  - **案1（口＝経路 A を乗っ取る）**: デバイスが叩く xiaozhi WS エンドポイント URL を自前サーバに差し替え、xiaozhi-esp32 WS プロトコルを喋る。→ TTS(VOICEVOX→Opus) を本体スピーカーで直接鳴らせる＝口として本命。首/表情は経路 A の MCP/デバイス制御に乗るか要確認（【推測】経路 A の首制御は未確認）。
  - **案2（首・表情・カメラ＝経路 B の App になりすます）**: 本リポ Go サーバ相当を自前実装し、`deviceType=App` で繋いで ControlMotion/ControlAvatar を送る。首・表情・カメラJPEG は**完全に本リポにコードがある**＝仕様確定。ただし経路 B の Opus は「App⇄本体の通話音声」用で、AI 発話用ではない。
  - **現実解**: 口＝案1（xiaozhi 差し替え）、首・表情・目＝案2（B の ControlMotion/Avatar/Jpeg）を**併用**が最短。両経路とも自前サーバで賄える。

---

## 1. 接続

### 経路 B（本リポ・確定）
- 【事実】URL パス `/stackChan/ws`、ポート **12800**（`server/internal/cmd/cmd.go:44,86`）。TLS 無し（`s.Run()` 平文 HTTP）。
- 【事実】デバイスは `{server_url}/stackChan/ws?deviceType=StackChan` に接続（`hal_ws_avatar.cpp:66`）。App は `?deviceType=App&deviceId=<id>`（`web_socket.go:119,203`）。クエリ `deviceType` 必須。
- 【事実】**認証** = `Authorization` ヘッダ（`hal_ws_avatar.cpp:117`）。サーバは base64→RSA 復号し `mac|?|timestamp` を取り出す。ts の許容ずれ ±10 秒（`web_socket.go:78-107`）。→ MAC はトークンから来る（クエリでなく）。
- 【事実】**server_url / トークン生成は OSS では weak stub**: `get_server_url()` は `CONFIG_STACKCHAN_SERVER_URL`（未設定なら `http://localhost:3000`）、`generate_auth_token()` は文字列 `"hi-stack-chan"` を返すだけ（`firmware/main/hal/utils/secret_logic/secret_logic.cpp:11-28`）。実機の RSA 署名ロジックは**非公開のボード側で override**（`__attribute__((weak))`）。
  - → **サーバ URL 差し替え手段**: firmware ビルド時 `CONFIG_STACKCHAN_SERVER_URL`（Kconfig）。【推測】完成品はセットアップ App / config で書き換え可能（要実機確認）。自前サーバ側で RSA 検証を**素通し**すれば実機の署名を気にせず受けられる。
- 【事実】接続直後、デバイスはテキストフレーム `{"type":"hello", "msg":"Hello from StackChan!"}` を 1 回送る（`hal_ws_avatar.cpp:124`）。サーバはこれに応答不要（Go 側はテキストを App へ中継するだけ）。
- 【事実】**再接続**: デバイスは 5 秒ごとに未接続なら再接続（`hal_ws_avatar.cpp:153`）。10 秒 heartbeat 無しでタイムアウト扱い（同:160）。サーバは 15 秒無通信でクライアント掃除（`socket_task.go:24 ClientExpireTimeout`）。

### 経路 A（xiaozhi・外部）
- 【外部】`Authorization: Bearer <token>` / `Protocol-Version` / `Device-Id`(MAC) / `Client-Id`(UUID) ヘッダ。URL は agent 設定由来。【推測】完成品での差し替え点は要実機確認（xiaozhi は OTA 設定 or setup で URL 注入が定石）。

---

## 2. 二値フレーム framing（経路 B・確定）

【事実】`web_socket.go:307-323 / 813-828`、`hal_ws_avatar.cpp:440-479`。WS **BinaryMessage** の中に独自ヘッダ:

```
[ 1 byte: msgType ][ 4 byte: payloadLen (uint32, Big-Endian) ][ payload ... ]
```

- ヘッダ 5 バイト固定。`payloadLen` は payload 部のみの長さ。長さ不一致は破棄（`web_socket.go:317`）。
- App→サーバの一部型（Opus/Jpeg/Control*/Text/RequestCall）は payload 先頭 **12 バイトが対象デバイス MAC 文字列**、以降が実データ（サーバが MAC でルーティング後、剥がして本体へ転送）（`web_socket.go:518-568`）。**本体⇄自前サーバを直結する場合この 12 バイト前置は不要**（サーバが本体へ送るときは付けない＝`createMessage` はそのまま）。

---

## 3. メッセージ型一覧（経路 B・msgType バイト）

【事実】定数は `web_socket.go:28-62` と `hal_ws_avatar.cpp:36-57`（両者一致）。方向 S=自前サーバ, D=本体, A=App。

| 型 | byte | 意味 | payload | 本体の挙動（出典 hal_ws_avatar.cpp） |
|---|---|---|---|---|
| Opus | 0x01 | 音声フレーム | 生 Opus（経路Bでは通話用） | ※本体では "OnData Fast Path" で別処理（:200 コメント。B 経由 TTS ではない） |
| Jpeg | 0x02 | 静止画フレーム | JPEG バイト列 | S→D: 画面に表示（:317 decode）。D→S: カメラ送出 |
| **ControlAvatar** | 0x03 | **表情制御** | JSON文字列（§5） | `updateAvatarFromJson`（:221） |
| **ControlMotion** | 0x04 | **首制御** | JSON文字列（§5） | `updateMotionFromJson`（:230） |
| OnCamera/StartCameraStream | 0x05 | カメラ配信 ON | — | streaming=true（:209） |
| OffCamera/StopCameraStream | 0x06 | カメラ配信 OFF | — | streaming=false（:215） |
| TextMessage | 0x07 | テキスト吹き出し | JSON `{"name","content"}` | 吹き出し＋表情（:279） |
| RequestCall | 0x09 | 通話要求 | 発信者名 | 着信 UI（:239） |
| DeclineCall/RefuseCall | 0x0A | 通話拒否 | — | — |
| AcceptCall/AgreeCall | 0x0B | 通話許可 | — | カメラ/音声購読開始（web_socket.go:345） |
| EndCall/HangupCall | 0x0C | 通話終了 | — | 購読解除（:248） |
| SetDeviceName/UpdateDeviceName | 0x0D | 名前設定 | 新名称文字列 | NVS 保存（:253） |
| GetDeviceName | 0x0E | 名前取得 | — | 名称を同型で返信（:264） |
| inCall | 0x0F | 通話中通知 | 文字列 | （App向け・web_socket.go:598） |
| **ping** | 0x10 | keepalive Ping | — | **本体は即 pong(0x11) を返す**＋heartbeat 更新（:273） |
| pong | 0x11 | keepalive Pong | — | サーバは受信のみ（web_socket.go:333） |
| OnPhoneScreen/VideoModeOn | 0x12 | 画面共有/ビデオON | — | video_mode=true（:305） |
| OffPhoneScreen/VideoModeOff | 0x13 | 画面共有/ビデオOFF | — | video_mode=false（:311） |
| Dance/DanceSequence | 0x14 | ダンス列 | JSON配列（§5.3） | keyframe 列で動く（:349） |
| GetAvatarPosture | 0x15 | 姿勢取得 | — | （App向け中継） |
| DeviceOffline | 0x16 | 本体オフライン通知 | 文字列 | （App向け・web_socket.go:230） |
| DeviceOnline | 0x17 | 本体オンライン通知 | 文字列 | （App向け・web_socket.go:167） |
| OnAudio/StartAudioStream | 0x18 | 音声配信 ON | — | 本体側 no-op（:359） |
| OffAudio/StopAudioStream | 0x19 | 音声配信 OFF | — | 本体側 no-op（:362） |
| AimedTakePhoto | 0x1A | 狙い撮影 | — | （web_socket.go:455） |

**エバ→本体の最小コマンド**（自前サーバから本体へ直送、MAC 前置なし）: ControlMotion(0x04) / ControlAvatar(0x03) / TextMessage(0x07) / Jpeg 要求は OnCamera(0x05) を送ると本体が Jpeg(0x02) を返す。ping(0x10) を定期送出し pong(0x11) を受ける。

---

## 4. 音声（Opus）— 経路 A（xiaozhi・口/耳の本命）

【外部】xiaozhi-esp32 WS プロトコル ＋ 【事実】StackChan ボード設定で上書き。

- **hello（本体→サーバ）** JSON: `{"type":"hello","version":1,"transport":"websocket","features":{"mcp":true,"aec":true},"audio_params":{"format":"opus","sample_rate":<R>,"channels":1,"frame_duration":60}}`
- **サーバ hello 応答（必須）**: `{"type":"hello","transport":"websocket","session_id":"...","audio_params":{...}}` を返さないと本体が待つ【外部】。
- **サンプルレート**: xiaozhi 既定は 16000 だが、【事実】StackChan は入出力とも **24000 Hz**（`firmware/main/hal/board/config.h:9-10 AUDIO_*_SAMPLE_RATE 24000`）。→ **VOICEVOX wav(24kHz mono) → Opus(24000Hz, 1ch, 60ms frame)** で TTS 下りを作れば本体設定と一致【推測: hello の sample_rate が 24000 を名乗るはず・要実機確認】。
- **バイナリ framing**: 【外部】version1=生 Opus フレームそのまま（ヘッダ無し）。version2/3 は type/timestamp 付きヘッダ。StackChan がどれを使うかは managed component 版依存【推測・要実機】。
- **TTS 下り制御 JSON（サーバ→本体）**: `{"type":"tts","state":"start"}` → Opus フレーム列 → `{"type":"tts","state":"sentence_start","text":"..."}`（口パク用文）→ `{"type":"tts","state":"stop"}`【外部】。
- **マイク上り（本体→サーバ・耳）**: 本体が Opus フレームを送出。`{"type":"listen","state":"start","mode":"auto|manual|realtime"}` / `"stop"` / `"detect"` で制御【外部】。VAD/AEC は本体側 `features.aec` と esp-sr（`idf_component.yml: espressif/esp-sr`）で本体内実行【事実: 依存あり】。
- **wav→Opus 変換パラメータ一式（エバが用意すべき）**: sample_rate=24000, channels=1, frame_duration=60ms（=1440 サンプル/フレーム）, application=VOIP or AUDIO, ビットレート【推測: 未確定・xiaozhi 実装は可変・要実機で確認、目安 24kbps 前後】。

---

## 5. コマンド系 JSON スキーマ（経路 B・確定）

出典【事実】`firmware/main/stackchan/json/json_helper.cpp`（唯一のパーサ）。ControlMotion(0x04)/ControlAvatar(0x03) の payload は下記 JSON 文字列。

### 5.1 首（ControlMotion 0x04）— `motion::update_from_json`（:117）
```json
{ "yawScheme": "...", "pitchServo": {...}, "yawServo": {...} }
```
- キーは **`yawServo`（水平/pan）** と **`pitchServo`（垂直/tilt）**。各値オブジェクト:
  - `angle`(int) 必須。単位は内部スケール（0.1度）。【事実】可動域 `hal_servo.cpp:340,349`: yaw `[-1280,1280]`（=±128°）, pitch `[30,870]`（=3°〜87°）。範囲外は clamp。
  - `speed`(int 0-1000) 任意 → 速度指定移動（`moveWithSpeed`, :89）。
  - `spring`(obj `{stiffness(float 既定170), damping(float 既定26)}`) 任意 → バネ移動（:96）。
  - `rotate`(int) 任意 → 連続回転モード（360°サーボ・angle より優先, :77）。
  - 例: `{"yawServo":{"angle":300,"speed":400},"pitchServo":{"angle":450}}`（正面やや右・水平30°、上向き45°相当）。

### 5.2 表情（ControlAvatar 0x03）— `avatar::update_from_json`（:41）
```json
{ "leftEye":{...}, "rightEye":{...}, "mouth":{...} }
```
- 各パーツ obj: `x`(int),`y`(int)（両方あれば位置）, `rotation`(int), `weight`(int), `size`(int)。全て任意・与えた項目だけ更新（:16-38）。
- 例（口を開ける＝発話同期）: `{"mouth":{"size":40}}`。【推測】感情プリセット（Happy 等）は経路 B の ControlAvatar には無く、TextMessage の content 語句トリガ（hello/love→Happy, `app_avatar.cpp:198`）か、Emotion モディファイア（本体内部）経由。表情の細粒度制御は上記 5 パラメータのみ。

### 5.3 ダンス（Dance 0x14）— `parse_sequence_from_json`（:178）
- **JSON 配列**。各要素 = keyframe: `leftEye/rightEye/mouth`(§5.2 と同型)、`yawServo/pitchServo`(`{angle,speed}`)、`leftRgbColor/rightRgbColor`(文字列)、`durationMs`(int)。首+表情+LED を時間割で動かす一括手段。

### 5.4 テキスト吹き出し（TextMessage 0x07）
- payload JSON `{"name":"<話者>","content":"<本文>"}`（`hal_ws_avatar.cpp:292`）→ 画面に "name says: content" を 6 秒表示（`app_avatar.cpp:194`）。**これは口パク付き字幕であって音声ではない**。

---

## 6. カメラ（経路 B・確定）

- 【事実】自前サーバが **OnCamera(0x05)** を本体へ送ると streaming ON、本体は **Jpeg(0x02)** フレームを周期送出（通常 350ms / ビデオモード 700ms 間隔・`hal_ws_avatar.cpp:169`）。JPEG 品質 20、解像度はカメラ設定（0.3MP GC0308 想定）。OffCamera(0x06) で停止。
- payload = 生 JPEG バイト列（5 バイトヘッダの後）。→ エバの `readFrames→image_feed` にそのまま乗る。**静止画取得は OnCamera→1枚受信→OffCamera でも可**。

---

## 7. セッション/状態機械（経路 B）

1. 本体起動 → WiFi → `{server_url}/stackChan/ws?deviceType=StackChan` へ接続（Authorization ヘッダ）。
2. 接続直後 本体が `{"type":"hello",...}` テキスト送信。
3. サーバは 15 秒以内に何か送らないと本体側 heartbeat タイムアウト。**サーバは定期的に ping(0x10) を送る**（本リポは `socket_task.go StartPingTime` を cron で回す。`boot.InitCron()`・`cmd.go:47`）。本体は pong(0x11) を返す。
4. 以後、サーバ→本体: ControlMotion/ControlAvatar/TextMessage/OnCamera を随時。本体→サーバ: pong / Jpeg / GetDeviceName 応答等。
5. **サーバが最低限応答すべきもの**: (a) 定期 ping 送出（本体の 10 秒タイムアウト回避）、(b) GetDeviceName(0x0E) 受信時に名前を同型で返す（任意）、(c) 本体 hello テキストは無視で可。

---

## 8. エバ側シンク実装チェックリスト

### 足りている（コードから確定・実機なしで書ける）
- [x] 経路 B の WS URL・ポート・framing（`[type][len BE32][payload]`）・全 msgType 表（§2,3）。
- [x] 首制御 JSON（yawServo/pitchServo, angle/speed/spring/rotate, 可動域 ±1280 / 30-870）（§5.1）。
- [x] 表情制御 JSON（leftEye/rightEye/mouth の x/y/rotation/weight/size）（§5.2）。
- [x] カメラ JPEG 取得（OnCamera→Jpeg 周期受信）（§6）。
- [x] keepalive（ping/pong 0x10/0x11・タイムアウト値）（§7）。
- [x] 認証は自前サーバなら**素通し可**（RSA 検証を省けば実機署名不問）。TextMessage 字幕（§5.4）。
- [x] 口の本命=経路 A（xiaozhi WS）の hello/tts/listen 制御 JSON と Opus 24kHz/1ch/60ms（§4）。

### 足りていない（実機 or 追加調査が要る）
- [ ] **完成品でのサーバ URL 差し替え手段**（config.json? setup App? Kconfig 再ビルド?）。→ 実機の設定 UI か、`app_setup` の該当 worker を要確認。firmware 再ビルドが要るなら OTA/公式管を外すことになる。
- [ ] **経路 A の URL 差し替え点**と、StackChan 版 managed `web_socket.h` が使う xiaozhi プロトコル**バージョン**（binary framing v1/v2/v3 のどれか、hello の実測 sample_rate=24000 か）。→ 実機のパケットキャプチャが確実。
- [ ] **Opus 下りビットレート**の実効値（本体デコーダが許容する範囲）。
- [ ] **首・表情を経路 A（AI 音声側）から動かせるか**（xiaozhi MCP tool として首/表情が露出しているか）。露出していれば口＋首＋表情を経路 A 一本で賄える可能性。→ 実機で MCP tool list を確認。
- [ ] servo 角度スケールが 0.1 度で正しいか（`angleLimit` の単位）。実機で 1 コマンド打って実測が速い。
- [ ] マイク上り（耳）の実運用: 本体が listen 制御にどう反応するか（wake word 必須か realtime 可か）。

### 結論（実機前にどこまで書けるか）
- **首・表情・目（カメラ）は今すぐ実装可**: 自前 Go 相当サーバ（`deviceType=App` 中継 or 直結）＋ §3/§5/§6 で完全に足りる。エバ側は「WS サーバ + `[type][len][json]` エンコーダ + servo/eye/mouth JSON ビルダ + JPEG デコード」を書けばよい。
- **口（VOICEVOX 発話）は経路 A（xiaozhi 差し替え）が必要**で、hello/tts/Opus の**枠組みは書けるが**、URL 差し替え点・framing バージョン・実効 sample_rate の 3 点は**実機で確定**が要る。

---

## 出典（本リポ内・相対パス）
- `server/internal/cmd/cmd.go`（WS ルート・ポート 12800）
- `server/internal/web_socket/web_socket.go`（msgType 定数・framing・中継ロジック）
- `server/internal/web_socket/socket_task.go`（ping・15秒タイムアウト）
- `server/internal/xiaozhi/xiaozhi.go`（xiaozhi.me 管理 API＝音声を扱わない証拠）
- `firmware/main/hal/hal_ws_avatar.cpp`（本体 WS クライアント・DataType・sendPacket framing・hello・再接続）
- `firmware/main/hal/utils/secret_logic/secret_logic.cpp`（server_url/token の weak stub）
- `firmware/main/hal/board/config.h`（AUDIO_*_SAMPLE_RATE 24000）
- `firmware/main/hal/hal_servo.cpp`（yaw/pitch angleLimit 実値）
- `firmware/main/stackchan/json/json_helper.cpp`（首/表情/ダンス JSON スキーマ・唯一のパーサ）
- `firmware/main/apps/app_avatar/app_avatar.cpp`（各 WS イベントの本体挙動）
- `firmware/main/idf_component.yml`（xiaozhi/esp-sr 依存＝経路 A の存在証拠）
- 【外部】xiaozhi-esp32 WS 仕様（hello/tts/listen/Opus・WebFetch 2026-07-14）
