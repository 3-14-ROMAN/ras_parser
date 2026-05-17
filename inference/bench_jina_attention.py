import os
import time
import torch
import torch.nn.functional as F
from transformers import AutoModel

MODE = os.environ.get("MODE", "sdpa")
REPEAT = int(os.environ.get("REPEAT", "1000"))

stats = {"xformers": 0, "fallback": 0}

if MODE == "xformers":
    from xformers.ops import memory_efficient_attention, LowerTriangularMask

    orig_sdpa = F.scaled_dot_product_attention

    def xformers_sdpa(query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False, scale=None, enable_gqa=False):
        try:
            if enable_gqa:
                raise RuntimeError("enable_gqa not supported")

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

            stats["xformers"] += 1
            return out.transpose(1, 2).contiguous().to(query.dtype)

        except Exception as e:
            stats["fallback"] += 1
            if stats["fallback"] <= 3:
                print("fallback:", repr(e), flush=True)

            return orig_sdpa(
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

print("mode:", MODE, flush=True)
print("repeat:", REPEAT, flush=True)

m = AutoModel.from_pretrained(
    "jinaai/jina-embeddings-v4",
    trust_remote_code=True,
    dtype=torch.float16,
).to("cuda").eval()

m.half()

text = "Судебный акт. Проверка индексации. " * REPEAT

print("chars:", len(text), flush=True)
print("param_dtype:", next(m.parameters()).dtype, flush=True)

torch.cuda.empty_cache()
torch.cuda.reset_peak_memory_stats()

t0 = time.time()

try:
    with torch.inference_mode():
        r = m.encode_text(
            texts=[text],
            task="retrieval",
            return_multivector=True,
        )

    torch.cuda.synchronize()

    x = r[0]

    print("status: ok", flush=True)
    print("shape:", tuple(x.shape), flush=True)
    print("colbert_tokens:", x.shape[0], flush=True)
    print("out_dtype:", x.dtype, flush=True)
    print("seconds:", round(time.time() - t0, 2), flush=True)
    print("peak_gb:", round(torch.cuda.max_memory_allocated() / 1024**3, 2), flush=True)
    print("xformers_calls:", stats["xformers"], flush=True)
    print("fallback_calls:", stats["fallback"], flush=True)

except torch.cuda.OutOfMemoryError as e:
    torch.cuda.synchronize()
    print("status: CUDA_OOM", flush=True)
    print("seconds:", round(time.time() - t0, 2), flush=True)
    print("peak_gb:", round(torch.cuda.max_memory_allocated() / 1024**3, 2), flush=True)
    print("error:", str(e).splitlines()[0], flush=True)
    raise SystemExit(42)

except Exception as e:
    torch.cuda.synchronize()
    print("status: ERROR", flush=True)
    print("seconds:", round(time.time() - t0, 2), flush=True)
    print("peak_gb:", round(torch.cuda.max_memory_allocated() / 1024**3, 2), flush=True)
    print("error:", repr(e), flush=True)
    raise SystemExit(1)
