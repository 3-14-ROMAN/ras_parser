import os
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

rerank_model = None
rerank_load_error: Optional[str] = None

if RERANKER_DISABLED:
    print("[rerank] disabled via RAS_RERANKER_DISABLED=1", flush=True)
else:
    print(f"[rerank] loading {RERANKER_MODEL_ID} ...", flush=True)
    _t_rerank = time.perf_counter()
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
        print(
            f"[rerank] ready model={RERANKER_MODEL_ID} "
            f"dtype={dtype} device={device} "
            f"max_doc={RERANKER_MAX_DOC_LENGTH} max_query={RERANKER_MAX_QUERY_LENGTH} "
            f"loaded_in={(time.perf_counter() - _t_rerank):.1f}s",
            flush=True,
        )
    except Exception as e:
        rerank_load_error = repr(e)
        rerank_model = None
        print(
            f"[rerank] LOAD FAILED model={RERANKER_MODEL_ID}: {rerank_load_error}",
            flush=True,
        )


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
    elif rerank_model is not None:
        reranker_status = "ready"
    else:
        reranker_status = f"load_failed:{rerank_load_error}"
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
    }


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
    # Если chunks не переданы, сервер сам строит token-aware chunks
    # примерно по target_chunk_tokens content-токенов.
    chunks: Optional[List[ChunkSpan]] = None

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

    def build_token_chunks() -> List[ChunkSpan]:
        target = int(req.target_chunk_tokens or 2000)
        if target < 256:
            target = 256

        toks = content_token_offsets()
        if not toks:
            return [ChunkSpan(chunk_id=0, start_char=0, end_char=text_len)]

        chunks_out: List[ChunkSpan] = []
        start_char = 0
        chunk_id = 0

        for i in range(0, len(toks), target):
            group = toks[i:i + target]
            if not group:
                continue

            end_char = group[-1][2]
            if i + target >= len(toks):
                end_char = text_len

            if end_char <= start_char:
                continue

            chunks_out.append(
                ChunkSpan(
                    chunk_id=chunk_id,
                    start_char=int(start_char),
                    end_char=int(end_char),
                )
            )
            chunk_id += 1
            start_char = end_char

        if chunks_out and chunks_out[-1].end_char < text_len:
            chunks_out[-1].end_char = text_len

        return chunks_out

    chunks = explicit_chunks if explicit_chunks else build_token_chunks()
    chunk_mode = "explicit" if explicit_chunks else "token_auto"

    t_pool0 = time.perf_counter()
    dense_late_vectors: List[List[float]] = []
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
        f"[late_chunks_timing] mode={chunk_mode} target_chunk_tokens={req.target_chunk_tokens} "
        f"chunks={len(chunks)} full_chars={text_len} real_tokens={real_token_count} "
        f"emb_tokens={int(n_emb_tokens)} chunk_tokens={token_counts} "
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
        "target_chunk_tokens": int(req.target_chunk_tokens or 2000),
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

    return out


# ─────────────────────────────────────────────────────────────────────────────
# /count_tokens — подсчёт токенов через reranker-v3 tokenizer (Qwen3).
# Используется pdf-pipeline на этапе markTextExtracted: после скачивания
# текста сразу считаем сколько он стоит в токенах для реранкера, чтобы
# знать укладывается ли в RERANKER_MAX_DOC_LENGTH без обрезки.
#
# Считаем БЕЗ special tokens — так же как реальный /rerank режет в
# rerank_tok(...) выше (add_special_tokens=False). Это сравнимо напрямую
# с max_doc_length, который тоже считает content tokens.
# ─────────────────────────────────────────────────────────────────────────────

class CountTokensReq(BaseModel):
    text: str


@app.post("/count_tokens")
def count_tokens(req: CountTokensReq):
    with model_guard("count_tokens"):
        return _count_tokens_impl(req)


def _count_tokens_impl(req: CountTokensReq):
    if rerank_model is None:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "reranker_unavailable",
                "reason": (
                    "disabled_via_env"
                    if RERANKER_DISABLED
                    else f"load_failed:{rerank_load_error}"
                ),
                "model_id": RERANKER_MODEL_ID,
            },
        )
    rerank_model._ensure_tokenizer()
    text = req.text or ""
    if not text:
        return {
            "token_count": 0,
            "model_id": RERANKER_MODEL_ID,
            "add_special_tokens": False,
        }
    ids = rerank_model._tokenizer(
        text,
        add_special_tokens=False,
        truncation=False,
        return_attention_mask=False,
    )["input_ids"]
    return {
        "token_count": len(ids),
        "model_id": RERANKER_MODEL_ID,
        "add_special_tokens": False,
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
    # Первое действие: выгружаем embedding из VRAM, чтобы reranker'у было
    # просторнее (особенно на V100 с длинными контекстами). reranker не трогаем.
    unload_embedding_before_rerank()

    if rerank_model is None:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "reranker_unavailable",
                "reason": (
                    "disabled_via_env"
                    if RERANKER_DISABLED
                    else f"load_failed:{rerank_load_error}"
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
