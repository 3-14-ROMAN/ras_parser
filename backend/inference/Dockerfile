# Inference image for backend/inference/app.py — jina-embeddings-v4 (+ LoRA
# adapters, sparse, late-chunk) and jina-reranker-v3, served by uvicorn on :8000.
# Mirrors the production systemd venv (ras-inference.service): the exact pinned
# stack in requirements.txt (torch 2.7.1+cu118 + xformers + transformers 4.57.1).
#
# Base = python:3.12-slim, NOT nvidia/cuda. The cu118 torch wheels bundle their
# own CUDA 11.8 runtime (the nvidia-*-cu11 packages in requirements.txt), and the
# NVIDIA Container Toolkit injects the host driver at run time (`--gpus all` /
# compose `runtime: nvidia`). So no system CUDA is needed and the build no longer
# depends on the NVIDIA apt repo — it only talks to Debian, PyPI and
# download.pytorch.org. Python 3.12 matches the frozen requirements.txt.
FROM python:3.12-slim

# System libs the wheels dlopen at run time:
#   libgomp1   — OpenMP runtime for torch / onnxruntime
#   libsndfile1 — soundfile (used by transcribe_worker.py)
#   curl        — container HEALTHCHECK probe
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgomp1 \
      libsndfile1 \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# NVIDIA_* make a non-cuda base GPU-visible under the Container Toolkit.
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/data/hf_cache \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility

WORKDIR /app

# Deps first so editing app.py doesn't bust the heavy pip layer.
# torch / torchvision / xformers ==+cu118 resolve from the pytorch index.
COPY requirements.txt .
RUN pip install --upgrade pip setuptools wheel \
 && pip install --extra-index-url https://download.pytorch.org/whl/cu118 \
      -r requirements.txt

# app.py               = embed + reranker server (this image's CMD, :8000)
# transcribe_worker.py = whisper STT worker (:8001), runnable from the same image
#                        via `uvicorn transcribe_worker:app` (needs a model mount).
COPY app.py transcribe_worker.py ./

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
