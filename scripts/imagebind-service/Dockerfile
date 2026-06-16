# 横断 embedding（音/絵/文字を 1 空間）の常駐サービス＝ImageBind on CPU。
# bot は HTTP で叩くだけ（src/embedding/xmodal.ts）。落ちてたら bot 側が null へ degrade。
# ピンは 2026-06-16 の実証値（memory project-crossmodal-embedding）:
#   torch2.1.2/torchvision0.16.2 が transforms.functional_tensor を持つ最後の世代、
#   numpy<2、timm0.9.16(timm.layers)、py3.9。
FROM python:3.9-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --no-cache-dir \
    torch==2.1.2 torchvision==0.16.2 torchaudio==2.1.2 \
    --index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir \
    "numpy==1.26.4" \
    timm==0.9.16 ftfy regex einops fvcore decord==0.6.0 \
    soundfile librosa pillow \
    fastapi "uvicorn[standard]"

RUN pip install --no-cache-dir \
    "pytorchvideo @ git+https://github.com/facebookresearch/pytorchvideo.git@28fe037d212663c6a24f373b94cc5d478c8c1a1d"

RUN pip install --no-cache-dir --no-deps \
    "git+https://github.com/facebookresearch/ImageBind.git"

COPY app.py /app/app.py

# checkpoint(4.5GB) は volume で持ち込む（再 DL を避ける）:
#   -v ~/.cache/imagebind:/app/.checkpoints
EXPOSE 8800
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8800"]
