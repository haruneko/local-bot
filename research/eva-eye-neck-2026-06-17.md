# エバの「目」と「首」ハード選定レポート（2026-06-17）

自宅向けローカル LLM 対話エージェント「エバ」に、物理的な目（webカメラ）と首（パン/チルト機構）を与えるための即決用ハード選定。**最重要のハード制約は「映像・画像データをクラウドに一切渡さないこと」。** 撮影・取得・制御はすべてローカル LAN 内で完結させる。実行マシンは WSL2（Ollama は Windows ホスト側）で、**WSL2 への USB パススルーは地雷**のため LAN/HTTP 接続を最優先する。

過去メモ（`data/notes/USB-camera-pan-tilt-control-plan.md` ほか2件）は ESP32+サーボ構成の方向性スケッチに留まっていた。本レポートはそれを 2026 年の入手性・型番・価格・組み立てまで具体化し、置き換える。設計思想は `docs/ARCH-NEXT.md`「2.1 目と耳と口」（生の画像は板の専用チャンネルに乗せ、ピクセルは符号化時に embed して捨てる＝受動の視覚）に接続する。

---

## 推奨1案

**ESP32-CAM（AI-Thinker・OV2640）＋ SG90 サーボ2軸のパンチルトリグを自作し、ESP32 が LAN に MJPEG ストリームと HTTP 制御 API を出す。エバは HTTP で映像取得と首振りを叩く。**

理由3行:
1. **プライバシーが構造的に守られる** — ベンダークラウドが存在せず、映像も制御も自宅 LAN で閉じる。ファームは自作なので外部送信のコードが入る余地がない。
2. **WSL2 と相性が最良** — USB パススルー不要。映像取得は `http://<ip>/stream`（MJPEG）、制御は `http://<ip>/pan?deg=90` の素の HTTP fetch のみ。既存の `browse_url`（素の fetch）と同じ筋。
3. **安く・実績が豊富** — 部品総額 ¥3,000〜4,000。Random Nerd Tutorials / GitHub に "ESP32-CAM pan-tilt webserver + servo" の完成ファームが複数あり、ほぼそのまま動く。思想（自分の体を自分で作る）にも合う。

唯一の弱点は OV2640 の画質（1600×1200・暗所弱い）と ESP32 の MJPEG が低fps・単一クライアント寄りなこと。だが「受動の視覚（recognition 用 embedding）」に画質は不要で、十分。画質を将来上げたくなったら推奨構成のサーボ雲台はそのまま流用し、カメラだけ差し替えられる。

---

## 比較表

| 形態 | 制御 | 映像取得 | プライバシー | WSL2相性 | 価格(JP 2026) | 工作の手間 |
|------|------|----------|--------------|----------|---------------|------------|
| **A. ESP32-CAM＋SG90×2 自作リグ**（推奨） | ESP32 が HTTP API（`/pan` `/tilt`）→ PWM | HTTP-MJPEG（`/stream`） | ◎ クラウド皆無・自作ファーム | ◎ HTTP のみ・USB不要 | ¥3,000〜4,000 | 中（はんだ・ファーム書込・組立 半日〜1日） |
| **B. USB webカメラ＋ESP32サーボ雲台** | サーボはESP32 HTTP、映像はPC側USB | USB UVC（PC直挿し） | ◎ ローカルのみ | △ **映像がUSB＝WSL2パススルー地雷**。Win側で取り別途LAN配信が要る | ¥4,000〜7,000 | 中〜大（映像経路が二重） |
| **C. Stack-chan（M5＋サーボ首振り）** | M5 ファーム（要カスタム HTTP 化） | M5Camera/Unit Cam（OV2640） | ◎ ローカル可 | ○ HTTP化すれば良好 | ¥18,000〜23,000（完成キット） | 小（既製キット）／HTTP API は要追加実装 |
| **D. 市販PTZ webカメラ（OBSBOT Tiny等）** | UVC拡張ユニット／専用アプリ／リモコン | USB UVC（RTSP無し） | ○ 撮影はローカル可だが**Linux用PTZ制御アプリ無し** | ✕ USB＋PTZ制御API実質欠如・WSL2地雷 | ¥25,000〜50,000 | 小（組立不要）だが**プログラム制御が困難** |

補足:
- **D の OBSBOT Tiny 2/3** は UVC デバイスとして映像はローカル取得でき、AIトラッキング等はオフライン動作する（クラウド必須ではない）。だが **Linux 用制御アプリが提供されず**、首振り（PTZ）をプログラムから叩く公式 API が事実上無い。リモコン/アプリ前提＝「ボットが向きを決める」要件に合わない。除外寄り。
- **C の Stack-chan** は完成度・かわいさは随一（水平360°/垂直90°のフィードバックサーボ2基）。ただしカメラ＋HTTP 制御 API は標準提供でなく、結局 A 相当のファームを M5 上に書くことになる。コスト5倍。「まず動かす」には過剰。

---

## 推奨構成の部品リスト（型番レベル）

| 部品 | 型番/仕様 | 概算(JP) | 備考 |
|------|-----------|----------|------|
| カメラ基板 | **ESP32-CAM（AI-Thinker, OV2640搭載）** | ¥1,000〜1,500 | Amazon.co.jp / AliExpress。技適は要確認（国内出荷の技適付きを推奨） |
| 書込アダプタ | **ESP32-CAM-MB**（USB-Serial 載せ替え基板） | ¥500〜800 | 初回ファーム書込用。無ければ FTDI でも可 |
| サーボ ×2 | **SG90**（または高トルクが要れば MG90S 金属ギア） | ¥300〜600（2個） | パン軸・チルト軸 |
| パンチルト架台 | SG90用 2軸ブラケット（樹脂/3Dプリント） | ¥400〜800 | 「pan tilt bracket SG90」。3Dプリント可（Printables にモデル多数） |
| 外部電源 | **5V/2A 以上 USB AC アダプタ**＋端子台/ブレッドボード | ¥500〜800 | **サーボはESP32の3.3Vから取らない**（後述） |
| コンデンサ | 電解 470〜1000µF（電源平滑） | ¥100 | サーボ起動時の電圧降下対策 |
| 配線・ピンヘッダ | ジャンパ線少々 | ¥200 | GND 共通化必須 |
| **概算合計** | | **¥3,000〜4,000** | 3Dプリント環境が無ければ架台を完成品で買って +¥500 程度 |

### 組み立て概要
1. ESP32-CAM に **ESP32-CAM-MB** を載せて PC（Windows側で可）から既存ファームを書込む。ベースは Random Nerd Tutorials の "ESP32-CAM Pan and Tilt" か GitHub `askew-etc/esp32-cam-webserver-servos` / `Shubhayu15/ESP32-CAM-PAN-TILT-WIFI-CAM`。
2. サーボ信号線を **GPIO 14（パン）/ GPIO 2（チルト）** など空き GPIO へ（カメラ DVP が多くのピンを占有するため割り当て注意。`ESP32Servo` ライブラリの LEDC PWM を使う）。
3. **サーボ電源は外部5Vから**取り、ESP32 と **GND だけ共通化**。電源ラインに 470〜1000µF を入れる。
4. Wi-Fi は固定 IP かルータの DHCP 予約で IP を固定。`http://<ip>/stream`（MJPEG）と `http://<ip>/control?pan=90&tilt=45` 等のエンドポイントを確認。
5. エバ側は新 actor / sensor として、(a) MJPEG から1フレーム取り出して画像チャンネルへ（受動の視覚）、(b) 首振りは HTTP GET で角度指定、を実装。`docs/ARCH-NEXT.md` の `image_feed` 系統に接続。

---

## リスク・落とし穴

- **WSL2 USB パススルー**: 本構成は HTTP のみで USB を使わないため回避。万一 USB webカメラ（案B/D）に寄せると、WSL2 への usbipd パススルーは UVC で不安定・地雷。LAN/HTTP を死守する。
- **サーボ電源**: ESP32-CAM の 3.3V/5V レギュレータからサーボを駆動すると、起動突入電流で **ブラウンアウト・カメラ初期化失敗（"Camera init failed" / リブートループ）** が頻発する。**外部5V＋GND共通＋平滑コンデンサ**が必須。最大の詰みポイント。
- **GPIO 競合**: OV2640 の DVP インターフェースが GPIO を多数専有。サーボ用に使える空きピンは限られる（GPIO 2/12/13/14/15 等を要確認。GPIO 0 はフラッシュ用で避ける）。
- **MJPEG の遅延と単一クライアント**: ESP32-CAM の MJPEG は数〜十数 fps・実質1クライアント。常時高fps監視ではなく「必要時に1フレーム取る（snapshot `/capture`）」運用が安定。受動の視覚（embedding 化してピクセルは捨てる）にはこれで十分。
- **技適**: 国内で常用するなら技適マーク付きの ESP32-CAM を選ぶ（Amazon.co.jp 国内発送品など）。
- **暗所/画質**: OV2640 は暗所に弱い。同定（recognition）の精度を将来上げるなら、サーボ架台はそのままにカメラを上位モジュール（OV5640 系や案Cの M5）へ差し替える拡張余地を残す設計にしておく。
- **Stack-chan への将来移行**: 「居る感じ・かわいさ」を重視したくなったら C へ。ただし制御 API は本構成の HTTP 設計を M5 に移植する形になるので、**先に A で HTTP インターフェースを固めておくと移行が楽**。

---

## 出典

- ESP32-CAM Pan and Tilt Video Streaming Web Server — Random Nerd Tutorials: https://randomnerdtutorials.com/esp32-cam-pan-and-tilt-2-axis/
- GitHub: askew-etc/esp32-cam-webserver-servos（webcam＋サーボ制御）: https://github.com/askew-etc/esp32-cam-webserver-servos
- GitHub: Shubhayu15/ESP32-CAM-PAN-TILT-WIFI-CAM（位置記憶付きパンチルト）: https://github.com/Shubhayu15/ESP32-CAM-PAN-TILT-WIFI-CAM
- DIY Pan Tilt Control Using Servos for ESP32 Cam — Instructables: https://www.instructables.com/DIY-Pan-Tilt-Control-Using-Servos-for-ESP32-Cam-Wi/
- Pan and Tilt Control for an ESP32-CAM — Robot Zero One: https://robotzero.one/pan-and-tilt-control-for-an-esp32-cam/
- ESP32 Cam Pan and Tilt Camera（3Dプリント架台）— Printables: https://printables.com/model/148269-esp32-cam-pan-and-tilt-camera/files
- ESP32-CAM Pinout/Specs（AI-Thinker, OV2640）— espboards.dev: https://www.espboards.dev/esp32/esp32cam/
- StackChan — M5Stack 公式ドキュメント: https://docs.m5stack.com/ja/StackChan
- スタックチャン製作記（買い物編・2026版）— note: https://note.com/ku_nel_5/n/n55f19e07362e
- M5Stack スタックチャン AI連携対応 — ITmedia: https://www.itmedia.co.jp/pcuser/articles/2605/08/news095.html
- OBSBOT Tiny 2 FAQ（オフライン/UVC/Linux対応）: https://www.obsbot.com/obsbot-tiny-2-4k-webcam/faq
- OBSBOT Tiny 3 4K PTZ Webcam Review — Yanko Design: https://www.yankodesign.com/2026/01/28/obsbot-tiny-3-4k-ptz-webcam-review-audio-as-a-first-class-citizen/
