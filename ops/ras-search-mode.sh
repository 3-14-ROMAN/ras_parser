#!/usr/bin/env bash
#
# scripts/ras-search-mode.sh — переключатель между indexing-mode и search-mode.
#
# Indexing-mode (default): reranker выгружен (~1.5 GB VRAM свободно),
#   embed-worker гонит batch до 32k токенов.
# Search-mode: reranker загружен, embed-worker батчит до 16k токенов (запас
#   VRAM на reranker).
#
# Использование:
#   ./scripts/ras-search-mode.sh on    # включить reranker (для поиска)
#   ./scripts/ras-search-mode.sh off   # выгрузить (для индексации)
#   ./scripts/ras-search-mode.sh status
#
set -euo pipefail

INF_OVERRIDE=/etc/systemd/system/ras-inference.service.d/override.conf
WORKER_OVERRIDE=/etc/systemd/system/ras-embed-worker.service.d/override.conf

cmd=${1:-status}

case "$cmd" in
  on)
    echo "[search-mode] Reranker → ON, worker budget → 16k"
    sudo tee "$INF_OVERRIDE" > /dev/null <<EOF
[Service]
# Search mode: reranker загружен.
EOF
    # уменьшить worker budget чтобы был запас VRAM на reranker
    sudo sed -i 's|^Environment=RAS_EMBED_TOKEN_BUDGET=.*|Environment=RAS_EMBED_TOKEN_BUDGET=16000|' "$WORKER_OVERRIDE"
    sudo systemctl daemon-reload
    sudo systemctl restart ras-inference.service
    sudo systemctl restart ras-embed-worker.service
    echo "[search-mode] inference перезапускается, ~30-60s на загрузку reranker'а"
    ;;
  off)
    echo "[search-mode] Reranker → OFF, worker budget → 32k"
    sudo tee "$INF_OVERRIDE" > /dev/null <<EOF
[Service]
# Indexing mode: reranker выгружен (~1.5 GB VRAM свободно).
Environment=RAS_RERANKER_DISABLED=1
EOF
    sudo sed -i 's|^Environment=RAS_EMBED_TOKEN_BUDGET=.*|Environment=RAS_EMBED_TOKEN_BUDGET=32000|' "$WORKER_OVERRIDE"
    sudo systemctl daemon-reload
    sudo systemctl restart ras-inference.service
    sudo systemctl restart ras-embed-worker.service
    echo "[search-mode] inference перезапускается"
    ;;
  status)
    echo "=== inference reranker ==="
    curl -sS --max-time 3 http://127.0.0.1:8000/health 2>/dev/null \
      | grep -oE '"reranker":"[^"]+"' || echo "(inference not responding)"
    echo "=== worker budget ==="
    grep RAS_EMBED_TOKEN_BUDGET "$WORKER_OVERRIDE" || echo "(no budget set)"
    ;;
  *)
    echo "usage: $0 {on|off|status}"
    exit 1
    ;;
esac
