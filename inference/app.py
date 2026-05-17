import time
import numpy as np
import torch
import torch.nn.functional as F
from fastapi import FastAPI
from pydantic import BaseModel
from typing import List
from transformers import AutoModel
from fastembed.postprocess import Muvera


app = FastAPI()

device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.float16 if device == "cuda" else torch.float32

muvera = Muvera(dim=128)

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

print("Embedding модель в памяти. Реранкер отключен.")


class EmbedReq(BaseModel):
    texts: List[str]
    task: str = "retrieval.passage"


@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": device,
        "cuda_available": torch.cuda.is_available(),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "reranker": "disabled",
        "xformers_enabled": XFORMERS_ENABLED,
        "xformers_stats": XFORMERS_STATS,
        "torch": torch.__version__,
        "torch_cuda": torch.version.cuda,
    }


@app.post("/embed")
def embed(req: EmbedReq):
    t0 = time.perf_counter()
    prompt_name = "query" if req.task == "retrieval.query" else "passage"

    before_calls = dict(XFORMERS_STATS)

    if device == "cuda":
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

    with torch.inference_mode():
        outputs = embed_model.encode_text(
            texts=req.texts,
            task="retrieval",
            prompt_name=prompt_name,
            return_multivector=True,
        )

    if device == "cuda":
        torch.cuda.synchronize()

    t1 = time.perf_counter()

    multivectors = [tensor.tolist() for tensor in outputs]

    t2 = time.perf_counter()

    muvera_vectors = [
        muvera.process_document(np.array(mv, dtype=np.float32)).tolist()
        for mv in multivectors
    ]

    t3 = time.perf_counter()

    token_counts = [len(mv) for mv in multivectors]

    after_calls = dict(XFORMERS_STATS)

    if device == "cuda":
        peak_gb = torch.cuda.max_memory_allocated() / 1024**3
    else:
        peak_gb = 0

    print(
        f"[embed_timing] texts={len(req.texts)} tokens={token_counts} "
        f"model_ms={(t1-t0)*1000:.0f} "
        f"tolist_ms={(t2-t1)*1000:.0f} "
        f"muvera_ms={(t3-t2)*1000:.0f} "
        f"prepare_total_ms={(t3-t0)*1000:.0f} "
        f"peak_gb={peak_gb:.2f} "
        f"xformers_calls_delta={after_calls['xformers_calls'] - before_calls['xformers_calls']} "
        f"fallback_calls_delta={after_calls['fallback_calls'] - before_calls['fallback_calls']}",
        flush=True,
    )

    return {
        "multivectors": multivectors,
        "muvera_vectors": muvera_vectors,
    }


class LateChunksReq(BaseModel):
    chunks: List[str]
    task: str = "retrieval.passage"
    max_length: int = 32768
    separator: str = "\n\n"
    return_multivectors: bool = False


@app.post("/embed_late_chunks")
def embed_late_chunks(req: LateChunksReq):
    t0 = time.perf_counter()

    if not req.chunks:
        return {
            "error": "empty_chunks",
            "muvera_vectors": [],
            "token_counts": [],
            "spans": [],
        }

    prompt_name = "query" if req.task == "retrieval.query" else "passage"
    task_label = "retrieval" if req.task.startswith("retrieval") else req.task

    full_text = ""
    spans = []

    for i, chunk in enumerate(req.chunks):
        if i > 0:
            full_text += req.separator

        start = len(full_text)
        full_text += chunk
        end = len(full_text)

        spans.append([start, end])

    tokenizer = getattr(embed_model.processor, "tokenizer", None)

    if tokenizer is None:
        return {
            "error": "processor_tokenizer_not_found",
            "processor_type": str(type(embed_model.processor)),
        }

    encode_kwargs = embed_model._validate_encoding_params(
        truncate_dim=None,
        prompt_name=prompt_name,
    )

    prefix = encode_kwargs.get("prefix", "") or ""
    tokenized_text = prefix + full_text
    prefix_len = len(prefix)

    offsets_enc = tokenizer(
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
            "tokenizer_type": str(type(tokenizer)),
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
    mv = mv.detach().float().cpu()

    token_len = min(len(offsets), mv.shape[0])

    if abs(len(offsets) - mv.shape[0]) > 8:
        return {
            "error": "token_alignment_mismatch",
            "offset_tokens": len(offsets),
            "embedding_tokens": int(mv.shape[0]),
            "prefix_len": prefix_len,
            "full_chars": len(full_text),
        }

    muvera_vectors = []
    token_counts = []
    chunk_multivectors = []

    for start, end in spans:
        token_indexes = []

        for ti, pair in enumerate(offsets[:token_len]):
            a, b = int(pair[0]), int(pair[1])

            if b <= a:
                continue

            a -= prefix_len
            b -= prefix_len

            if b <= 0 or a >= len(full_text):
                continue

            if max(a, start) < min(b, end):
                token_indexes.append(ti)

        if not token_indexes:
            token_indexes = [0]

        chunk_mv = mv[token_indexes].numpy().astype(np.float32)

        muvera_vectors.append(
            muvera.process_document(chunk_mv).tolist()
        )

        token_counts.append(len(token_indexes))

        if req.return_multivectors:
            chunk_multivectors.append(chunk_mv.tolist())

    after_calls = dict(XFORMERS_STATS)

    if device == "cuda":
        peak_gb = torch.cuda.max_memory_allocated() / 1024**3
    else:
        peak_gb = 0

    t1 = time.perf_counter()

    print(
        f"[late_chunks_timing] chunks={len(req.chunks)} "
        f"full_tokens={int(mv.shape[0])} "
        f"chunk_tokens={token_counts} "
        f"total_ms={(t1-t0)*1000:.0f} "
        f"peak_gb={peak_gb:.2f} "
        f"xformers_calls_delta={after_calls['xformers_calls'] - before_calls['xformers_calls']} "
        f"fallback_calls_delta={after_calls['fallback_calls'] - before_calls['fallback_calls']}",
        flush=True,
    )

    resp = {
        "muvera_vectors": muvera_vectors,
        "token_counts": token_counts,
        "spans": spans,
        "full_tokens": int(mv.shape[0]),
        "full_chars": len(full_text),
    }

    if req.return_multivectors:
        resp["multivectors"] = chunk_multivectors

    return resp

