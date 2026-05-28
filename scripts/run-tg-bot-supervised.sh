#!/usr/bin/env bash
# Supervisor для telegram-bot.js: рестартит процесс при ненулевых exit-кодах
# (включая 1 от "exiting for systemd restart" при недоступности Telegram —
# см. pollLoop() в scripts/telegram-bot.js).
#
# Зачем отдельный supervisor вместо systemd: ras-telegram-bot.service
# нейтрализован drop-in'ом (см. /etc/systemd/system/ras-telegram-bot.service.d/),
# потому что внешние Cursor-сессии иногда дёргают `systemctl restart` в цикле,
# что роняет бота посреди работы. Этот скрипт даёт ту же "Restart=always"
# семантику, но независим от systemd.
#
# Запуск (под nohup, чтобы пережить логаут):
#   nohup bash scripts/run-tg-bot-supervised.sh >> logs/telegram-bot.log 2>&1 < /dev/null & disown
#
# Поведение:
#   - Чистый exit=0 / SIGINT (130) / SIGTERM (143) → выход без рестарта.
#   - Любой другой код → рестарт с exponential backoff.
#   - Flap-detect: если >= FLAP_MAX_IN_WINDOW крахов за FLAP_WINDOW_SEC —
#     выход 99 (сигнал "что-то системно сломано, лечи руками").
#
# ENV (все опциональны):
#   TG_BOT_RESTART_DELAY_SEC      минимальная задержка (def 3)
#   TG_BOT_RESTART_DELAY_MAX_SEC  потолок задержки (def 120)
#   TG_BOT_SHORT_RUN_SEC          порог "короткой жизни" (def 30)
#   TG_BOT_HEALTHY_RUN_SEC        порог "здоровой жизни" (def 300)
#   TG_BOT_FLAP_WINDOW_SEC        окно для flap-detect (def 600)
#   TG_BOT_FLAP_MAX_IN_WINDOW     максимум крахов в окне (def 20)

set -u

cd "$(dirname "$0")/.."

# При запуске из cron $PATH минимален и nvm-овский node не найдётся.
# Подхватываем nvm если он установлен (no-op для обычного интерактивного запуска).
if [ -z "${NVM_DIR:-}" ] && [ -d "$HOME/.nvm" ]; then
  export NVM_DIR="$HOME/.nvm"
fi
if [ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ] && ! command -v node >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[tg-supervisor] FATAL: node not found in PATH (PATH=$PATH)" >&2
  exit 127
fi

restart_delay_min="${TG_BOT_RESTART_DELAY_SEC:-3}"
restart_delay_max="${TG_BOT_RESTART_DELAY_MAX_SEC:-120}"
short_run_threshold="${TG_BOT_SHORT_RUN_SEC:-30}"
healthy_run_threshold="${TG_BOT_HEALTHY_RUN_SEC:-300}"
flap_window_sec="${TG_BOT_FLAP_WINDOW_SEC:-600}"
flap_max_in_window="${TG_BOT_FLAP_MAX_IN_WINDOW:-20}"

attempt=0
current_delay=$restart_delay_min
recent_crashes=()

# Перехватываем SIGTERM/SIGINT, чтобы корректно остановить дочерний node и
# выйти без рестарта (иначе trap по умолчанию убьёт только этот shell).
child_pid=0
on_signal() {
  local sig="$1"
  echo "[tg-supervisor] got $sig, forwarding to child pid=$child_pid" >&2
  if [ "$child_pid" -ne 0 ]; then
    kill -"$sig" "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  exit 0
}
trap 'on_signal TERM' TERM
trap 'on_signal INT'  INT

while true; do
  attempt=$((attempt + 1))
  echo "[tg-supervisor] attempt #$attempt starting tg-bot (delay=${current_delay}s)..." >&2

  started_at=$(date +%s)

  node --env-file=.env scripts/telegram-bot.js &
  child_pid=$!
  wait "$child_pid"
  ec=$?
  child_pid=0

  ended_at=$(date +%s)
  uptime=$((ended_at - started_at))

  if [ $ec -eq 0 ] || [ $ec -eq 130 ] || [ $ec -eq 143 ]; then
    echo "[tg-supervisor] tg-bot exit=$ec (uptime=${uptime}s) — выхожу без рестарта" >&2
    exit $ec
  fi

  cutoff=$((ended_at - flap_window_sec))
  filtered=()
  for ts in "${recent_crashes[@]+"${recent_crashes[@]}"}"; do
    if [ "$ts" -ge "$cutoff" ]; then
      filtered+=("$ts")
    fi
  done
  filtered+=("$ended_at")
  recent_crashes=("${filtered[@]}")

  if [ "${#recent_crashes[@]}" -ge "$flap_max_in_window" ]; then
    echo "[tg-supervisor] FLAP-DETECT: ${#recent_crashes[@]} крахов за ${flap_window_sec}s " \
      "(порог=${flap_max_in_window}) — бот не успевает стартовать. Чини руками." >&2
    echo "[tg-supervisor] Последний exit=$ec, uptime=${uptime}s. Выход 99." >&2
    exit 99
  fi

  if [ "$uptime" -lt "$short_run_threshold" ]; then
    new_delay=$((current_delay * 2))
    if [ "$new_delay" -gt "$restart_delay_max" ]; then
      new_delay=$restart_delay_max
    fi
    if [ "$new_delay" -ne "$current_delay" ]; then
      echo "[tg-supervisor] бот жил ${uptime}s (<${short_run_threshold}s) — " \
        "backoff: delay ${current_delay}s → ${new_delay}s" >&2
    fi
    current_delay=$new_delay
  elif [ "$uptime" -ge "$healthy_run_threshold" ]; then
    if [ "$current_delay" -ne "$restart_delay_min" ]; then
      echo "[tg-supervisor] бот жил ${uptime}s (≥${healthy_run_threshold}s) — " \
        "reset delay → ${restart_delay_min}s" >&2
      current_delay=$restart_delay_min
    fi
  fi

  echo "[tg-supervisor] tg-bot exit=$ec (uptime=${uptime}s), " \
    "рестарт через ${current_delay}s (крахов в окне ${flap_window_sec}s: ${#recent_crashes[@]}/${flap_max_in_window})" >&2
  sleep "$current_delay"
done
