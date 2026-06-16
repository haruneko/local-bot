"""ImageBind 横断 embedding の常駐サービス（CPU）。

POST /embed  { "modality": "text"|"vision"|"audio", "data": str }
  - text  : data = 生テキスト
  - vision: data = 画像の base64（data URL でも素の base64 でも可）
  - audio : data = 音声(wav/mp3 等)の base64
  → { "vector": [..1024] }

3 モダリティとも同じ 1024 次元の共有空間（横断）。モデルは起動時に 1 回ロード（~21s）。
"""
import base64
import os
import tempfile

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from imagebind import data as ib_data
from imagebind.models import imagebind_model
from imagebind.models.imagebind_model import ModalityType

DEVICE = "cpu"

app = FastAPI(title="imagebind-xmodal")
_model = None


def get_model():
    global _model
    if _model is None:
        m = imagebind_model.imagebind_huge(pretrained=True)
        m.eval().to(DEVICE)
        _model = m
    return _model


@app.on_event("startup")
def _warm():
    # 4.5GB checkpoint のロードを起動時に済ませる（最初のリクエストを待たせない）。
    get_model()


@app.get("/health")
def health():
    return {"ok": _model is not None}


class EmbedReq(BaseModel):
    modality: str
    data: str


def _b64_to_tempfile(b64: str, suffix: str) -> str:
    if b64.startswith("data:"):
        comma = b64.find(",")
        if comma >= 0:
            b64 = b64[comma + 1 :]
    raw = base64.b64decode(b64)
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(raw)
    return path


@app.post("/embed")
def embed(req: EmbedReq):
    model = get_model()
    mod = req.modality.lower()
    tmp = None
    try:
        if mod == "text":
            inputs = {ModalityType.TEXT: ib_data.load_and_transform_text([req.data], DEVICE)}
            key = ModalityType.TEXT
        elif mod in ("vision", "image"):
            tmp = _b64_to_tempfile(req.data, ".jpg")
            inputs = {ModalityType.VISION: ib_data.load_and_transform_vision_data([tmp], DEVICE)}
            key = ModalityType.VISION
        elif mod == "audio":
            tmp = _b64_to_tempfile(req.data, ".wav")
            inputs = {ModalityType.AUDIO: ib_data.load_and_transform_audio_data([tmp], DEVICE)}
            key = ModalityType.AUDIO
        else:
            raise HTTPException(status_code=400, detail=f"unknown modality: {req.modality}")

        with torch.no_grad():
            emb = model(inputs)
        # L2 正規化して返す＝横断空間の L2 距離を [0,2] の regime に揃える
        # （bot 側の横断グラデーション閾値の前提・distance.ts）。
        v = torch.nn.functional.normalize(emb[key][0], dim=-1)
        return {"vector": v.tolist()}
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)
