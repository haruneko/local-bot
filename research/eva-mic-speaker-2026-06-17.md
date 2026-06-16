# エバ 遠距離集音・スピーカー ハード選定レポート（2026-06-17）

## 推奨1案

**Raspberry Pi Zero 2 W ＋ ReSpeaker Mic Array v3.0（USB）＋ アクティブスピーカー を「LANサテライト」として組み、ボット本体とは音声ストリームを Wyoming プロトコル（TCP）で繋ぐ。**

理由3行:

1. WSL2のUSBパススルー地雷を完全回避できる。マイク/スピーカーはPi（素のLinux）に直挿しし、母艦のWSL2へは生PCMをTCPで届けるだけ。USBドライバ問題がアーキ上発生しない。
2. ReSpeaker v3.0 が XMOS XVF-3000 で**5m集音・ビームフォーミング・AEC（エコーキャンセル＝自分の声を聞き返さない）・ノイズ抑制をハード側で完結**するため、エバの声を鳴らしながら相手の声を拾える（バージイン可能）。集音DSPがクラウド非依存。
3. 音声は一切クラウドに出さない。ASR/TTSは母艦でローカル（faster-whisper / Piper等）に回し、サテライトは「マイクを送る・スピーカーを鳴らす」だけの薄い端末に徹する。プライバシー制約を構成レベルで満たす。

---

## 候補比較

### マイク

| 候補 | 集音距離・AEC | Linuxへの届け方 | プライバシー | WSL2相性 | 価格(日本) | 手間 |
|------|--------------|----------------|------------|---------|-----------|------|
| **ReSpeaker Mic Array v3.0**（旧v2.0・USB円盤型） | 〜5m / **AEC・BF・DoA・NSをハードで完結** | USB（Pi/ミニPCに挿す）→ TCP転送 | 完全ローカル | △直挿しは地雷 / **◎サテライト経由なら無関係** | 約¥11,545（スイッチサイエンス・在庫僅少） | 中（ドライバ不要・配線のみ） |
| **ReSpeaker 2-Mics Pi HAT V2.0** | 〜2-3m / AECはソフト側（snd_aloop構成）要設定 | Pi GPIO直結（HAT） | 完全ローカル | ◎（Pi上で完結） | 約¥2,327＋Pi | 中〜高（ドライバ再ビルド・AEC設定） |
| **PS3 Eye（PlayStation Eye）** | 〜2-3m / 4chマイク・AECなし | USB（UVC音声・Linux標準認識） | 完全ローカル | △直挿し地雷 | 中古¥1,000前後（入手難・球数減） | 中（安いがBF/AEC自前） |
| **ESP32-S3-BOX-3**（一体型サテライト） | 数m / ESP-SR（on-deviceウェイクワード）・AECは簡易 | **Wi-Fi（Wyoming/microWakeWord）** | 完全ローカル | ◎（USB不要・LANのみ） | 約¥4,500〜6,000（$31〜・並行輸入） | 低〜中（HA前提の作りで自前統合に難） |
| 会議用USBマイク（Jabra Speak等） | 〜2m / AEC内蔵だが**TTS出力経路が固定**で自前TTSに不向き | USB | ローカル | △直挿し地雷 | ¥1.5万〜 | 低（が拡張性低） |

### スピーカー

| 候補 | 部屋に通る音量 | TTSの鳴らし方 | 遅延 | プライバシー | 価格 |
|------|--------------|--------------|------|------------|------|
| **アクティブ3.5mm/USBスピーカー**（Pi/ReSpeakerの出力に直結） | 中〜大（選定次第） | サテライトで `aplay` 再生・Wyoming `snd` 経由 | 低（LAN内・数十ms） | ローカル | ¥2,000〜5,000 |
| Bluetoothスピーカー | 大 | Piとペアリング→a2dp | **中〜大（BTバッファで遅延・AEC悪化）** | ローカル | ¥3,000〜 |
| ネットワークスピーカー（Snapcast等） | 大・多部屋同期 | Snapserver→Snapclient | 中（同期は得意） | ローカル | クライアント別 |

→ **AECを効かせるならマイクとスピーカーは同じサテライト上で有線**が鉄則（Bluetoothはバッファ遅延でエコーキャンセルが破綻しやすい）。

---

## 本命：分散サテライト構成（具体評価）

### 構成図（説明）

```
[リビング]                                    [母艦 = Windows + WSL2]
 Raspberry Pi Zero 2 W                          Ollama (Windowsホスト側)
   ├─ ReSpeaker v3.0 (USB)  ──集音/AEC/BF──┐    ┌─ エバ本体 (WSL2/Node)
   └─ アクティブSP (3.5mm)  ←─再生──────┐  │    │   ├─ ASR: faster-whisper (ローカル)
                                        │  │    │   └─ TTS: Piper (ローカル)
   wyoming-satellite (Pi上)             │  └─TCP→ Wyoming サーバ受け口
     ・mic → 16kHz S16LE raw を TCP送信 ─┘  10700 (生PCMのみ・音声はLAN内に留まる)
     ・snd ← TTS PCM を受けて aplay 再生 ←────────┘
```

ポイント: サテライトは「耳と口」だけの薄い端末。**判断・ASR・TTSはすべて母艦**。エバの認知パイプライン（preprocess→actor pool→language-agent）には、音声入力をテキスト化したものを `user_message` として、TTS出力を発話チャンネルとして繋ぐ。`docs/ARCH-NEXT.md` の「リビング会話トラック（口/耳）」の物理層がこれに当たる。

### 部品リスト（型番レベル）と概算費用

| 部品 | 型番 | 概算(円) |
|------|------|---------|
| サテライト本体 | Raspberry Pi Zero 2 W | ¥2,500 |
| microSD 32GB | （任意） | ¥800 |
| 電源 5V/2.5A USB | （Pi Zero用） | ¥1,200 |
| 遠距離マイク | ReSpeaker Mic Array v3.0（USB） | ¥11,545 |
| スピーカー | アクティブ3.5mm小型SP（USB給電） | ¥3,000 |
| ケース/配線 | — | ¥1,000 |
| **合計** | | **約¥20,000** |

> 廉価版（〜¥8,000）: Pi Zero 2 W ＋ **ReSpeaker 2-Mics Pi HAT V2.0（¥2,327）** ＋ 小型SP。HATはGPIO直結でUSBすら使わず、AECはソフト（snd_aloop）構成。集音距離は2-3mに落ちるが、まず動かして検証する初手として最安・WSL2無関係で堅い。

### ソフト面

- Pi に **wyoming-satellite**（rhasspy）を導入。`script/run --mic-command 'arecord -r 16000 -c 1 -f S16_LE -t raw' --snd-command 'aplay -r 22050 -c 1 -f S16_LE -t raw'` の形で耳と口が立つ。
- 母艦側は Home Assistant を立てず、**Wyoming は素のTCPプロトコル**（JSONイベント＋PCM）なので、Node/Pythonで受け口を自前実装してエバの `say` 入口に橋渡しできる（Wyoming は Python/Go実装あり・依存は薄い）。

---

## リスク・落とし穴

- **WSL2 USBパススルー（usbipd）**: 不安定で音声デバイスは特に相性が悪い。→ 本構成は**USBを母艦に挿さない**ことで根本回避。ここが設計の肝。
- **AEC（エコーキャンセル）**: 自分のTTS音をマイクが拾い続けると会話が破綻する。ReSpeaker v3.0はハードAEC内蔵で有利。HAT/PS3 Eyeはソフトで `snd_aloop` のループバック参照を組む必要があり設定が重い。**スピーカーとマイクは同一サテライトで有線**にしないとAEC参照がずれる。
- **遅延**: LAN内のPCMストリームは数十ms。Bluetoothスピーカーはバッファで100ms以上載りやすく、会話の間（ま）とAECを悪化させる→**有線SP推奨**。
- **同期/ストリーミング**: 16kHz/モノ/S16LE で固定し、母艦ASRと取り決める。複数部屋に増やす場合もPi4一台で5サテライトまで捌けた実績あり（将来拡張余地）。
- **電源**: Pi Zero 2 W ＋ USBマイク ＋ スピーカーは瞬間電流が伸びる。**5V/2.5A以上**の電源を使い、スピーカーは別給電が安全（電圧降下でマイクのノイズ・リブートを防ぐ）。
- **入手性**: ReSpeaker v3.0 は国内代理店（スイッチサイエンス）で在庫僅少（調査時3個）。早めに確保。ESP32-S3-BOX-3は安いがHome Assistant前提の作りで、エバへ自前統合する際はファーム改修コストがある（初手では非推奨）。

---

## 出典URL

- ReSpeaker Mic Array v3.0（スイッチサイエンス・価格/在庫）: https://www.switch-science.com/products/3851
- ReSpeaker 2-Mics Pi HAT V2.0（スイッチサイエンス）: https://www.switch-science.com/products/3931
- ReSpeaker USB 4-Mic Array v2.0 仕様（Seeed Wiki・5m集音/AEC/BF）: https://wiki.seeedstudio.com/ReSpeaker_Mic_Array_v2.0/
- respeaker/usb_4_mic_array（VAD/DOA/AEC/BF・GitHub）: https://github.com/respeaker/usb_4_mic_array
- wyoming-satellite（rhasspy・GitHub）: https://github.com/rhasspy/wyoming-satellite
- wyoming-satellite 2mic チュートリアル: https://github.com/rhasspy/wyoming-satellite/blob/master/docs/tutorial_2mic.md
- ReSpeaker HAT Setup（DeepWiki）: https://deepwiki.com/rhasspy/wyoming-satellite/6.2-respeaker-hat-setup
- Wyoming プロトコル仕様（OHF-Voice）: https://github.com/OHF-Voice/wyoming
- ESP32-S3-BOX-3 voice assistant（Home Assistant）: https://www.home-assistant.io/voice_control/s3_box_voice_assistant/
- ESP32-S3-BOX-3（Mouser・製品/価格）: https://www.mouser.com/ProductDetail/Espressif-Systems/ESP32-S3-BOX-3
- Best Home Assistant Voice Satellites 2026（サテライト比較・ESP32 $8-15/部屋）: https://www.smarthomeexplorer.com/guides/best-home-assistant-voice-satellite-2026
- Self-hosted local voice with LLM 2026: https://botmonster.com/smart-home/build-private-local-ai-voice-assistant-2026/
