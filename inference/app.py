import os
import time
from collections import Counter
from typing import List, Optional

import numpy as np
import torch
import torch.nn.functional as F
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import AutoModel, AutoTokenizer


app = FastAPI()

device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.float16 if device == "cuda" else torch.float32

XFORMERS_ENABLED = False
XFORMERS_STATS = {
    "sdpa_calls": 0,
    "xformers_calls": 0,
    "fallback_calls": 0,
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
                raise RuntimeError("enable_gqa not supported by this xFormers patch")

            # PyTorch SDPA: [B, H, T, D]
            # xFormers:    [B, T, H, D]
            q = query.transpose(1, 2).contiguous().to(torch.float16)
            k = key.transpose(1, 2).contiguous().to(torch.float16)
            v = value.transpose(1, 2).contiguous().to(torch.float16)

            attn_bias = LowerTriangularMask() if is_causal else attn_mask

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

print(f"Грузим Jina embeddings на {device} ({dtype})...")

embed_model = AutoModel.from_pretrained(
    "jinaai/jina-embeddings-v4",
    trust_remote_code=True,
    dtype=dtype,
    attn_implementation="sdpa",
).to(device)

if device == "cuda":
    embed_model.half()

embed_model.eval()

# Кэшируем tokenizer и набор спец-id'шек один раз. Для sparse мы их
# выкидываем (CLS / SEP / PAD / BOS / EOS / image-токены и т.п.).
_TOKENIZER = embed_model.processor.tokenizer
_SPECIAL_TOKEN_IDS = set(getattr(_TOKENIZER, "all_special_ids", []) or [])

print(
    f"Embedding модель в памяти. tokenizer={type(_TOKENIZER).__name__} "
    f"special_ids={len(_SPECIAL_TOKEN_IDS)}."
)


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
        "xformers_enabled": XFORMERS_ENABLED,
        "xformers_stats": XFORMERS_STATS,
        "torch": torch.__version__,
        "torch_cuda": torch.version.cuda,
    }


@app.post("/embed")
def embed(req: EmbedReq):
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

    before_calls = dict(XFORMERS_STATS)

    if device == "cuda":
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

    with torch.inference_mode():
        mv_outputs = embed_model.encode_text(
            texts=req.texts,
            task="retrieval",
            prompt_name=prompt_name,
            return_multivector=True,
        )
        dense_outputs = embed_model.encode_text(
            texts=req.texts,
            task="retrieval",
            prompt_name=prompt_name,
            return_multivector=False,
        )

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


class LateChunksReq(BaseModel):
    chunks: List[str]
    task: str = "retrieval.passage"
    max_length: int = 32768
    separator: str = "\n\n"
    return_sparse: bool = True


@app.post("/embed_late_chunks")
def embed_late_chunks(req: LateChunksReq):
    """
    Real late chunking для длинных актов.

    Идея (Jina blog «Late Chunking»): сначала энкодим ВЕСЬ документ одним
    forward pass'ом, чтобы каждый token-embedding нёс long-range context.
    Потом для каждого чанка усредняем embedding'и его токенов — получается
    128-dim вектор (multivector у Jina v4 = 128 per token), но с
    document-level awareness, которой не было бы у naive chunk-wise encoding.

    Возвращает:
      dense_late_vectors[i] — 128-dim mean-pool токенов чанка i
      sparse_vectors[i]     — sparse TF-вектор чанка (отдельно по чанк-тексту,
                              т.к. в чанке свои term frequencies; IDF Qdrant
                              посчитает сам)
      token_counts[i]       — фактическое число токенов чанка i
      spans[i]              — [start_char, end_char] чанка в full_text
      full_tokens           — сколько токенов вошло в forward pass

    Schema-нота: dense_late у нас 128-dim (не 2048!) — это размерность
    multivector у Jina v4. Qdrant-коллекция в `qdrant-rebuild-collection.js`
    создаёт `dense_late: size=128`.
    """
    t0 = time.perf_counter()

    if not req.chunks:
        return {
            "error": "empty_chunks",
            "dense_late_vectors": [],
            "sparse_vectors": [],
            "token_counts": [],
            "spans": [],
        }

    prompt_name = "query" if req.task == "retrieval.query" else "passage"
    task_label = "retrieval" if req.task.startswith("retrieval") else req.task

    # Собираем full_text + запоминаем char-спаны каждого чанка.
    full_text = ""
    spans = []
    for i, chunk in enumerate(req.chunks):
        if i > 0:
            full_text += req.separator
        start = len(full_text)
        full_text += chunk
        end = len(full_text)
        spans.append([start, end])

    # Префикс, который модель добавит при encode_text (Jina v4 ставит
    # короткий prompt-prefix для retrieval). Нужно учитывать длину префикса
    # при сравнении char-offsets с full_text.
    encode_kwargs = embed_model._validate_encoding_params(
        truncate_dim=None,
        prompt_name=prompt_name,
    )
    prefix = encode_kwargs.get("prefix", "") or ""
    prefix_len = len(prefix)
    tokenized_text = prefix + full_text

    offsets_enc = _TOKENIZER(
        tokenized_text,
        add_special_tokens=True,
        return_offsets_mapping=True,
        truncation=True,
        max_length=req.max_length,
    )
    offsets = offsets_enc.get("offset_mapping")
    if offsets is None:
        return {
            "error": "offset_mapping_not_available",
            "tokenizer_type": str(type(_TOKENIZER)),
        }

    before_calls = dict(XFORMERS_STATS)

    if device == "cuda":
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

    with torch.inference_mode():
        outputs = embed_model.encode_text(
            texts=[full_text],
            task=task_label,
            prompt_name=prompt_name,
            max_length=req.max_length,
            batch_size=1,
            return_multivector=True,
        )

    if device == "cuda":
        torch.cuda.synchronize()

    mv = outputs[0] if isinstance(outputs, list) else outputs
    mv = mv.detach().float().cpu().numpy()  # [n_tokens, 128]
    n_emb_tokens = mv.shape[0]

    # offsets и mv могут немного расходиться на 2–3 токена из-за того, как
    # модель режет input (специальные токены). Используем min из двух.
    token_len = min(len(offsets), n_emb_tokens)
    if abs(len(offsets) - n_emb_tokens) > 8:
        return {
            "error": "token_alignment_mismatch",
            "offset_tokens": len(offsets),
            "embedding_tokens": int(n_emb_tokens),
            "prefix_len": prefix_len,
            "full_chars": len(full_text),
        }

    dense_late_vectors = []
    token_counts = []
    for start, end in spans:
        token_indexes = []
        for ti, pair in enumerate(offsets[:token_len]):
            a, b = int(pair[0]), int(pair[1])
            if b <= a:
                continue
            # offsets — в координатах prefix+full_text; снимаем prefix.
            a -= prefix_len
            b -= prefix_len
            if b <= 0 or a >= len(full_text):
                continue
            # Если token-span пересекается с chunk-span — token принадлежит чанку.
            if max(a, start) < min(b, end):
                token_indexes.append(ti)

        if not token_indexes:
            # Защита от пустых чанков (в идеале не должно случиться,
            # но если чанк состоял из одних спецсимволов — берём token 0).
            token_indexes = [0]

        chunk_mv = mv[token_indexes]              # [m, 128]
        pooled = chunk_mv.mean(axis=0)            # [128]
        dense_late_vectors.append(pooled.tolist())
        token_counts.append(len(token_indexes))

    sparse_vectors: Optional[list] = None
    if req.return_sparse:
        sparse_vectors = [_sparse_from_text(c) for c in req.chunks]

    after_calls = dict(XFORMERS_STATS)
    if device == "cuda":
        peak_gb = torch.cuda.max_memory_allocated() / 1024**3
    else:
        peak_gb = 0

    t1 = time.perf_counter()
    print(
        f"[late_chunks_timing] chunks={len(req.chunks)} "
        f"full_tokens={int(n_emb_tokens)} "
        f"chunk_tokens={token_counts} "
        f"total_ms={(t1-t0)*1000:.0f} "
        f"sparse={'on' if req.return_sparse else 'off'} "
        f"peak_gb={peak_gb:.2f} "
        f"xformers_calls_delta={after_calls['xformers_calls'] - before_calls['xformers_calls']} "
        f"fallback_calls_delta={after_calls['fallback_calls'] - before_calls['fallback_calls']}",
        flush=True,
    )

    out = {
        "dense_late_vectors": dense_late_vectors,
        "token_counts": token_counts,
        "spans": spans,
        "full_tokens": int(n_emb_tokens),
        "full_chars": len(full_text),
    }
    if sparse_vectors is not None:
        out["sparse_vectors"] = sparse_vectors
    return out


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
            documents=[doc or "" for doc in req.documents],
            top_n=None,                # сорт сделаем уже на нашей стороне
            return_embeddings=False,
            max_doc_length=max_doc,
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
