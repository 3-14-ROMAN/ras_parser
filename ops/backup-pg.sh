#!/usr/bin/env bash
# Ежедневный бэкап ras_pg на HDD (/mnt/ubuntu_hdd).
# Запускается из cron'а roman'а в 03:00.
#
# Что делает:
#   1. pg_dump --format=custom -Z 6 (компрессия внутри custom-формата).
#   2. Кладёт в /mnt/ubuntu_hdd/ras_pg_backups/ras_YYYYMMDD_HHMMSS.pgcustom
#   3. Удаляет файлы старше RETAIN_DAYS (def 14).
#   4. Логирует в /mnt/ubuntu_hdd/ras_pg_backups/backup.log
#
# Восстановление:
#   docker exec -i ras_pg pg_restore -U ras -d ras --clean --if-exists < backup.pgcustom
#
# ENV (опциональны):
#   RAS_PG_BACKUP_DIR     /mnt/ubuntu_hdd/ras_pg_backups
#   RAS_PG_BACKUP_RETAIN  14

set -euo pipefail

BACKUP_DIR="${RAS_PG_BACKUP_DIR:-/mnt/ubuntu_hdd/ras_pg_backups}"
RETAIN_DAYS="${RAS_PG_BACKUP_RETAIN:-14}"
LOG_FILE="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"

log() {
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*" | tee -a "$LOG_FILE" >&2
}

ts="$(date +%Y%m%d_%H%M%S)"
out="$BACKUP_DIR/ras_${ts}.pgcustom"
tmp="${out}.tmp"

log "starting backup → $out"

if ! docker exec ras_pg pg_dump -U ras -d ras --format=custom -Z 6 > "$tmp" 2>>"$LOG_FILE"; then
  log "FAIL: pg_dump exit=$?"
  rm -f "$tmp"
  exit 1
fi

# Sanity check: дамп custom-формата начинается с магической строки "PGDMP".
if ! head -c 5 "$tmp" | grep -q "PGDMP"; then
  log "FAIL: dump file missing PGDMP magic header — pg_dump returned bad data"
  rm -f "$tmp"
  exit 1
fi

mv "$tmp" "$out"
size_human="$(du -h "$out" | cut -f1)"
log "done: $out ($size_human)"

# Ротация: удалить старые бэкапы.
deleted=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "ras_*.pgcustom" -mtime "+$RETAIN_DAYS" -print -delete | wc -l)
if [ "$deleted" -gt 0 ]; then
  log "rotation: deleted $deleted backups older than ${RETAIN_DAYS}d"
fi

# Свободное место — для глаза в логе.
free_human=$(df -h "$BACKUP_DIR" | awk 'NR==2 {print $4 " free"}')
log "disk: $free_human on $(df -P "$BACKUP_DIR" | awk 'NR==2 {print $6}')"
