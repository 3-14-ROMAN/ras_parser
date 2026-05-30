"""
Whisper STT worker — antony66/whisper-large-v3-russian.

Отдельный процесс от inference/app.py (Jina embed + reranker).
Не конкурирует за MODEL_LOCK, собственный CUDA lifecycle.

Lifecycle:
  1. Startup: model + processor  -> CPU RAM  (~3 GB, ~2 сек).
  2. Startup: CUDA context warmup + dummy forward cycle
     (model -> GPU -> generate(1 token) -> model -> CPU).
     Это прогревает CUDA driver, JIT-компилирует все Whisper-ядра
     и кеширует их в CUDA context. Кеш живёт до конца процесса,
     даже когда модель уходит обратно на CPU.
  3. На каждый /transcribe:
     a. Параллельно: ffmpeg decode audio  ||  model.to("cuda")
     b. Dummy forward (1 token) — страховка что ядра warm.
     c. Реальный generate.
     d. model.to("cpu") + empty_cache() — VRAM свободна.

Env:
  RAS_WHISPER_MODEL_PATH   путь к модели (default models/whisper-large-v3-russian)
  RAS_WHISPER_PORT         порт (default 8001)

Запуск:
  cd inference && ../inference/venv/bin/python -m uvicorn transcribe_worker:app --host 0.0.0.0 --port 8001
"""

import base64
import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Whisper STT Worker")

# ── Config ────────────────────────────────────────────────────────────────────

WHISPER_MODEL_PATH = os.environ.get(
    "RAS_WHISPER_MODEL_PATH",
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..",
        "models",
        "whisper-large-v3-russian",
    ),
)
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# ── Anti-hallucination ────────────────────────────────────────────────────────
# Whisper на тишине/шуме галлюцинирует связный текст ("Спасибо за просмотр",
# "Я не могу сказать, что я не могу сказать..." и т.п.). Две линии защиты:
#   1. Energy-gate: если RMS аудио ниже порога — речи нет, не гоняем модель.
#   2. Text-filter: режем повторяющиеся петли и известные фразы-галлюцинации.
# Пороги в нормализованном float32 [-1, 1]: речь RMS ~0.02-0.15, тихая комната
# RMS ~0.001-0.005. Дефолт 0.006 ловит "ничего не сказал", не режет тихую речь.
SILENCE_RMS = float(os.environ.get("RAS_WHISPER_SILENCE_RMS", "0.006"))
SILENCE_PEAK = float(os.environ.get("RAS_WHISPER_SILENCE_PEAK", "0.02"))

# Нормализованные подстроки типовых галлюцинаций Whisper на тишине (RU/служебные).
_HALLUCINATION_SUBSTRINGS = (
    "субтитры",
    "субтитр",
    "редактор субтитров",
    "корректор",
    "amara.org",
    "продолжение следует",
    "спасибо за просмотр",
    "спасибо за внимание",
    "подписывайтесь на канал",
    "ставьте лайк",
    "до новых встреч",
)


def _normalize_for_filter(text: str) -> str:
    return "".join(ch.lower() if ch.isalnum() or ch.isspace() else " " for ch in text)


def _looks_hallucinated(text: str) -> bool:
    """Эвристика галлюцинации: пусто / петля-повтор / типовая фраза-заглушка."""
    norm = _normalize_for_filter(text).strip()
    if not norm:
        return True
    for sub in _HALLUCINATION_SUBSTRINGS:
        if sub in norm:
            return True
    words = norm.split()
    # Петля ("я не могу сказать, что я не могу сказать ..."): мало уникальных слов.
    if len(words) >= 6:
        unique_ratio = len(set(words)) / len(words)
        if unique_ratio < 0.35:
            return True
    return False


# ── State ─────────────────────────────────────────────────────────────────────

whisper_model = None
whisper_processor = None
_warmup_features = None  # pre-computed mel для dummy forward (1 сек тишины)
_lock = threading.Lock()  # serialize /transcribe (model.to() не реентрантен)
_pool = ThreadPoolExecutor(max_workers=2)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _cuda_mem():
    if not torch.cuda.is_available():
        return {}
    alloc = torch.cuda.memory_allocated() / 1024**3
    free, total = torch.cuda.mem_get_info()
    return {
        "allocated_gb": round(alloc, 2),
        "free_gb": round(free / 1024**3, 2),
        "total_gb": round(total / 1024**3, 2),
    }


def _decode_audio(audio_bytes: bytes) -> np.ndarray:
    """Любой аудиоформат (OGG/Opus, MP3, WAV, M4A) -> 16 kHz mono float32."""
    proc = subprocess.run(
        [
            "ffmpeg",
            "-i", "pipe:0",
            "-f", "f32le",
            "-acodec", "pcm_f32le",
            "-ac", "1",
            "-ar", "16000",
            "-loglevel", "error",
            "pipe:1",
        ],
        input=audio_bytes,
        capture_output=True,
        timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg rc={proc.returncode}: "
            f"{proc.stderr.decode(errors='replace')[:500]}"
        )
    arr = np.frombuffer(proc.stdout, dtype=np.float32)
    if len(arr) == 0:
        raise RuntimeError("ffmpeg: empty output")
    return arr


# ── Startup: Step 1 — model -> CPU RAM ────────────────────────────────────────


def _load_model_to_cpu():
    global whisper_model, whisper_processor, _warmup_features

    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    t0 = time.perf_counter()
    print(f"[whisper/startup] loading {WHISPER_MODEL_PATH} to CPU RAM ...", flush=True)

    whisper_processor = WhisperProcessor.from_pretrained(WHISPER_MODEL_PATH)
    whisper_model = WhisperForConditionalGeneration.from_pretrained(
        WHISPER_MODEL_PATH,
        dtype=torch.float16,
        low_cpu_mem_usage=True,
    )
    whisper_model.eval()

    # Pre-compute warmup mel (1 сек тишины). Остаётся на CPU,
    # при dummy forward копируется на GPU.
    silence = np.zeros(16000, dtype=np.float32)
    _warmup_features = whisper_processor(
        silence, sampling_rate=16000, return_tensors="pt"
    ).input_features  # [1, 128, 3000] on CPU

    gc = whisper_model.generation_config
    n_params = sum(p.numel() for p in whisper_model.parameters()) / 1e6
    ms = int((time.perf_counter() - t0) * 1000)
    print(
        f"[whisper/startup] CPU RAM ready in {ms}ms — "
        f"{n_params:.0f}M params fp16, "
        f"language={gc.language} task={gc.task}",
        flush=True,
    )


# ── Startup: Step 2 — CUDA context warmup + full kernel warmup cycle ──────────


def _cuda_warmup_cycle():
    """CUDA context init + полный model->GPU->dummy_forward->model->CPU цикл.

    После этого все CUDA-ядра Whisper скомпилированы и закешированы
    в CUDA context. Кеш переживает model.to("cpu") — при следующем
    model.to("cuda") + generate ядра уже warm.
    """
    if DEVICE != "cuda":
        print("[whisper/startup] no CUDA, skipping warmup", flush=True)
        return

    t0 = time.perf_counter()

    # 2a. CUDA driver init
    _tmp = torch.zeros(1, device="cuda", dtype=torch.float16)
    del _tmp
    t_ctx = time.perf_counter()

    # 2b. Model -> GPU
    whisper_model.to(DEVICE)
    t_togpu = time.perf_counter()

    # 2c. Dummy forward — компилирует все ядра encoder + decoder
    feats = _warmup_features.to(DEVICE, dtype=torch.float16)
    with torch.inference_mode():
        whisper_model.generate(
            feats, language="russian", task="transcribe", max_new_tokens=1
        )
    torch.cuda.synchronize()
    t_fwd = time.perf_counter()

    # 2d. Model -> CPU, free VRAM
    whisper_model.to("cpu")
    torch.cuda.empty_cache()
    t_end = time.perf_counter()

    print(
        f"[whisper/startup] CUDA warmup cycle done in {(t_end - t0)*1000:.0f}ms — "
        f"ctx_init={( t_ctx - t0)*1000:.0f}ms "
        f"to_gpu={(t_togpu - t_ctx)*1000:.0f}ms "
        f"dummy_fwd={(t_fwd - t_togpu)*1000:.0f}ms "
        f"to_cpu={(t_end - t_fwd)*1000:.0f}ms "
        f"vram_after={_cuda_mem().get('allocated_gb', 0)}gb",
        flush=True,
    )


# ── Per-request helpers ───────────────────────────────────────────────────────


def _move_to_gpu():
    """model.to("cuda"). Блокирующий, вызывается из ThreadPoolExecutor."""
    t0 = time.perf_counter()
    whisper_model.to(DEVICE)
    ms = (time.perf_counter() - t0) * 1000
    print(f"[whisper/gpu] CPU->CUDA {ms:.0f}ms  vram={_cuda_mem().get('allocated_gb', 0)}gb", flush=True)


def _dummy_forward():
    """1-token generate на тишине. С прогретым кешем ядер: ~50-80ms."""
    t0 = time.perf_counter()
    feats = _warmup_features.to(DEVICE, dtype=torch.float16)
    with torch.inference_mode():
        whisper_model.generate(
            feats, language="russian", task="transcribe", max_new_tokens=1
        )
    if DEVICE == "cuda":
        torch.cuda.synchronize()
    ms = (time.perf_counter() - t0) * 1000
    print(f"[whisper/warmup] dummy forward {ms:.0f}ms", flush=True)


def _offload_to_cpu():
    """model -> CPU, free VRAM."""
    t0 = time.perf_counter()
    whisper_model.to("cpu")
    if DEVICE == "cuda":
        torch.cuda.empty_cache()
    ms = (time.perf_counter() - t0) * 1000
    print(f"[whisper/cpu] CUDA->CPU {ms:.0f}ms  vram={_cuda_mem().get('allocated_gb', 0)}gb", flush=True)


# ── Endpoint ──────────────────────────────────────────────────────────────────


class TranscribeReq(BaseModel):
    # base64-encoded audio (OGG/Opus, MP3, WAV — любой ffmpeg-формат)
    audio_base64: str
    language: str = "russian"


@app.post("/transcribe")
def transcribe(req: TranscribeReq):
    """STT: audio -> text.

    Весь GPU-цикл внутри _lock: model.to(cuda) -> dummy -> generate -> model.to(cpu).
    Между запросами VRAM свободна.
    """
    t0_total = time.perf_counter()

    # ── Validate ──────────────────────────────────────────────────────────
    try:
        audio_bytes = base64.b64decode(req.audio_base64)
    except Exception as e:
        raise HTTPException(400, f"bad base64: {e}")
    if len(audio_bytes) < 100:
        raise HTTPException(400, "audio too short (< 100 bytes)")

    # ── Lock: один /transcribe за раз (model.to не реентрантен) ───────────
    with _lock:

        # Step 4: PARALLEL — ffmpeg decode || model.to("cuda")
        audio_fut = _pool.submit(_decode_audio, audio_bytes)
        gpu_fut = _pool.submit(_move_to_gpu)

        # Ждём GPU transfer (обычно дольше ffmpeg)
        gpu_fut.result()

        # Step 5: dummy forward (ядра уже в кеше -> ~50-80ms)
        _dummy_forward()

        # Ждём audio decode (обычно уже готов к этому моменту)
        try:
            audio_np = audio_fut.result()
        except Exception as e:
            _offload_to_cpu()
            raise HTTPException(400, f"audio decode failed: {e}")

        duration_sec = len(audio_np) / 16000.0
        if duration_sec > 120.0:
            _offload_to_cpu()
            raise HTTPException(400, f"audio too long ({duration_sec:.0f}s > 120s)")

        # ── Energy-gate: тишина → речи нет, модель не гоняем (иначе галлюцинирует).
        peak = float(np.max(np.abs(audio_np))) if audio_np.size else 0.0
        rms = float(np.sqrt(np.mean(np.square(audio_np)))) if audio_np.size else 0.0
        print(
            f"[whisper/req] bytes={len(audio_bytes)} duration={duration_sec:.1f}s "
            f"rms={rms:.5f} peak={peak:.4f}",
            flush=True,
        )
        if rms < SILENCE_RMS and peak < SILENCE_PEAK:
            _offload_to_cpu()
            elapsed_ms = int((time.perf_counter() - t0_total) * 1000)
            print(
                f"[whisper/done] no_speech (silence) rms={rms:.5f} peak={peak:.4f} "
                f"duration={duration_sec:.1f}s total_ms={elapsed_ms}",
                flush=True,
            )
            return {
                "text": "",
                "no_speech": True,
                "reason": "silence",
                "language": req.language,
                "duration_sec": round(duration_sec, 2),
                "elapsed_ms": elapsed_ms,
                "generate_ms": 0,
            }

        # ── Mel spectrogram + generate ────────────────────────────────────
        try:
            input_features = whisper_processor(
                audio_np, sampling_rate=16000, return_tensors="pt"
            ).input_features.to(DEVICE, dtype=torch.float16)

            t0_gen = time.perf_counter()
            with torch.inference_mode():
                predicted_ids = whisper_model.generate(
                    input_features,
                    language=req.language,
                    task="transcribe",
                    max_new_tokens=440,
                )
            if DEVICE == "cuda":
                torch.cuda.synchronize()
            gen_ms = (time.perf_counter() - t0_gen) * 1000

            text = whisper_processor.batch_decode(
                predicted_ids, skip_special_tokens=True
            )[0].strip()

        finally:
            # Step 6: ВСЕГДА освобождаем VRAM
            _offload_to_cpu()

    # ── Text-filter: петля-повтор / типовая фраза-галлюцинация → пусто. ───────
    no_speech = False
    if _looks_hallucinated(text):
        no_speech = True
        print(f"[whisper/filter] dropped hallucination text={text!r:.120}", flush=True)
        text = ""

    elapsed_ms = int((time.perf_counter() - t0_total) * 1000)
    print(
        f"[whisper/done] text={text!r:.120} len={len(text)} no_speech={no_speech} "
        f"duration={duration_sec:.1f}s gen_ms={gen_ms:.0f} total_ms={elapsed_ms}",
        flush=True,
    )

    return {
        "text": text,
        "no_speech": no_speech,
        "language": req.language,
        "duration_sec": round(duration_sec, 2),
        "elapsed_ms": elapsed_ms,
        "generate_ms": int(gen_ms),
    }


# ── Health ────────────────────────────────────────────────────────────────────


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model_loaded": whisper_model is not None,
        "model_path": WHISPER_MODEL_PATH,
        "device": DEVICE,
        "cuda_memory": _cuda_mem(),
    }


# ── Startup sequence ─────────────────────────────────────────────────────────

_load_model_to_cpu()    # Step 1: model -> CPU RAM
_cuda_warmup_cycle()    # Step 2: CUDA ctx + dummy forward cycle, then back to CPU
