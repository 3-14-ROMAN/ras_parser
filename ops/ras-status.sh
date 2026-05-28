#!/usr/bin/env bash
# ops/ras-status.sh — оперативный snapshot всего RAS embedding стека.
#
# Usage:  ./ops/ras-status.sh
#
# Что показывает:
#   - systemd: статус трёх сервисов (active/enabled)
#   - PG queue: pending/indexing/indexed/error по vector_status
#   - Qdrant:   points_count, segments, chunk has_colbert sample
#   - Disk:     free / и /data
#   - RAM:      free -h
#   - Qdrant container: docker stats
#   - Worker:   последний [state=...] из journalctl
#   - Last 30 log lines embed-worker
#
# Скрипт read-only. Ничего не меняет, ничего не убивает.

set -u

bold() { printf '\033[1m%s\033[0m\n' "$*"; }

bold "=== SYSTEMD ==="
for svc in ras-inference.service ras-search-api.service ras-embed-worker.service; do
  active=$(systemctl is-active   "$svc" 2>/dev/null || echo "?")
  enabled=$(systemctl is-enabled "$svc" 2>/dev/null || echo "?")
  pid=$(systemctl show -p MainPID --value "$svc" 2>/dev/null || echo "?")
  printf "  %-28s active=%-10s enabled=%-10s main_pid=%s\n" "$svc" "$active" "$enabled" "$pid"
done

echo
bold "=== POSTGRES embed queue ==="
docker exec ras_pg psql -U ras -d ras -t -A -F '|' -c "
  SELECT vector_status, count(*)::int
    FROM acts
   WHERE verdict_keep IS TRUE
     AND act_text IS NOT NULL
     AND act_text NOT LIKE '__EXTRACT_FAILED__%'
   GROUP BY vector_status
   ORDER BY vector_status;" 2>/dev/null \
  | awk -F'|' '{printf "  %-10s %s\n", $1, $2}'

echo "  ── token buckets (pending only) ──"
docker exec ras_pg psql -U ras -d ras -t -A -F '|' -c "
  SELECT
    CASE
      WHEN tokens_jina_v4 IS NULL                      THEN 'null_v4'
      WHEN is_long_act = FALSE AND tokens_jina_v4 <= 8000      THEN 'short_<=8000'
      WHEN tokens_jina_v4 BETWEEN  8001 AND 15000      THEN 'long_8001-15000'
      WHEN tokens_jina_v4 BETWEEN 15001 AND 22000      THEN 'long_15001-22000'
      WHEN tokens_jina_v4 BETWEEN 22001 AND 32768      THEN 'long_22001-32768'
      WHEN tokens_jina_v4 > 32768                       THEN 'oversized_>32768'
      ELSE 'other'
    END AS bucket,
    count(*)::int
   FROM acts
  WHERE vector_status = 'pending'
    AND verdict_keep  IS TRUE
    AND act_text IS NOT NULL
    AND act_text NOT LIKE '__EXTRACT_FAILED__%'
  GROUP BY 1
  ORDER BY 1;" 2>/dev/null \
  | awk -F'|' '{printf "  %-22s %s\n", $1, $2}'

echo
bold "=== QDRANT ==="
QC=$(curl -s --max-time 5 http://127.0.0.1:6333/collections/ras_acts)
if [ -z "$QC" ]; then
  echo "  qdrant unreachable @ 127.0.0.1:6333"
else
  echo "$QC" | python3 -c "
import json,sys
d = json.load(sys.stdin)['result']
cfg = d['config']
vecs = cfg['params']['vectors']
print(f\"  status={d['status']} points={d['points_count']} indexed_vectors={d['indexed_vectors_count']} segments={d['segments_count']}\")
print(f\"  on_disk_payload={cfg['params'].get('on_disk_payload')} hnsw_on_disk={cfg['hnsw_config'].get('on_disk')} quantization={cfg.get('quantization_config')}\")
print('  vectors:')
for k,v in vecs.items():
    print(f\"    {k:12s} size={v.get('size'):>5} hnsw_m={v.get('hnsw_config',{}).get('m','-')} on_disk={v.get('on_disk')}\")
sv = cfg['params'].get('sparse_vectors', {})
if sv:
    for k,v in sv.items():
        print(f\"    sparse:{k:6s} modifier={v.get('modifier')}\")
" 2>/dev/null
fi

HAS=$(curl -s --max-time 5 -X POST http://127.0.0.1:6333/collections/ras_acts/points/scroll \
  -H 'Content-Type: application/json' \
  -d '{"limit":3,"with_vector":false,"filter":{"must":[{"key":"unit_type","match":{"value":"chunk"}}]}}' \
  | python3 -c "import json,sys; ps=json.load(sys.stdin)['result']['points']; print(','.join(str(p['payload'].get('has_colbert')) for p in ps))" 2>/dev/null)
echo "  chunk.has_colbert sample = ${HAS:-(no chunks yet)}"

echo
bold "=== DISK ==="
df -h --output=target,size,used,avail,pcent / /data 2>/dev/null | sed 's/^/  /'

echo
bold "=== RAM ==="
free -h | sed 's/^/  /'

echo
bold "=== QDRANT container ==="
docker stats --no-stream --format \
  "  {{.Name}}: mem={{.MemUsage}} ({{.MemPerc}}) cpu={{.CPUPerc}}" \
  ras_qdrant ras_pg 2>/dev/null \
  || echo "  docker stats unavailable"

echo
bold "=== WORKER state ==="
# Берём только логи текущей инкарнации сервиса (с ActiveEnterTimestamp),
# иначе grep ловит [state=...] из предыдущих жизней.
START_TS=$(systemctl show -p ActiveEnterTimestamp --value ras-embed-worker.service 2>/dev/null)
START_TS=${START_TS:-"1 hour ago"}
LAST_STATE=$(journalctl -u ras-embed-worker.service --no-pager --since "$START_TS" 2>/dev/null \
  | grep -oE '\[state=[a-z_/]+\]' | tail -1)
LAST_LOCK=$(journalctl -u ras-embed-worker.service --no-pager --since "$START_TS" 2>/dev/null \
  | grep -oE '\[lock/[A-Z]+\]'    | tail -1)
echo "  service_started=$START_TS"
echo "  last_state=${LAST_STATE:-(none since service start)}"
echo "  last_lock =${LAST_LOCK:-(none)}"

echo
bold "=== EMBED WORKER — last 30 log lines ==="
journalctl -u ras-embed-worker.service --no-pager -n 30 2>/dev/null \
  | sed -E 's/^.*npm\[[0-9]+\]: //; s/^/  /'
