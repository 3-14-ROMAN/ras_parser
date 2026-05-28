#!/usr/bin/env bash
set -u

cd /home/roman/ras_parser || exit 1

LIMIT="${LIMIT:-1000}"
MAX_ACT_CHARS="${MAX_ACT_CHARS:-20000}"
SLEEP_SECONDS="${SLEEP_SECONDS:-60}"

echo "[watch] start"
echo "[watch] limit=$LIMIT max_act_chars=$MAX_ACT_CHARS sleep=${SLEEP_SECONDS}s"

while true; do
  echo
  echo "[watch] $(date '+%F %T') indexing..."

  MAX_ACT_CHARS="$MAX_ACT_CHARS" node --env-file=.env backend/indexing/index-acts-qdrant-fullact.js "$LIMIT"

  echo
  echo "[watch] PG status:"
  docker exec -i ras_pg psql -U ras -d ras -c "
  SELECT
    COUNT(*) FILTER (WHERE vector_indexed = TRUE) AS indexed,
    COUNT(*) FILTER (
      WHERE act_text IS NOT NULL
        AND length(act_text) > 1000
        AND vector_indexed = FALSE
        AND length(act_text) <= ${MAX_ACT_CHARS}
    ) AS ready_safe_left,
    COUNT(*) FILTER (
      WHERE act_text IS NOT NULL
        AND length(act_text) > ${MAX_ACT_CHARS}
        AND vector_indexed = FALSE
    ) AS too_big_left
  FROM acts;
  "

  echo "[watch] Qdrant points:"
  curl -s http://127.0.0.1:6333/collections/ras_acts \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["result"]["points_count"])'

  echo "[watch] sleep ${SLEEP_SECONDS}s..."
  sleep "$SLEEP_SECONDS"
done
