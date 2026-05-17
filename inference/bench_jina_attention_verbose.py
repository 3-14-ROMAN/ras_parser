import os
import time
import subprocess
import torch
import torch.nn.functional as F
from transformers import AutoModel

MODE = os.environ.get("MODE", "xformers")
REPEAT = int(os.environ.get("REPEAT", "1000"))
TEXT_UNIT = "Судебный акт. Проверка индексации. "

T0 = time.time()

def ts():
    return f"{time.time() - T0:8.2f}s"

def log(msg):
    print(f"[{ts()}] {msg}", flush=True)

def gpu_mem(label):
    if not torch.cuda.is_available():
        log(f"{label}: cuda not available")
        return

    free, total = torch.cuda.mem_get_info()
    allocated = torch.cuda.memory_allocated()
    reserved = torch.cuda.memory_reserved()
    peak = torch.cuda.max_memory_allocated()

    log(
        f"{label}: "
        f"free={free/1024**3:.2f}GB "
        f"total={total/1024**3:.2f}GB "
        f"allocated={allocated/1024**3:.2f}GB "
        f"reserved={reserved/1024**3:.2f}GB "
        f"peak={peak/1024**3:.2f}GB"
    )

def nvidia_smi(label):
    try:
        out = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-compute-apps=pid,process_name,used_memory",
                "--format=csv,noheader,nounits",
            ],
            text=True,
        ).strip()
        log(f"{label}: nvidia-smi processes:")
        if out:
            for line in out.splitlines():
                log(f"  {line}")
        else:
            log("  no compute processes")
    except Exception as e:
        log(f"{label}: nvidia-smi failed: {repr(e)}")

stats = {
    "sdpa_calls": 0,
    "xformers_calls": 0,
    "fallback_calls": 0,
    "first_attention_time": None,
    "last_attention_time": None,
}

if MODE == "xformers":
    from xformers.ops import memory_efficient_attention, LowerTriangularMask

    orig_sdpa = F.scaled_dot_product_attention

    def patched_sdpa(query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False, scale=None, enable_gqa=False):
        stats["sdpa_calls"] += 1
        stats["last_attention_time"] = time.time()

        if stats["first_attention_time"] is None:
            stats["first_attention_time"] = time.time()

        call_n = stats["sdpa_calls"]

        if call_n <= 3 or call_n % 6 == 0:
            log(
                f"attention call={call_n} "
                f"q_shape={tuple(query.shape)} "
                f"q_dtype={query.dtype} "
                f"mask={'none' if attn_mask is None else tuple(attn_mask.shape)} "
                f"causal={is_causal} "
                f"gqa={enable_gqa}"
            )
            gpu_mem(f"before attention call={call_n}")

        try:
            if enable_gqa:
                raise RuntimeError("enable_gqa not supported")

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

            stats["xformers_calls"] += 1

            result = out.transpose(1, 2).contiguous().to(query.dtype)

            if call_n <= 3 or call_n % 6 == 0:
                gpu_mem(f"after xformers call={call_n}")

            return result

        except Exception as e:
            stats["fallback_calls"] += 1
            log(f"xformers fallback call={call_n}: {repr(e)}")

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

    F.scaled_dot_product_attention = patched_sdpa

else:
    orig_sdpa = F.scaled_dot_product_attention

    def wrapped_sdpa(*args, **kwargs):
        stats["sdpa_calls"] += 1
        stats["last_attention_time"] = time.time()

        if stats["first_attention_time"] is None:
            stats["first_attention_time"] = time.time()

        q = args[0]
        call_n = stats["sdpa_calls"]

        if call_n <= 3 or call_n % 6 == 0:
            log(
                f"sdpa call={call_n} "
                f"q_shape={tuple(q.shape)} "
                f"q_dtype={q.dtype}"
            )
            gpu_mem(f"before sdpa call={call_n}")

        return orig_sdpa(*args, **kwargs)

    F.scaled_dot_product_attention = wrapped_sdpa

log("===== BENCH START =====")
log(f"mode={MODE}")
log(f"repeat={REPEAT}")
log(f"torch={torch.__version__}")
log(f"cuda_available={torch.cuda.is_available()}")

if torch.cuda.is_available():
    log(f"gpu={torch.cuda.get_device_name(0)}")
    log(f"capability={torch.cuda.get_device_capability(0)}")
    log(f"torch_cuda={torch.version.cuda}")

nvidia_smi("start")
gpu_mem("start")

log("loading model...")

load_t0 = time.time()

m = AutoModel.from_pretrained(
    "jinaai/jina-embeddings-v4",
    trust_remote_code=True,
    dtype=torch.float16,
).to("cuda").eval()

m.half()

torch.cuda.synchronize()

log(f"model loaded in {time.time() - load_t0:.2f}s")
log(f"param_dtype={next(m.parameters()).dtype}")

base = m.base_model.model if hasattr(m, "base_model") else m
log(f"attn_config={getattr(base.config, '_attn_implementation', None)}")

gpu_mem("after model load")
nvidia_smi("after model load")

text = TEXT_UNIT * REPEAT

log(f"text chars={len(text)}")
log(f"text unit chars={len(TEXT_UNIT)}")
log("clearing cuda cache...")

torch.cuda.empty_cache()
torch.cuda.reset_peak_memory_stats()

gpu_mem("before encode")

encode_t0 = time.time()

try:
    log("encode_text start...")

    with torch.inference_mode():
        r = m.encode_text(
            texts=[text],
            task="retrieval",
            return_multivector=True,
        )

    torch.cuda.synchronize()

    encode_sec = time.time() - encode_t0
    x = r[0]

    log("encode_text done")
    gpu_mem("after encode")

    log("===== RESULT OK =====")
    log(f"shape={tuple(x.shape)}")
    log(f"colbert_tokens={x.shape[0]}")
    log(f"dim={x.shape[1] if len(x.shape) > 1 else 'unknown'}")
    log(f"out_dtype={x.dtype}")
    log(f"encode_seconds={encode_sec:.2f}")
    log(f"total_seconds={time.time() - T0:.2f}")
    log(f"sdpa_calls={stats['sdpa_calls']}")
    log(f"xformers_calls={stats['xformers_calls']}")
    log(f"fallback_calls={stats['fallback_calls']}")

    if stats["first_attention_time"] is not None:
        log(f"time_to_first_attention={stats['first_attention_time'] - encode_t0:.2f}s")
        log(f"last_attention_at={stats['last_attention_time'] - encode_t0:.2f}s")

    log("===== BENCH END =====")

except torch.cuda.OutOfMemoryError as e:
    torch.cuda.synchronize()

    log("===== RESULT CUDA OOM =====")
    gpu_mem("after oom")
    nvidia_smi("after oom")
    log(f"seconds_before_oom={time.time() - encode_t0:.2f}")
    log(f"total_seconds={time.time() - T0:.2f}")
    log(f"sdpa_calls={stats['sdpa_calls']}")
    log(f"xformers_calls={stats['xformers_calls']}")
    log(f"fallback_calls={stats['fallback_calls']}")
    log(f"error={str(e).splitlines()[0]}")
    raise SystemExit(42)

except Exception as e:
    torch.cuda.synchronize()

    log("===== RESULT ERROR =====")
    gpu_mem("after error")
    nvidia_smi("after error")
    log(f"seconds_before_error={time.time() - encode_t0:.2f}")
    log(f"total_seconds={time.time() - T0:.2f}")
    log(f"sdpa_calls={stats['sdpa_calls']}")
    log(f"xformers_calls={stats['xformers_calls']}")
    log(f"fallback_calls={stats['fallback_calls']}")
    log(f"error={repr(e)}")
    raise SystemExit(1)
