import base64
import os
import subprocess
import threading
import time
from collections import Counter
from contextlib import contextmanager
from typing import List, Optional

import numpy as np
import torch
import torch.nn.functional as F
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import AutoModel, AutoTokenizer


app = FastAPI()

# ─────────────────────────────────────────────────────────────────────────────
# MODEL_LOCK — глобальная сериализация доступа к моделям и их tokenizer'ам.
#
# Зачем: HuggingFace fast-tokenizer'ы (PyO3-обёртка над Rust) держат внутри
# RefCell-like state. Параллельные вызовы одного tokenizer.__call__() с разных
# threadpool'овых потоков (FastAPI запускает sync-handlers в anyio threadpool
# с дефолтом ~40 worker'ов) кидают `RuntimeError: Already borrowed`.
# Аналогично у jina-reranker-v3: .rerank() и одновременный .tokenizer(...) из
# /count_tokens или /embed-пути дерутся за один и тот же объект.
#
# Решение: один re-entrant lock на ВСЕ endpoint'ы, которые трогают модели или
# их tokenizer'ы. RLock (а не Lock), чтобы вложенные вызовы внутри одного
# request'а не self-deadlock'нулись, если в будущем кто-то закроет sub-helper
# тем же контекстом.
#
# Стоимость: запросы к /embed, /embed_late_chunks, /rerank, /count_tokens
# становятся строго последовательными. Это ОК — GPU у нас один, рабочая модель
# одна, параллельность тут давала только bug, а не throughput.
# ─────────────────────────────────────────────────────────────────────────────
MODEL_LOCK = threading.RLock()

# Если запрос ждал lock дольше этого порога (мс) — лог с тегом и временем.
# Не спамим: успешный 0-мс-acquire ничего не пишет.
_LOCK_LOG_WAIT_MS = float(os.environ.get("INFERENCE_LOCK_LOG_WAIT_MS", "50"))


@contextmanager
def model_guard(tag: str):
    """Сериализующий guard вокруг тяжёлых model/tokenizer-операций.

    Логирует только если acquire ждал больше _LOCK_LOG_WAIT_MS — это и есть
    сигнал, что endpoint выполнялся последовательно за другим, а не свободно.
    """
    t0 = time.perf_counter()
    MODEL_LOCK.acquire()
    waited_ms = (time.perf_counter() - t0) * 1000.0
    try:
        if waited_ms >= _LOCK_LOG_WAIT_MS:
            print(
                f"[model_lock] tag={tag} waited_ms={waited_ms:.0f}",
                flush=True,
            )
        yield
    finally:
        MODEL_LOCK.release()

device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.float16 if device == "cuda" else torch.float32

XFORMERS_ENABLED = False
XFORMERS_STATS = {
    "sdpa_calls": 0,
    "xformers_calls": 0,
    "fallback_calls": 0,
    "gqa_expanded_calls": 0,
}


def install_xformers_sdpa_patch():
    global XFORMERS_ENABLED

    if device != "cuda":
        print("[xformers] CUDA недоступна, patch отключен.", flush=True)
        return

    try:
        from xformers.ops import memory_efficient_attention, LowerTriangularMask
    except Exception as e:
        print(f"[xformers] import failed, patch disabled: {repr(e)}", flush=True)
        return

    original_sdpa = F.scaled_dot_product_attention

    def xformers_sdpa(
        query,
        key,
        value,
        attn_mask=None,
        dropout_p=0.0,
        is_causal=False,
        scale=None,
        enable_gqa=False,
    ):
        XFORMERS_STATS["sdpa_calls"] += 1

        try:
            if enable_gqa:
                # GQA: key/value имеют меньше heads, чем query (jina-reranker-v3:
                # q_heads=16, kv_heads=8 → ratio=2). xFormers
                # memory_efficient_attention требует одинаковое число heads,
                # поэтому расширяем K/V через repeat_interleave по head-dim.
                # Layout пока PyTorch SDPA: [B, H, T, D] → dim=1.
                q_heads = query.shape[1]
                kv_heads = key.shape[1]

                if q_heads != kv_heads:
                    if q_heads % kv_heads != 0:
                        raise RuntimeError(
                            f"bad GQA heads: q={q_heads} kv={kv_heads}"
                        )

                    repeat = q_heads // kv_heads
                    key = key.repeat_interleave(repeat, dim=1)
                    value = value.repeat_interleave(repeat, dim=1)
                    XFORMERS_STATS["gqa_expanded_calls"] += 1

            # PyTorch SDPA: [B, H, T, D]
            # xFormers:    [B, T, H, D]
            q = query.transpose(1, 2).contiguous().to(torch.float16)
            k = key.transpose(1, 2).contiguous().to(torch.float16)
            v = value.transpose(1, 2).contiguous().to(torch.float16)

            attn_bias = LowerTriangularMask() if is_causal else attn_mask

            # xFormers expects tensor attn_bias as [B, H, T, S].
            # On V100/cutlass, attn_bias.stride(-2) must be divisible by 8.
            # If S is not aligned, keep padded storage and slice back to original shape.
            if (
                (not is_causal)
                and torch.is_tensor(attn_bias)
                and attn_bias.ndim == 4
            ):
                s_len = attn_bias.shape[-1]

                if s_len % 8 != 0:
                    s_pad = ((s_len + 7) // 8) * 8
                    padded = attn_bias.new_empty(
                        attn_bias.shape[0],
                        attn_bias.shape[1],
                        attn_bias.shape[2],
                        s_pad,
                    )
                    padded[..., :s_len] = attn_bias
                    padded[..., s_len:] = 0
                    attn_bias = padded[..., :s_len]

                if (
                    attn_bias.shape[1] == 1
                    and q.ndim == 4
                    and q.shape[2] > 1
                ):
                    attn_bias = attn_bias.expand(
                        attn_bias.shape[0],
                        q.shape[2],
                        attn_bias.shape[2],
                        attn_bias.shape[3],
                    )

            out = memory_efficient_attention(
                q,
                k,
                v,
                attn_bias=attn_bias,
                p=dropout_p,
                scale=scale,
            )

            XFORMERS_STATS["xformers_calls"] += 1

            return out.transpose(1, 2).contiguous().to(query.dtype)

        except Exception as e:
            XFORMERS_STATS["fallback_calls"] += 1

            if XFORMERS_STATS["fallback_calls"] <= 3:
                print(f"[xformers] fallback to SDPA: {repr(e)}", flush=True)

            return original_sdpa(
                query,
                key,
                value,
                attn_mask=attn_mask,
                dropout_p=dropout_p,
                is_causal=is_causal,
                scale=scale,
                enable_gqa=enable_gqa,
            )

    F.scaled_dot_product_attention = xformers_sdpa
    XFORMERS_ENABLED = True

    print("[xformers] SDPA monkeypatch installed.", flush=True)


install_xformers_sdpa_patch()

# ─────────────────────────────────────────────────────────────────────────────
# Embedding model lifecycle.
#
# Цель: перед /rerank уметь выгружать jina-embeddings-v4 из VRAM
# (CPU-offload, без потери весов), а после следующего /embed* — lazy-вернуть
# обратно на GPU. Reranker остаётся всё время на GPU.
#
# Env:
#   RAS_UNLOAD_EMBEDDING_BEFORE_RERANK=1  включить outload перед /rerank (default off)
#   RAS_MODEL_OFFLOAD_MODE=cpu|unload     cpu = .to("cpu") (быстрый reload),
#                                          unload = del embed_model (полный free)
#
# State:
#   embed_model_device_state ∈ {"gpu", "cpu", "unloaded"}
# ─────────────────────────────────────────────────────────────────────────────

UNLOAD_BEFORE_RERANK = os.environ.get(
    "RAS_UNLOAD_EMBEDDING_BEFORE_RERANK", "0"
) == "1"
OFFLOAD_MODE = os.environ.get("RAS_MODEL_OFFLOAD_MODE", "cpu").lower()
if OFFLOAD_MODE not in ("cpu", "unload"):
    print(
        f"[model_lifecycle] RAS_MODEL_OFFLOAD_MODE={OFFLOAD_MODE!r} not in (cpu|unload), "
        f"fallback to 'cpu'",
        flush=True,
    )
    OFFLOAD_MODE = "cpu"

embed_model = None
embed_model_device_state = "unloaded"
_TOKENIZER = None
_SPECIAL_TOKEN_IDS: set = set()


def cuda_cleanup():
    """Свести GPU memory к минимуму: gc, empty_cache, ipc_collect."""
    import gc
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()


def _cuda_mem_summary():
    if not torch.cuda.is_available():
        return {"allocated_gb": 0.0, "reserved_gb": 0.0, "free_gb": 0.0, "total_gb": 0.0}
    alloc = torch.cuda.memory_allocated() / 1024**3
    res = torch.cuda.memory_reserved() / 1024**3
    free, total = torch.cuda.mem_get_info()
    return {
        "allocated_gb": alloc,
        "reserved_gb":  res,
        "free_gb":      free / 1024**3,
        "total_gb":     total / 1024**3,
    }


def _load_embedding_to_gpu():
    """Свежая загрузка embed_model на GPU. Используется и при первом старте,
    и при lazy-reload после OFFLOAD_MODE='unload'."""
    global embed_model, embed_model_device_state, _TOKENIZER, _SPECIAL_TOKEN_IDS
    print(f"Грузим Jina embeddings на {device} ({dtype})...", flush=True)
    embed_model = AutoModel.from_pretrained(
        "jinaai/jina-embeddings-v4",
        trust_remote_code=True,
        dtype=dtype,
        attn_implementation="sdpa",
    ).to(device)
    if device == "cuda":
        embed_model.half()
    embed_model.eval()
    _TOKENIZER = embed_model.processor.tokenizer
    _SPECIAL_TOKEN_IDS = set(getattr(_TOKENIZER, "all_special_ids", []) or [])
    embed_model_device_state = "gpu"
    print(
        f"Embedding модель на {device}. tokenizer={type(_TOKENIZER).__name__} "
        f"special_ids={len(_SPECIAL_TOKEN_IDS)}.",
        flush=True,
    )


def ensure_embedding_on_gpu():
    """Гарантирует, что embed_model на GPU. Idempotent. Должен вызываться
    первым в любом эндпоинте, который трогает embed_model.*."""
    global embed_model, embed_model_device_state
    if embed_model_device_state == "gpu":
        return
    before = _cuda_mem_summary()
    if embed_model is None or embed_model_device_state == "unloaded":
        _load_embedding_to_gpu()
        after = _cuda_mem_summary()
        print(
            f"[model_lifecycle] embedding loaded to {device} "
            f"allocated_before={before['allocated_gb']:.2f}gb "
            f"allocated_after={after['allocated_gb']:.2f}gb",
            flush=True,
        )
        return
    # state == "cpu" → возвращаем на GPU
    embed_model.to(device)
    embed_model_device_state = "gpu"
    after = _cuda_mem_summary()
    print(
        f"[model_lifecycle] embedding moved to {device} "
        f"allocated_before={before['allocated_gb']:.2f}gb "
        f"allocated_after={after['allocated_gb']:.2f}gb",
        flush=True,
    )


def unload_embedding_before_rerank():
    """Выгрузить embed_model перед /rerank. Reranker НЕ трогаем — он
    остаётся на GPU. Поведение зависит от OFFLOAD_MODE.

    No-op, если:
      - RAS_UNLOAD_EMBEDDING_BEFORE_RERANK != 1
      - embed_model is None (нечего выгружать)
      - уже unloaded / на cpu
    """
    global embed_model, embed_model_device_state
    if not UNLOAD_BEFORE_RERANK:
        return
    if embed_model is None:
        return
    if embed_model_device_state in ("cpu", "unloaded"):
        return

    before = _cuda_mem_summary()
    if OFFLOAD_MODE == "cpu":
        embed_model.to("cpu")
        embed_model_device_state = "cpu"
    else:  # "unload"
        del embed_model
        embed_model = None
        embed_model_device_state = "unloaded"
    cuda_cleanup()
    after = _cuda_mem_summary()
    print(
        f"[model_lifecycle] embedding offloaded before rerank mode={OFFLOAD_MODE} "
        f"allocated_before={before['allocated_gb']:.2f}gb "
        f"allocated_after={after['allocated_gb']:.2f}gb "
        f"reserved_after={after['reserved_gb']:.2f}gb",
        flush=True,
    )


# Первичная загрузка при старте процесса — eager, чтобы первый /embed не
# платил cold-start. Дальше управление по lifecycle helpers.
_load_embedding_to_gpu()


# ─────────────────────────────────────────────────────────────────────────────
# Reranker (Step 5) — Jina reranker v3 (JinaForRanking, Qwen3-based).
#
# Загружается лениво при старте, если RAS_RERANKER_DISABLED != "1".
# Дефолт — `jinaai/jina-reranker-v3` (1B params, bf16 в конфиге → грузим
# в fp16 для V100 native tensor cores, max_position_embeddings=131072).
# Архитектура — JinaForRanking c custom .rerank() методом через
# trust_remote_code (`modeling.py` в HF-репо). v3 НЕ совместима с v2 API
# (.compute_score) — там generative Qwen3 + project head + cosine similarity.
#
# Env:
#   RAS_RERANKER_MODEL_ID         (default jinaai/jina-reranker-v3)
#   RAS_RERANKER_MAX_DOC_LENGTH   token cap на каждый документ (default 2048)
#   RAS_RERANKER_MAX_QUERY_LENGTH token cap на запрос (default 512)
#   RAS_RERANKER_DISABLED=1       вообще не грузить (для dev/CPU)
#
# Если загрузка падает (нет VRAM, недокачка) — модель остаётся None,
# /rerank → 503. /embed продолжает работать.
# ─────────────────────────────────────────────────────────────────────────────

RERANKER_MODEL_ID = os.environ.get(
    "RAS_RERANKER_MODEL_ID", "jinaai/jina-reranker-v3"
)
RERANKER_MAX_DOC_LENGTH = int(os.environ.get("RAS_RERANKER_MAX_DOC_LENGTH", "2048"))
RERANKER_MAX_QUERY_LENGTH = int(os.environ.get("RAS_RERANKER_MAX_QUERY_LENGTH", "512"))
RERANKER_DISABLED = os.environ.get("RAS_RERANKER_DISABLED", "0") == "1"

# Auto-lifecycle: если "1" — reranker НЕ грузится eager при старте, а только
# по явному POST /reranker/load. После /reranker/unload — выгружается из VRAM.
# Это нужно для режима «индексация + поиск на одной V100»:
#  - индексация: reranker выгружен, embedding-batching может занимать до
#    ~26 GB VRAM (peak), всё помещается.
#  - поиск: search-api зовёт /reranker/load перед /rerank → 1.5 GB VRAM ↑.
#  - после поиска: worker увидел очищение runtime-flag search_active в PG
#    и зовёт /reranker/unload → VRAM освобождается обратно.
#
# Если "0" (default для обратной совместимости) — старое поведение: грузим
# eager при старте, /reranker/unload работает по запросу, но автозагрузки
# обратно нет.
RERANKER_AUTO_LIFECYCLE = os.environ.get("RAS_RERANKER_AUTO_LIFECYCLE", "0") == "1"

# State machine: "unloaded" | "loading" | "loaded" | "error".
# Protected `_reranker_lock` — все load/unload идут под ним, чтобы
# конкурентные /reranker/load (например, два search-запроса одновременно)
# не пытались грузить модель параллельно.
import threading
_reranker_lock = threading.Lock()
rerank_model = None
rerank_load_error: Optional[str] = None
reranker_state: str = "unloaded"  # "unloaded" | "loading" | "loaded" | "error"


def _load_reranker_to_gpu() -> dict:
    """
    Lazy-load reranker в VRAM. Idempotent: если уже "loaded" — no-op.
    Если "loading" — ждём текущую загрузку под lock'ом.

    Возвращает dict со state + сколько ms заняло (для логов клиента).
    """
    global rerank_model, rerank_load_error, reranker_state

    with _reranker_lock:
        if RERANKER_DISABLED:
            return {"state": "disabled", "elapsed_ms": 0, "model_id": RERANKER_MODEL_ID}
        if reranker_state == "loaded":
            return {"state": "loaded", "elapsed_ms": 0, "model_id": RERANKER_MODEL_ID}
        if reranker_state == "error":
            return {
                "state": "error",
                "error": rerank_load_error,
                "elapsed_ms": 0,
                "model_id": RERANKER_MODEL_ID,
            }

        reranker_state = "loading"
        print(f"[rerank/load] loading {RERANKER_MODEL_ID} ...", flush=True)
        t0 = time.perf_counter()
        try:
            # v3 — generative QwenForCausalLM-derived (JinaForRanking) с custom
            # rerank() в modeling.py. Нужен AutoModel + trust_remote_code.
            # bf16 в config.json → форсим fp16 для V100 (нет native bf16 у V100).
            rerank_model = AutoModel.from_pretrained(
                RERANKER_MODEL_ID,
                dtype=dtype,
                trust_remote_code=True,
            ).to(device)
            rerank_model.eval()
            # Pre-load tokenizer, чтобы первый /rerank не тратил время на AutoTokenizer.
            rerank_model._ensure_tokenizer()
            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            reranker_state = "loaded"
            rerank_load_error = None
            print(
                f"[rerank/load] ready model={RERANKER_MODEL_ID} "
                f"dtype={dtype} device={device} "
                f"max_doc={RERANKER_MAX_DOC_LENGTH} max_query={RERANKER_MAX_QUERY_LENGTH} "
                f"loaded_in={elapsed_ms}ms",
                flush=True,
            )
            return {"state": "loaded", "elapsed_ms": elapsed_ms, "model_id": RERANKER_MODEL_ID}
        except Exception as e:
            rerank_load_error = repr(e)
            rerank_model = None
            reranker_state = "error"
            print(
                f"[rerank/load] LOAD FAILED model={RERANKER_MODEL_ID}: {rerank_load_error}",
                flush=True,
            )
            return {
                "state": "error",
                "error": rerank_load_error,
                "elapsed_ms": int((time.perf_counter() - t0) * 1000),
                "model_id": RERANKER_MODEL_ID,
            }


def _unload_reranker_from_gpu() -> dict:
    """
    Выгрузить reranker из VRAM (полный del + cuda.empty_cache).
    Idempotent: если уже "unloaded" — no-op.
    """
    global rerank_model, reranker_state

    with _reranker_lock:
        if RERANKER_DISABLED:
            return {"state": "disabled", "freed_gb": 0.0}
        if reranker_state == "unloaded":
            return {"state": "unloaded", "freed_gb": 0.0}

        before_gb = 0.0
        if device == "cuda" and torch.cuda.is_available():
            before_gb = torch.cuda.memory_allocated() / 1024**3

        if rerank_model is not None:
            try:
                rerank_model.to("cpu")
            except Exception:
                pass
            del rerank_model
            rerank_model = None

        if device == "cuda" and torch.cuda.is_available():
            torch.cuda.empty_cache()
            after_gb = torch.cuda.memory_allocated() / 1024**3
        else:
            after_gb = 0.0

        reranker_state = "unloaded"
        freed = max(0.0, before_gb - after_gb)
        print(
            f"[rerank/unload] freed_gb={freed:.2f} (was={before_gb:.2f} now={after_gb:.2f})",
            flush=True,
        )
        return {"state": "unloaded", "freed_gb": round(freed, 3)}


# Initial load behaviour:
#  - RERANKER_DISABLED=1 → не трогаем.
#  - RERANKER_AUTO_LIFECYCLE=1 → cold start, /reranker/load по запросу.
#  - иначе → eager-load для обратной совместимости.
if RERANKER_DISABLED:
    print("[rerank] disabled via RAS_RERANKER_DISABLED=1", flush=True)
elif RERANKER_AUTO_LIFECYCLE:
    print(
        f"[rerank] auto-lifecycle enabled — cold start. "
        f"POST /reranker/load to bring up {RERANKER_MODEL_ID}.",
        flush=True,
    )
else:
    _load_reranker_to_gpu()


def _sparse_from_text(text: str) -> dict:
    """
    Делает sparse-вектор для одного текста: tokenize → отбросить спец-токены →
    посчитать частоту каждого token_id → отдать {indices, values}.

    Qdrant принимает {indices: int[], values: float[]} и, если коллекция
    создана с `sparse_vectors_config.modifier="idf"`, сам считает IDF на
    стороне сервера. Так что отдаём raw term frequencies.

    Возвращает пустой sparse {indices:[], values:[]} если текст пустой —
    Qdrant нормально с этим живёт (просто не учитывает sparse для этого
    point'а).
    """
    if not text:
        return {"indices": [], "values": []}
    ids = _TOKENIZER(
        text,
        add_special_tokens=False,
        truncation=False,
        return_attention_mask=False,
    )["input_ids"]
    counts = Counter(int(i) for i in ids if int(i) not in _SPECIAL_TOKEN_IDS)
    if not counts:
        return {"indices": [], "values": []}
    indices = list(counts.keys())
    values = [float(counts[i]) for i in indices]
    return {"indices": indices, "values": values}


class EmbedReq(BaseModel):
    texts: List[str]
    task: str = "retrieval.passage"
    return_sparse: bool = True


@app.get("/health")
def health():
    if RERANKER_DISABLED:
        reranker_status = "disabled"
    elif reranker_state == "loaded":
        reranker_status = "ready"
    elif reranker_state == "loading":
        reranker_status = "loading"
    elif reranker_state == "unloaded":
        reranker_status = "unloaded"
    elif reranker_state == "error":
        reranker_status = f"load_failed:{rerank_load_error}"
    else:
        reranker_status = reranker_state
    return {
        "status": "ok",
        "device": device,
        "cuda_available": torch.cuda.is_available(),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "reranker": reranker_status,
        "reranker_model_id": RERANKER_MODEL_ID if not RERANKER_DISABLED else None,
        "reranker_max_doc_length": RERANKER_MAX_DOC_LENGTH,
        "reranker_max_query_length": RERANKER_MAX_QUERY_LENGTH,
        "embed_model_device_state": embed_model_device_state,
        "unload_embedding_before_rerank": UNLOAD_BEFORE_RERANK,
        "model_offload_mode": OFFLOAD_MODE,
        "cuda_memory": _cuda_mem_summary(),
        "xformers_enabled": XFORMERS_ENABLED,
        "xformers_stats": XFORMERS_STATS,
        "torch": torch.__version__,
        "torch_cuda": torch.version.cuda,
        "reranker_state": reranker_state,
        "reranker_auto_lifecycle": RERANKER_AUTO_LIFECYCLE,
        "whisper_state": whisper_state,
        "whisper_model_path": WHISPER_MODEL_PATH if not WHISPER_DISABLED else None,
        "whisper_disabled": WHISPER_DISABLED,
    }


@app.post("/reranker/load")
def reranker_load():
    """
    Lazy-load reranker в VRAM. Idempotent: вызов когда уже loaded — no-op
    с elapsed_ms=0. Если reranker disabled (RAS_RERANKER_DISABLED=1) —
    возвращает {state:"disabled"} без 5xx, чтобы клиент мог понять что
    инфра в indexing-only mode.

    Использование: search-api fire-and-forget'ит этот POST в начале /search,
    параллельно делает /embed query, потом /rerank. К моменту /rerank
    reranker уже загружен (либо догружается — /rerank сам ждёт).
    """
    result = _load_reranker_to_gpu()
    if result.get("state") == "error":
        raise HTTPException(status_code=500, detail=result)
    return result


@app.post("/reranker/unload")
def reranker_unload():
    """
    Выгрузить reranker из VRAM. Idempotent.

    Использование: embed-worker зовёт после возобновления работы (когда
    runtime-флаг search_active в PG истёк), чтобы вернуть VRAM под
    multivector-batching.
    """
    result = _unload_reranker_from_gpu()
    return result


@app.post("/embed")
def embed(req: EmbedReq):
    with model_guard("embed"):
        return _embed_impl(req)


def _embed_impl(req: EmbedReq):
    """
    Возвращает на каждый текст:
      multivectors[i]  — token-level matrix (Jina v4 multivector, 128-dim per token)
                         для ColBERT-style late interaction (MaxSim rerank).
      dense_vectors[i] — pooled single vector (Jina v4, 2048-dim, обычно нормирован)
                         для основного dense retrieval (DOT / cosine).
      token_counts[i]  — фактическое число токенов после tokenizer (нужно для
                         token_count в PostgreSQL и для роутинга is_long_act).

    Два прохода модели: первый return_multivector=True (colbert), второй False
    (dense). Это удваивает inference time, но даёт нам обе репрезентации без
    хака с pooling по multivector.
    """
    t0 = time.perf_counter()
    prompt_name = "query" if req.task == "retrieval.query" else "passage"

    ensure_embedding_on_gpu()

    t_tokenize1 = time.perf_counter()

    before_calls = dict(XFORMERS_STATS)

    if device == "cuda":
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

    with torch.inference_mode():
        # Jina v4 forward already computes both:
        #   outputs.single_vec_emb and outputs.multi_vec_emb
        # Avoid two encode_text() calls, which run the full model twice.
        prefix = "Query" if prompt_name == "query" else "Passage"
        batch = embed_model.processor.process_texts(
            req.texts,
            max_length=32768,
            prefix=prefix,
        )
        batch = {k: v.to(embed_model.device) for k, v in batch.items()}

        with torch.autocast(
            device_type=torch.device(embed_model.device).type,
            dtype=torch.bfloat16,
        ):
            outputs = embed_model(**batch, task_label="retrieval")

        valid_tokens = batch["attention_mask"].bool()
        mv_outputs = [
            emb[mask].detach().cpu()
            for emb, mask in zip(outputs.multi_vec_emb, valid_tokens)
        ]
        dense_outputs = [
            emb.detach().cpu()
            for emb in torch.unbind(outputs.single_vec_emb)
        ]

        # Drop GPU tensors before response serialization.
        del outputs
        del batch
        del valid_tokens
        if device == "cuda":
            torch.cuda.empty_cache()

    if device == "cuda":
        torch.cuda.synchronize()

    t1 = time.perf_counter()

    multivectors  = [tensor.tolist() for tensor in mv_outputs]
    dense_vectors = [tensor.tolist() for tensor in dense_outputs]

    token_counts = [len(mv) for mv in multivectors]

    sparse_vectors = (
        [_sparse_from_text(t) for t in req.texts] if req.return_sparse else None
    )

    after_calls = dict(XFORMERS_STATS)

    if device == "cuda":
        peak_gb = torch.cuda.max_memory_allocated() / 1024**3
    else:
        peak_gb = 0

    print(
        f"[embed_timing] texts={len(req.texts)} tokens={token_counts} "
        f"model_ms={(t1-t0)*1000:.0f} "
        f"sparse={'on' if req.return_sparse else 'off'} "
        f"peak_gb={peak_gb:.2f} "
        f"xformers_calls_delta={after_calls['xformers_calls'] - before_calls['xformers_calls']} "
        f"fallback_calls_delta={after_calls['fallback_calls'] - before_calls['fallback_calls']}",
        flush=True,
    )

    out = {
        "multivectors":  multivectors,
        "dense_vectors": dense_vectors,
        "token_counts":  token_counts,
    }
    if sparse_vectors is not None:
        out["sparse_vectors"] = sparse_vectors
    return out


class ChunkSpan(BaseModel):
    chunk_id: int
    start_char: int
    end_char: int


class LateChunksReq(BaseModel):
    # Оригинальный act_text целиком. Сервер НЕ собирает full_text из chunks.
    full_text: str

    # Если chunks переданы, используем explicit spans.
    # Если chunks не переданы, сервер сам строит balanced paragraph-aware
    # chunks: chunk_count = ceil(real_tokens / max_chunk_tokens),
    # target_per_chunk = ceil(real_tokens / chunk_count).
    chunks: Optional[List[ChunkSpan]] = None

    # Hard max на токены в одном чанке. Балансировщик делит документ так,
    # чтобы все чанки были примерно одной длины ≤ max_chunk_tokens.
    # 7000 — буфер 1000 до short/long gate (8000), чтобы chunk сам не
    # стал «длинным» по нашим же критериям.
    max_chunk_tokens: int = 8000

    # Tolerance для paragraph-aware boundary: двигаем границу к ближайшему
    # \n\n в пределах ±tolerance × target_per_chunk. 0.12 ≈ 12%.
    paragraph_tolerance: float = 0.12

    # Возвращать colbert multivector per chunk (raw token embeddings,
    # без mean-pool). По умолчанию True для long-pipeline нового образца —
    # длинные акты получают ту же late-interaction что и короткие.
    return_colbert: bool = True

    # Legacy: target_chunk_tokens поддерживается, но игнорируется balanced
    # сплитом (он считает оптимальный target сам). Оставлено для
    # back-compat с клиентом до balanced.
    target_chunk_tokens: int = 2000

    task: str = "retrieval.passage"
    max_length: int = 32768
    return_sparse: bool = True


@app.post("/embed_late_chunks")
def embed_late_chunks(req: LateChunksReq):
    with model_guard("embed_late_chunks"):
        return _embed_late_chunks_impl(req)


def _embed_late_chunks_impl(req: LateChunksReq):
    """
    Real late chunking для длинных актов.

    Сначала энкодим весь оригинальный документ одним forward pass.
    Потом строим token-aware chunks по tokenizer offsets и делаем mean-pool
    token embeddings внутри каждого chunk.

    Режимы:
      explicit   — клиент передал chunks=[{chunk_id,start_char,end_char}]
      token_auto — клиент не передал chunks, сервер сам строит chunks по токенам

    Возвращает:
      dense_late_vectors[i] — 128-dim mean-pool токенов чанка
      sparse_vectors[i]     — sparse TF от original full_text[start:end]
      token_counts[i]       — число токенов в чанке
      chunks[i]             — реальные char spans, которые надо писать в Qdrant
      full_tokens/full_chars
    """
    t0 = time.perf_counter()

    if not req.full_text:
        return {"error": "empty_full_text"}

    text_len = len(req.full_text)
    explicit_chunks = list(req.chunks or [])

    for c in explicit_chunks:
        if c.start_char < 0 or c.end_char > text_len or c.start_char >= c.end_char:
            return {
                "error": "bad_chunk_span",
                "chunk_id": c.chunk_id,
                "start_char": c.start_char,
                "end_char": c.end_char,
                "full_chars": text_len,
            }

    prompt_name = "query" if req.task == "retrieval.query" else "passage"
    task_label = "retrieval" if req.task.startswith("retrieval") else req.task

    ensure_embedding_on_gpu()

    encode_kwargs = embed_model._validate_encoding_params(
        truncate_dim=None,
        prompt_name=prompt_name,
    )
    prefix = encode_kwargs.get("prefix", "") or ""
    # Must match JinaEmbeddingsV4Processor.process_texts(): f"{prefix}: {text}"
    prefix_text = f"{prefix}: " if prefix else ""
    prefix_len = len(prefix_text)
    tokenized_text = prefix_text + req.full_text

    t_tokenize0 = time.perf_counter()
    probe_ids = _TOKENIZER(
        tokenized_text,
        add_special_tokens=True,
        truncation=False,
        return_attention_mask=False,
    )["input_ids"]
    real_token_count = len(probe_ids)

    if real_token_count > req.max_length:
        return {
            "error": "too_long_for_late_chunking",
            "full_chars": text_len,
            "real_token_count": real_token_count,
            "max_length": req.max_length,
            "advice": "split act into windows or raise max_length",
        }

    offsets_enc = _TOKENIZER(
        tokenized_text,
        add_special_tokens=True,
        return_offsets_mapping=True,
        truncation=False,
    )
    offsets = offsets_enc.get("offset_mapping")
    t_tokenize1 = time.perf_counter()

    if offsets is None:
        return {
            "error": "offset_mapping_not_available",
            "tokenizer_type": str(type(_TOKENIZER)),
        }

    before_calls = dict(XFORMERS_STATS)

    if device == "cuda":
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

    t_embed0 = time.perf_counter()
    with torch.inference_mode():
        outputs = embed_model.encode_text(
            texts=[req.full_text],
            task=task_label,
            prompt_name=prompt_name,
            max_length=req.max_length,
            batch_size=1,
            return_multivector=True,
        )

    if device == "cuda":
        torch.cuda.synchronize()
    t_embed1 = time.perf_counter()

    mv = outputs[0] if isinstance(outputs, list) else outputs
    mv = mv.detach().float().cpu().numpy()

    # Drop GPU tensors before CPU pooling / sparse / response serialization.
    del outputs
    if device == "cuda":
        torch.cuda.empty_cache()

    n_emb_tokens = mv.shape[0]

    token_len = min(len(offsets), n_emb_tokens)
    if abs(len(offsets) - n_emb_tokens) > 8:
        return {
            "error": "token_alignment_mismatch",
            "offset_tokens": len(offsets),
            "embedding_tokens": int(n_emb_tokens),
            "prefix_len": prefix_len,
            "full_chars": text_len,
        }

    def content_token_offsets():
        out = []
        for ti, pair in enumerate(offsets[:token_len]):
            a, b = int(pair[0]), int(pair[1])
            if b <= a:
                continue

            a -= prefix_len
            b -= prefix_len

            if b <= 0 or a >= text_len:
                continue

            a = max(0, a)
            b = min(text_len, b)
            if b <= a:
                continue

            out.append((ti, a, b))
        return out

    def build_balanced_chunks() -> List[ChunkSpan]:
        """
        Balanced paragraph-aware split.

        Логика:
          chunk_count = ceil(total_content_tokens / max_chunk_tokens)
          target_per_chunk = ceil(total_content_tokens / chunk_count)

        Это даёт чанки примерно одной длины (не fixed + крошечный хвост).
        Примеры:
          16k tokens, max 8000 → 2 chunks × ~8000
          20k tokens, max 8000 → 3 chunks × ~6667
          24k tokens, max 8000 → 3 chunks × ~8000

        Paragraph-aware: целевую границу мы пытаемся притянуть к ближайшему
        \\n\\n в пределах ±tolerance × target_per_chunk. Если рядом
        нормального paragraph break нет — режем по token boundary.

        Hard max: paragraph snap НЕ может увести чанк выше max_chunk токенов.
        Если ближайший break за hard-cap'ом — fallback на token boundary.

        Без overlap: это late chunking, токены уже посчитаны с full-document
        attention; overlap избыточен.
        """
        max_chunk = int(req.max_chunk_tokens or 8000)
        if max_chunk < 256:
            max_chunk = 256
        tolerance = float(req.paragraph_tolerance or 0.0)
        if tolerance < 0:
            tolerance = 0.0
        if tolerance > 0.5:
            tolerance = 0.5

        toks = content_token_offsets()
        if not toks:
            return [ChunkSpan(chunk_id=0, start_char=0, end_char=text_len)]

        total = len(toks)
        if total <= max_chunk:
            return [ChunkSpan(chunk_id=0, start_char=0, end_char=text_len)]

        chunk_count = (total + max_chunk - 1) // max_chunk  # ceil
        target_per_chunk = (total + chunk_count - 1) // chunk_count  # ceil

        # Соберём список абзацных стыков (char-offsets) в исходном тексте.
        # Используем «\n\n» как маркер. Если документ — один сплошной блок,
        # paragraph_breaks будет пустой → fallback на token boundary.
        paragraph_breaks: List[int] = []
        cursor = 0
        while True:
            idx = req.full_text.find("\n\n", cursor)
            if idx < 0:
                break
            # Граница чанка — после блока \n\n, то есть начало следующего абзаца.
            paragraph_breaks.append(idx + 2)
            cursor = idx + 2

        def nearest_paragraph(token_end_char: int, window_chars: int) -> Optional[int]:
            """Вернуть ближайший paragraph break к token_end_char в окне
            ±window_chars. None если нет."""
            if not paragraph_breaks or window_chars <= 0:
                return None
            best = None
            best_dist = None
            lo = token_end_char - window_chars
            hi = token_end_char + window_chars
            # Линейный скан — paragraph_breaks обычно <= десятков.
            for pb in paragraph_breaks:
                if pb < lo:
                    continue
                if pb > hi:
                    break
                d = abs(pb - token_end_char)
                if best_dist is None or d < best_dist:
                    best = pb
                    best_dist = d
            return best

        # Tolerance в char-окне. Грубо считаем: 1 токен ≈ 3.5 char (русский
        # legal на jina v4). target_per_chunk * 3.5 * tolerance.
        tolerance_window_chars = int(target_per_chunk * 3.5 * tolerance)

        chunks_out: List[ChunkSpan] = []
        start_char = 0
        next_target_tok = target_per_chunk
        chunk_id = 0
        chunk_start_tok = 0  # индекс в toks, где начинается текущий чанк

        while next_target_tok < total:
            # Char-позиция конца "next_target_tok"-го content-токена.
            target_tok_end_char = toks[next_target_tok - 1][2]

            # Hard cap: чанк не может содержать > max_chunk content-токенов.
            # Берём end_char того токена, который ровно max_chunk-й от
            # chunk_start_tok. Если paragraph snap уведёт дальше — clamp'им.
            hard_max_tok_idx = min(chunk_start_tok + max_chunk - 1, total - 1)
            hard_max_end_char = toks[hard_max_tok_idx][2]

            # Попытаться притянуть к paragraph break.
            pb = nearest_paragraph(target_tok_end_char, tolerance_window_chars)
            end_char = pb if pb is not None else target_tok_end_char

            # Hard clamp: forward snap не должен пробивать max_chunk токенов.
            # Backward snap (pb < target) безопасен — он только уменьшает чанк.
            if end_char > hard_max_end_char:
                end_char = target_tok_end_char
                if end_char > hard_max_end_char:
                    end_char = hard_max_end_char

            # Гарантия монотонности: end_char > start_char.
            if end_char <= start_char:
                end_char = target_tok_end_char

            chunks_out.append(
                ChunkSpan(
                    chunk_id=chunk_id,
                    start_char=int(start_char),
                    end_char=int(end_char),
                )
            )
            chunk_id += 1
            start_char = end_char
            # Сдвинуть chunk_start_tok до первого токена, начинающегося ≥ start_char.
            while chunk_start_tok < total and toks[chunk_start_tok][1] < start_char:
                chunk_start_tok += 1
            next_target_tok += target_per_chunk

        # Финальный чанк: добираем до конца текста.
        if start_char < text_len:
            chunks_out.append(
                ChunkSpan(
                    chunk_id=chunk_id,
                    start_char=int(start_char),
                    end_char=int(text_len),
                )
            )

        return chunks_out

    chunks = explicit_chunks if explicit_chunks else build_balanced_chunks()
    chunk_mode = "explicit" if explicit_chunks else "balanced_paragraph_aware"

    t_pool0 = time.perf_counter()
    dense_late_vectors: List[List[float]] = []
    colbert_vectors: List[List[List[float]]] = []
    token_counts: List[int] = []

    for chunk in chunks:
        start = int(chunk.start_char)
        end = int(chunk.end_char)
        token_indexes = []

        for ti, pair in enumerate(offsets[:token_len]):
            a, b = int(pair[0]), int(pair[1])
            if b <= a:
                continue

            a -= prefix_len
            b -= prefix_len

            if b <= 0 or a >= text_len:
                continue

            if max(a, start) < min(b, end):
                token_indexes.append(ti)

        if not token_indexes:
            token_indexes = [0]

        chunk_mv = mv[token_indexes]
        pooled = chunk_mv.mean(axis=0)
        dense_late_vectors.append(pooled.tolist())
        token_counts.append(len(token_indexes))

        # ColBERT per chunk: raw multivector токенов чанка, БЕЗ mean-pool.
        # На retrieval-стороне используется через MaxSim (ветка long_colbert).
        # Это и есть «late chunking + per-chunk colbert»: токены посчитаны
        # с full-document attention, потом нарезаны на чанки без overlap.
        if req.return_colbert:
            colbert_vectors.append(chunk_mv.tolist())

    t_pool1 = time.perf_counter()

    t_sparse0 = time.perf_counter()
    sparse_vectors: Optional[list] = None
    if req.return_sparse:
        sparse_vectors = [
            _sparse_from_text(req.full_text[c.start_char:c.end_char])
            for c in chunks
        ]
    t_sparse1 = time.perf_counter()

    after_calls = dict(XFORMERS_STATS)
    peak_gb = torch.cuda.max_memory_allocated() / 1024**3 if device == "cuda" else 0

    t1 = time.perf_counter()
    print(
        f"[late_chunks_timing] mode={chunk_mode} max_chunk_tokens={req.max_chunk_tokens} "
        f"tol={req.paragraph_tolerance} "
        f"chunks={len(chunks)} full_chars={text_len} real_tokens={real_token_count} "
        f"emb_tokens={int(n_emb_tokens)} chunk_tokens={token_counts} "
        f"colbert={'on' if req.return_colbert else 'off'} "
        f"total_ms={(t1-t0)*1000:.0f} "
        f"tokenize_ms={(t_tokenize1-t_tokenize0)*1000:.0f} "
        f"embed_ms={(t_embed1-t_embed0)*1000:.0f} "
        f"pool_ms={(t_pool1-t_pool0)*1000:.0f} "
        f"sparse_ms={(t_sparse1-t_sparse0)*1000:.0f} "
        f"sparse={'on' if req.return_sparse else 'off'} "
        f"peak_gb={peak_gb:.2f} "
        f"xformers_calls_delta={after_calls['xformers_calls'] - before_calls['xformers_calls']} "
        f"fallback_calls_delta={after_calls['fallback_calls'] - before_calls['fallback_calls']}",
        flush=True,
    )

    out = {
        "dense_late_vectors": dense_late_vectors,
        "token_counts": token_counts,
        "full_tokens": int(n_emb_tokens),
        "full_chars": text_len,
        "chunk_mode": chunk_mode,
        "max_chunk_tokens": int(req.max_chunk_tokens or 8000),
        "paragraph_tolerance": float(req.paragraph_tolerance or 0.0),
        # back-compat: некоторые клиенты ещё читают target_chunk_tokens
        "target_chunk_tokens": int(req.target_chunk_tokens or 0),
        "chunks": [
            {
                "chunk_id": int(c.chunk_id),
                "start_char": int(c.start_char),
                "end_char": int(c.end_char),
            }
            for c in chunks
        ],
    }
    if sparse_vectors is not None:
        out["sparse_vectors"] = sparse_vectors
    if req.return_colbert:
        out["colbert_vectors"] = colbert_vectors

    return out


# ─────────────────────────────────────────────────────────────────────────────
# /count_tokens — подсчёт токенов сразу двумя tokenizer'ами:
#   • Jina v3 reranker (Qwen3) — для гейтинга по RERANKER_MAX_DOC_LENGTH.
#   • Jina v4 embedder         — для is_long_act и роутинга full_act/late_chunks
#                                 (cap 8192 на full_act, 32768 на late chunks).
#
# Используется pdf-pipeline на этапе markTextExtracted: после скачивания
# текста сразу пишем оба числа в acts.tokens_jina_v3 / acts.token_count,
# чтобы downstream (/rerank, индексер, hydrate) не дёргали /count_tokens
# на каждый акт.
#
# Считаем БЕЗ special tokens — так же как реальный /rerank и /embed.
#
# Ответ: { tokens_jina_v3, tokens_jina_v4, model_id_v3, model_id_v4,
#          add_special_tokens, errors[] }.
# Поле token_count оставлено как алиас tokens_jina_v3 для backward-compat
# со старыми клиентами (можно убрать когда никто не читает).
#
# Reranker недоступен → tokens_jina_v3=None + errors=["reranker_unavailable:…"].
# Embed-tokenizer недоступен → tokens_jina_v4=None + errors=[…].
# Раньше при отсутствии reranker /count_tokens возвращал 503; теперь — 200
# с partial-результатом, чтобы download-pipeline не валился из-за reranker'а.
# ─────────────────────────────────────────────────────────────────────────────

class CountTokensReq(BaseModel):
    text: str


def _ensure_v4_tokenizer():
    """Гарантирует, что _TOKENIZER (jina-embeddings-v4) загружен.

    Обычно он инициализируется в _load_embedding_to_gpu(); но если inference
    только что стартовал и embed_model ещё не дёргали — поднимаем tokenizer
    отдельно через AutoTokenizer (без загрузки самой модели в VRAM).
    """
    global _TOKENIZER, _SPECIAL_TOKEN_IDS
    if _TOKENIZER is not None:
        return
    from transformers import AutoTokenizer
    _TOKENIZER = AutoTokenizer.from_pretrained(
        "jinaai/jina-embeddings-v4",
        trust_remote_code=True,
    )
    _SPECIAL_TOKEN_IDS = set(getattr(_TOKENIZER, "all_special_ids", []) or [])
    print(
        f"[count_tokens] lazy-loaded jina-v4 tokenizer={type(_TOKENIZER).__name__} "
        f"(embed_model остаётся unloaded)",
        flush=True,
    )


@app.post("/count_tokens")
def count_tokens(req: CountTokensReq):
    with model_guard("count_tokens"):
        return _count_tokens_impl(req)


def _count_tokens_impl(req: CountTokensReq):
    text = req.text or ""
    errors: List[str] = []

    # ── Jina v3 reranker tokens ──
    tokens_v3: Optional[int] = None
    if rerank_model is None:
        errors.append(
            "reranker_unavailable:"
            + ("disabled_via_env" if RERANKER_DISABLED else f"load_failed:{rerank_load_error}")
        )
    elif not text:
        tokens_v3 = 0
    else:
        try:
            rerank_model._ensure_tokenizer()
            ids_v3 = rerank_model._tokenizer(
                text,
                add_special_tokens=False,
                truncation=False,
                return_attention_mask=False,
            )["input_ids"]
            tokens_v3 = len(ids_v3)
        except Exception as e:
            errors.append(f"v3_tokenize_failed:{type(e).__name__}:{e}")

    # ── Jina v4 embed tokens ──
    tokens_v4: Optional[int] = None
    if not text:
        tokens_v4 = 0
    else:
        try:
            _ensure_v4_tokenizer()
            ids_v4 = _TOKENIZER(
                text,
                add_special_tokens=False,
                truncation=False,
                return_attention_mask=False,
            )["input_ids"]
            tokens_v4 = len(ids_v4)
        except Exception as e:
            errors.append(f"v4_tokenize_failed:{type(e).__name__}:{e}")

    return {
        "tokens_jina_v3":     tokens_v3,
        "tokens_jina_v4":     tokens_v4,
        # backward-compat алиас (старые клиенты читали token_count = v3):
        "token_count":        tokens_v3,
        "model_id_v3":        RERANKER_MODEL_ID,
        "model_id_v4":        "jinaai/jina-embeddings-v4",
        "add_special_tokens": False,
        "errors":             errors,
    }


# ─────────────────────────────────────────────────────────────────────────────
# /rerank — Step 5 (hydration → reranker).
# ─────────────────────────────────────────────────────────────────────────────

class RerankReq(BaseModel):
    query: str
    documents: List[str]
    top_n: Optional[int] = None
    max_doc_length: Optional[int] = None
    max_query_length: Optional[int] = None
    return_documents: bool = False


@app.post("/rerank")
def rerank(req: RerankReq):
    with model_guard("rerank"):
        return _rerank_impl(req)


def _rerank_impl(req: RerankReq):
    """
    Jina v3 rerank (JinaForRanking): generative cosine-similarity scoring.

    Вход:  query, documents[]
    Выход: results = [{index, score, document?}, …], отсортирован по score desc.

    index — позиция в исходном req.documents. Клиент пересобирает result.index
    → свои объекты (payload, act_id и т.п.).

    Параметры:
      top_n            — обрезать список (default: все)
      max_doc_length   — token cap на документ (default RERANKER_MAX_DOC_LENGTH=2048)
      max_query_length — token cap на запрос (default RERANKER_MAX_QUERY_LENGTH=512)
      return_documents — вернуть текст документа в ответе (для debug)
    """
    # Auto-load fallback: при RERANKER_AUTO_LIFECYCLE=1 reranker по дефолту
    # выгружен, и search-api обычно делает fire-and-forget /reranker/load
    # перед /rerank. На случай race condition (запрос /rerank пришёл раньше,
    # чем загрузка завершилась) — здесь блокирующий load под lock'ом.
    if RERANKER_AUTO_LIFECYCLE and reranker_state != "loaded" and not RERANKER_DISABLED:
        print(
            f"[rerank] auto-load triggered (state={reranker_state}) — "
            f"client called /rerank without /reranker/load",
            flush=True,
        )
        _load_reranker_to_gpu()

    # Первое действие: выгружаем embedding из VRAM, чтобы reranker'у было
    # просторнее (особенно на V100 с длинными контекстами). reranker не трогаем.
    unload_embedding_before_rerank()

    if rerank_model is None or reranker_state != "loaded":
        raise HTTPException(
            status_code=503,
            detail={
                "error": "reranker_unavailable",
                "reason": (
                    "disabled_via_env"
                    if RERANKER_DISABLED
                    else f"state:{reranker_state};load_failed:{rerank_load_error}"
                ),
                "model_id": RERANKER_MODEL_ID,
            },
        )

    if not req.documents:
        return {"results": [], "model": RERANKER_MODEL_ID, "scored": 0}

    max_doc = int(req.max_doc_length)   if req.max_doc_length   else RERANKER_MAX_DOC_LENGTH
    max_q   = int(req.max_query_length) if req.max_query_length else RERANKER_MAX_QUERY_LENGTH

    # Логируем то, что пришло, и то, что реально будет применено.
    print(
        f"[rerank/req] docs={len(req.documents)} "
        f"req.max_doc_length={req.max_doc_length} req.max_query_length={req.max_query_length} "
        f"effective_max_doc_length={max_doc} effective_max_query_length={max_q} "
        f"top_n={req.top_n}",
        flush=True,
    )

    # Manual token-based truncation. .rerank() в jina-reranker-v3 принимает
    # max_doc_length, но эмпирически — параметр не влияет ни на latency, ни на
    # score'ы. Поэтому режем документы ДО передачи модели: tokenizer-у самого
    # reranker'а отдаём id-шки и обрезаем до max_doc; затем decode обратно в
    # текст. Это даёт нам гарантию: модель видит ровно max_doc токенов.
    #
    # Замечание про точность токенизации:
    #   tokenizer.encode → trunc → decode → не побайтово идентичен оригиналу
    #   (могут чуть-чуть «отъесть» хвост на границе токена), но семантически
    #   одинаково. Reranker'у это не мешает.
    rerank_model._ensure_tokenizer()
    rerank_tok = rerank_model._tokenizer
    doc_texts_in = [doc or "" for doc in req.documents]
    doc_tokens_before = []
    doc_tokens_after  = []
    doc_texts_out = []
    for doc in doc_texts_in:
        if not doc:
            doc_tokens_before.append(0)
            doc_tokens_after.append(0)
            doc_texts_out.append("")
            continue
        ids = rerank_tok(
            doc,
            add_special_tokens=False,
            truncation=False,
            return_attention_mask=False,
        )["input_ids"]
        n_before = len(ids)
        if n_before > max_doc:
            ids = ids[:max_doc]
            cut_text = rerank_tok.decode(ids, skip_special_tokens=True)
        else:
            cut_text = doc
        doc_tokens_before.append(n_before)
        doc_tokens_after.append(min(n_before, max_doc))
        doc_texts_out.append(cut_text)

    print(
        f"[rerank/trunc] max_doc={max_doc} "
        f"doc_token_counts_before(min/avg/max)="
        f"{min(doc_tokens_before)}/"
        f"{sum(doc_tokens_before)//max(1,len(doc_tokens_before))}/"
        f"{max(doc_tokens_before)} "
        f"doc_token_counts_after(min/avg/max)="
        f"{min(doc_tokens_after)}/"
        f"{sum(doc_tokens_after)//max(1,len(doc_tokens_after))}/"
        f"{max(doc_tokens_after)} "
        f"truncated_count={sum(1 for a,b in zip(doc_tokens_before,doc_tokens_after) if a>b)}",
        flush=True,
    )

    t0 = time.perf_counter()
    if device == "cuda":
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

    # Jina v3 .rerank() возвращает уже отсортированный по relevance_score список
    # [{document, relevance_score, index, embedding?}, …]. top_n=None → все.
    # Под капотом: один forward Qwen3 на список docs (с режущими блоками по 125),
    # проекция [hidden→512], cosine(query_emb, doc_emb).
    with torch.inference_mode():
        out = rerank_model.rerank(
            query=req.query,
            documents=doc_texts_out,   # уже обрезанные через tokenizer
            top_n=None,                # сорт сделаем уже на нашей стороне
            return_embeddings=False,
            max_doc_length=max_doc,    # резервная страховка, если модель всё-таки слушает
            max_query_length=max_q,
        )

    if device == "cuda":
        torch.cuda.synchronize()

    # out — это уже отсортированный список словарей; пересобираем в наш формат.
    # top_n обрезаем здесь (model.rerank уже это умеет, но мы оставили None
    # чтобы получить все score'ы — пригодится для дебага reranker'а).
    ranked = []
    for item in out:
        ranked.append({
            "index": int(item["index"]),
            "score": float(item["relevance_score"]),
        })
        if req.return_documents:
            ranked[-1]["document"] = item["document"]

    if req.top_n is not None and req.top_n > 0:
        ranked = ranked[: req.top_n]

    peak_gb = (
        torch.cuda.max_memory_allocated() / 1024**3 if device == "cuda" else 0
    )
    print(
        f"[rerank_timing] docs={len(req.documents)} max_doc={max_doc} max_q={max_q} "
        f"top_n={req.top_n or len(req.documents)} "
        f"ms={(time.perf_counter() - t0) * 1000:.0f} "
        f"peak_gb={peak_gb:.2f}",
        flush=True,
    )

    return {
        "results": ranked,
        "model": RERANKER_MODEL_ID,
        "scored": len(req.documents),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Whisper STT — antony66/whisper-large-v3-russian (fine-tuned large-v3)
#
# CUDA-resident: модель грузится на GPU при старте и остаётся там (~2.88 GB).
# VRAM бюджет: Jina peak ~14 GB + Reranker ~2 GB + Whisper ~3 GB = ~19 GB
# из 31.7 GB V100 — с запасом.
#
# generate() идёт под MODEL_LOCK (сериализуется с embed/rerank), потому что
# CUDA compute contention на V100 даёт 10x slowdown при параллельном inference.
# Зато transfer'ов CPU↔CUDA нет → экономим 3-5 сек на каждом запросе.
#
# Почему модель «читала по-английски»: WhisperForConditionalGeneration.generate()
# по умолчанию делает auto-detect языка и ИГНОРИРУЕТ "language" из generation_config.
# Фикс — явные language= и task= kwargs при каждом .generate().
#
# Env:
#   RAS_WHISPER_MODEL_PATH  — путь к модели (default: ../models/whisper-large-v3-russian)
#   RAS_WHISPER_DISABLED=1  — не грузить вообще (/transcribe → 503)
# ─────────────────────────────────────────────────────────────────────────────

WHISPER_MODEL_PATH = os.environ.get(
    "RAS_WHISPER_MODEL_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "whisper-large-v3-russian"),
)
WHISPER_DISABLED = os.environ.get("RAS_WHISPER_DISABLED", "0") == "1"

_whisper_lock = threading.Lock()
whisper_model = None
whisper_processor = None
whisper_state: str = "unloaded"  # "unloaded" | "gpu"


def _load_whisper_to_gpu() -> dict:
    """Load whisper model + processor directly to GPU. Idempotent."""
    global whisper_model, whisper_processor, whisper_state

    with _whisper_lock:
        if whisper_state == "gpu":
            return {"state": "gpu", "elapsed_ms": 0}

        from transformers import WhisperForConditionalGeneration, WhisperProcessor

        t0 = time.perf_counter()
        before = _cuda_mem_summary()
        print(f"[whisper/load] loading {WHISPER_MODEL_PATH} to {device}...", flush=True)

        whisper_processor = WhisperProcessor.from_pretrained(WHISPER_MODEL_PATH)

        # V100 не поддерживает native bf16 — кастуем в fp16 при загрузке.
        whisper_model = WhisperForConditionalGeneration.from_pretrained(
            WHISPER_MODEL_PATH,
            dtype=torch.float16,
            low_cpu_mem_usage=True,
        ).to(device)
        whisper_model.eval()

        gc = whisper_model.generation_config
        after = _cuda_mem_summary()
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        whisper_state = "gpu"
        n_params = sum(p.numel() for p in whisper_model.parameters()) / 1e6
        print(
            f"[whisper/load] ready on {device} in {elapsed_ms}ms — "
            f"{n_params:.0f}M params, fp16, "
            f"generation_config: language={gc.language}, task={gc.task}, "
            f"vram_before={before['allocated_gb']:.2f}gb "
            f"vram_after={after['allocated_gb']:.2f}gb",
            flush=True,
        )
        return {"state": "gpu", "elapsed_ms": elapsed_ms}


def _decode_audio_to_numpy(audio_bytes: bytes) -> np.ndarray:
    """Decode any audio format (OGG/Opus, MP3, WAV, M4A…) to 16kHz mono float32.
    Uses ffmpeg subprocess — no Python audio libs needed."""
    cmd = [
        "ffmpeg",
        "-i", "pipe:0",         # stdin
        "-f", "f32le",           # raw float32 LE
        "-acodec", "pcm_f32le",
        "-ac", "1",              # mono
        "-ar", "16000",          # 16 kHz
        "-loglevel", "error",
        "pipe:1",                # stdout
    ]
    proc = subprocess.run(
        cmd,
        input=audio_bytes,
        capture_output=True,
        timeout=30,
    )
    if proc.returncode != 0:
        stderr_msg = proc.stderr.decode(errors="replace")[:500]
        raise RuntimeError(f"ffmpeg failed (rc={proc.returncode}): {stderr_msg}")

    audio_np = np.frombuffer(proc.stdout, dtype=np.float32)
    if len(audio_np) == 0:
        raise RuntimeError("ffmpeg produced empty audio output")

    return audio_np


class TranscribeReq(BaseModel):
    # base64-encoded audio bytes (OGG/Opus from Telegram, WAV, MP3 — любой формат ffmpeg)
    audio_base64: str
    # язык (default: russian — для этой fine-tuned модели)
    language: str = "russian"


@app.post("/transcribe")
def transcribe(req: TranscribeReq):
    """STT: audio → Whisper large-v3-russian → text.

    Модель живёт в CPU RAM, переезжает в VRAM на ~1 сек inference,
    потом обратно. Сериализуется через MODEL_LOCK с /embed и /rerank.
    """
    if WHISPER_DISABLED:
        raise HTTPException(status_code=503, detail="whisper disabled via RAS_WHISPER_DISABLED=1")

    t0 = time.perf_counter()

    # 1. Decode base64 → raw bytes
    try:
        audio_bytes = base64.b64decode(req.audio_base64)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"invalid base64: {e}")

    if len(audio_bytes) < 100:
        raise HTTPException(status_code=400, detail="audio too short (< 100 bytes)")

    # 2. Decode audio → 16kHz float32 numpy (через ffmpeg, вне GPU lock)
    try:
        audio_np = _decode_audio_to_numpy(audio_bytes)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"audio decode failed: {e}")

    duration_sec = len(audio_np) / 16000.0
    print(
        f"[whisper/req] audio_bytes={len(audio_bytes)} duration={duration_sec:.1f}s",
        flush=True,
    )

    if duration_sec > 120.0:
        raise HTTPException(
            status_code=400,
            detail=f"audio too long ({duration_sec:.0f}s > 120s max for search query)",
        )

    # 3. Mel-spectrogram вне GPU lock (чистый NumPy/CPU compute).
    input_features = whisper_processor(
        audio_np,
        sampling_rate=16000,
        return_tensors="pt",
    ).input_features.to(device, dtype=torch.float16)

    # 4. Generate под MODEL_LOCK — сериализуется с embed/rerank.
    # CUDA compute contention на V100 даёт 10x slowdown при параллельном inference,
    # поэтому сериализация быстрее чем параллельность.
    # Модель уже на GPU — нет transfer overhead.
    with model_guard("transcribe"):
        # Сброс фрагментированного CUDA-пула после embed батчей —
        # без этого generate 4x медленнее из-за allocator pressure.
        if device == "cuda":
            torch.cuda.empty_cache()
        with torch.inference_mode():
            # max_target_positions=448, decoder prefix = 4 tokens
            # (SOT + language + task + notimestamps) → max_new_tokens ≤ 444.
            predicted_ids = whisper_model.generate(
                input_features,
                language=req.language,
                task="transcribe",
                max_new_tokens=440,
            )

    text = whisper_processor.batch_decode(
        predicted_ids,
        skip_special_tokens=True,
    )[0].strip()

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    print(
        f"[whisper/done] text={text!r:.120} len={len(text)} "
        f"duration={duration_sec:.1f}s total_ms={elapsed_ms}",
        flush=True,
    )

    return {
        "text": text,
        "language": req.language,
        "duration_sec": round(duration_sec, 2),
        "elapsed_ms": elapsed_ms,
    }


# Eager load whisper to GPU at startup.
# 2.88 GB VRAM — бюджет: Jina ~7.4 + Reranker ~2 + Whisper ~2.88 = ~12.3 GB из 31.7.
if not WHISPER_DISABLED:
    _load_whisper_to_gpu()
else:
    print("[whisper] disabled via RAS_WHISPER_DISABLED=1", flush=True)
