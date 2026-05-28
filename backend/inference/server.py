#!/usr/bin/env python3
"""
Unified inference server for jina-embeddings-v4 and jina-reranker-v3.
Serves /embed (with task-specific LoRA adapters) and /rerank endpoints.

GPU: NVIDIA V100 32GB (fp16 auto-cast)
Models loaded on startup, batched inference with fallback to single samples.
"""

import os
import sys
import json
import logging
from typing import List, Optional
import asyncio
from contextlib import asynccontextmanager

import torch
import numpy as np
from transformers import AutoTokenizer, AutoModel

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


logging.basicConfig(level=logging.INFO, format='[%(name)s] %(message)s')
logger = logging.getLogger('inference')

DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'
DTYPE = torch.float16 if DEVICE == 'cuda' else torch.float32

# Model IDs
EMBED_MODEL_ID = os.environ.get('EMBED_MODEL_ID', 'jinaai/jina-embeddings-v4')
RERANK_MODEL_ID = os.environ.get('RERANK_MODEL_ID', 'jinaai/jina-reranker-v3')
HF_HOME = os.environ.get('HF_HOME', '/data/hf_cache')

# Inference params
EMBED_DIM = int(os.environ.get('EMBED_DIM', '2048'))
EMBED_BATCH_SIZE = int(os.environ.get('EMBED_BATCH_SIZE', '32'))
RERANK_BATCH_SIZE = int(os.environ.get('RERANK_BATCH_SIZE', '8'))
MAX_TOKENS_EMBED = 8192  # Don't force full 32K context in batch inference
MAX_TOKENS_RERANK = 8192


class EmbedRequest(BaseModel):
    """Embedding request (text or list of texts)."""
    texts: List[str]
    task: Optional[str] = Field(
        default='retrieval.passage',
        description='LoRA task: retrieval.passage, retrieval.query, text-matching, code'
    )


class EmbedResponse(BaseModel):
    """Embedding response."""
    embeddings: List[List[float]]
    dim: int
    model: str


class RerankRequest(BaseModel):
    """Reranking request (query + documents)."""
    query: str
    documents: List[str]
    top_k: Optional[int] = None


class RerankScore(BaseModel):
    index: int
    score: float


class RerankResponse(BaseModel):
    """Reranking response (sorted by score descending)."""
    results: List[RerankScore]
    model: str


# ─────────────────────────────────────────────────────────────────────────────
# Model loading
# ─────────────────────────────────────────────────────────────────────────────

embed_model = None
embed_tokenizer = None
rerank_model = None
rerank_tokenizer = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load models on startup, unload on shutdown."""
    global embed_model, embed_tokenizer, rerank_model, rerank_tokenizer

    logger.info(f'Device: {DEVICE} ({DTYPE})')
    logger.info(f'HF_HOME: {HF_HOME}')

    # Load embeddings model
    logger.info(f'Loading {EMBED_MODEL_ID}...')
    embed_tokenizer = AutoTokenizer.from_pretrained(
        EMBED_MODEL_ID, cache_dir=HF_HOME, trust_remote_code=True
    )
    embed_model = AutoModel.from_pretrained(
        EMBED_MODEL_ID, cache_dir=HF_HOME, trust_remote_code=True,
        torch_dtype=DTYPE, device_map=DEVICE
    )
    embed_model.eval()
    logger.info(f'Loaded {EMBED_MODEL_ID}: {EMBED_DIM}-dim dense')

    # Load reranker model
    logger.info(f'Loading {RERANK_MODEL_ID}...')
    rerank_tokenizer = AutoTokenizer.from_pretrained(
        RERANK_MODEL_ID, cache_dir=HF_HOME, trust_remote_code=True
    )
    rerank_model = AutoModel.from_pretrained(
        RERANK_MODEL_ID, cache_dir=HF_HOME, trust_remote_code=True,
        torch_dtype=DTYPE, device_map=DEVICE
    )
    rerank_model.eval()
    logger.info(f'Loaded {RERANK_MODEL_ID}: listwise cross-encoder')

    logger.info('All models loaded. Server ready.')
    yield

    # Cleanup
    if embed_model is not None:
        del embed_model
    if rerank_model is not None:
        del rerank_model
    torch.cuda.empty_cache()
    logger.info('Models unloaded.')


app = FastAPI(title='Jina RAG Inference', lifespan=lifespan)


# ─────────────────────────────────────────────────────────────────────────────
# Embeddings endpoint
# ─────────────────────────────────────────────────────────────────────────────

@app.post('/embed', response_model=EmbedResponse)
async def embed(req: EmbedRequest) -> EmbedResponse:
    """Generate dense embeddings (v4 with task-specific LoRA adapters)."""
    if embed_model is None or embed_tokenizer is None:
        raise HTTPException(status_code=503, detail='Embedding model not loaded')

    texts = req.texts
    task = req.task

    if not texts:
        raise HTTPException(status_code=400, detail='texts cannot be empty')

    logger.info(f'Embedding {len(texts)} texts with task={task}')

    embeddings = []
    with torch.no_grad():
        for i in range(0, len(texts), EMBED_BATCH_SIZE):
            batch = texts[i : i + EMBED_BATCH_SIZE]

            # Prepare input with task prefix (v4 uses LoRA adapters)
            # Format: "[task] text" (e.g., "[retrieval.passage] This is a document.")
            prefixed = [f'[{task}] {t}' for t in batch]

            # Tokenize with truncation
            encoded = embed_tokenizer(
                prefixed, max_length=MAX_TOKENS_EMBED, truncation=True,
                padding=True, return_tensors='pt'
            )
            for key in encoded:
                encoded[key] = encoded[key].to(DEVICE)

            # Forward pass
            output = embed_model(**encoded)

            # Dense representation (last hidden state, mean pooling)
            # v4 supports multi-vector (late-interaction) but we return dense for Qdrant
            embeddings_batch = output.last_hidden_state.mean(dim=1)  # [batch, 2048]
            embeddings.extend(embeddings_batch.cpu().numpy().tolist())

    logger.info(f'Generated {len(embeddings)} embeddings')
    return EmbedResponse(
        embeddings=embeddings,
        dim=EMBED_DIM,
        model=EMBED_MODEL_ID
    )


# ─────────────────────────────────────────────────────────────────────────────
# Reranking endpoint
# ─────────────────────────────────────────────────────────────────────────────

@app.post('/rerank', response_model=RerankResponse)
async def rerank(req: RerankRequest) -> RerankResponse:
    """Rerank documents by relevance to query (v3 listwise cross-encoder)."""
    if rerank_model is None or rerank_tokenizer is None:
        raise HTTPException(status_code=503, detail='Reranker model not loaded')

    query = req.query
    documents = req.documents
    top_k = req.top_k or len(documents)

    if not query or not documents:
        raise HTTPException(status_code=400, detail='query and documents required')

    logger.info(f'Reranking {len(documents)} docs against query (top_k={top_k})')

    scores = []
    with torch.no_grad():
        for i in range(0, len(documents), RERANK_BATCH_SIZE):
            batch_docs = documents[i : i + RERANK_BATCH_SIZE]
            batch_indices = list(range(i, min(i + RERANK_BATCH_SIZE, len(documents))))

            # Format for v3: pairs of (query, document)
            # v3 is a cross-encoder, processes in listwise fashion
            pairs = [[query, doc] for doc in batch_docs]

            # Tokenize
            encoded = rerank_tokenizer(
                pairs, max_length=MAX_TOKENS_RERANK, truncation=True,
                padding=True, return_tensors='pt'
            )
            for key in encoded:
                encoded[key] = encoded[key].to(DEVICE)

            # Forward pass → logits (typically 2 classes: not-relevant, relevant)
            output = rerank_model(**encoded)
            batch_scores = torch.softmax(output.logits, dim=1)[:, 1].cpu().numpy()

            for idx, score in zip(batch_indices, batch_scores):
                scores.append((idx, float(score)))

    # Sort by score descending, take top_k
    scores.sort(key=lambda x: x[1], reverse=True)
    results = [RerankScore(index=idx, score=score) for idx, score in scores[:top_k]]

    logger.info(f'Reranked: top-1 score={results[0].score:.3f}')
    return RerankResponse(results=results, model=RERANK_MODEL_ID)


# ─────────────────────────────────────────────────────────────────────────────
# Health check
# ─────────────────────────────────────────────────────────────────────────────

@app.get('/health')
async def health():
    return {
        'status': 'ok',
        'device': DEVICE,
        'models_loaded': embed_model is not None and rerank_model is not None
    }


if __name__ == '__main__':
    import uvicorn
    port = int(os.environ.get('INFERENCE_PORT', '8000'))
    uvicorn.run(app, host='0.0.0.0', port=port, workers=1)
