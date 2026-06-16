# ImageBind 横断 embedding サービス

音/絵/文字を 1 つの共有空間（1024 次元）に埋め込む常駐サービス（CPU）。bot は HTTP で叩くだけで、
落ちていれば bot 側が `null` へ degrade する（横断 OFF と同じ＝今の nomic だけ挙動）。

設計: `docs/ARCH-NEXT.md`「横断 embedding の設計（dual-vector・実装手前）」。

## ビルド

```bash
docker build -t imagebind-service scripts/imagebind-service/
```

ピンは 2026-06-16 の実証値（torch2.1.2/torchvision0.16.2/numpy<2/timm0.9.16/py3.9）。

## 起動

checkpoint（4.5GB）はホストの `~/.cache/imagebind/` に置いて volume で持ち込む（再 DL を避ける）。

```bash
docker run -d --name imagebind \
  -p 8800:8800 \
  -v ~/.cache/imagebind:/app/.checkpoints \
  imagebind-service
```

起動時に checkpoint をロードする（~21s）。`GET /health` が `{"ok": true}` になれば準備完了。

## 有効化（bot 側）

`config/settings.json`:

```json
"crossmodal": { "enabled": true, "host": "http://localhost:8800" }
```

未設定 / `enabled:false` なら横断 OFF（既定）。

## API

```
POST /embed  { "modality": "text"|"vision"|"audio", "data": str }  -> { "vector": [..1024] }
```

- `text`: `data` = 生テキスト
- `vision`: `data` = 画像の base64（data URL 可）
- `audio`: `data` = 音声(wav 等)の base64

実測（Strix Halo・CPU）: text 137ms / audio 245ms / image 649ms（単発・median）。
