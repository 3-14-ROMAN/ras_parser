#!/usr/bin/env bash
# Supervisor для parser.js: рестартит процесс при ненулевых exit-кодах
# (включая 73 от watchdog'а «тишины» в parser.js — см. log() и
# _startStuckWatchdog()). Сигналы пользователя (130=SIGINT/Ctrl+C,
# 143=SIGTERM) и чистый exit=0 НЕ перезапускают цикл — даём остановить
# процесс штатно.
#
# Запуск: npm start
#
# Поведение под "месяцами без присмотра":
#   - Первый attempt запускается интерактивно (TTY → парсер спрашивает
#     headless/даты/категорию). Все последующие attempts получают
#     RAS_NONINTERACTIVE=1, и парсер пропускает интерактивные промпты,
#     подсасывая параметры из env + parser_state.json. Это убирает
#     класс багов «процесс висит на _ask() после рестарта».
#   - Exponential backoff: если парсер жил < RAS_PARSER_SHORT_RUN_SEC,
#     задержка перед следующим рестартом удваивается (cap = MAX_SEC).
#     Если жил ≥ HEALTHY_RUN_SEC — delay сбрасывается к минимуму.
#     Это защищает от рестарт-шторма когда проблема систематическая.
#   - Flap-detect: если за окно FLAP_WINDOW_SEC случилось FLAP_MAX_IN_WINDOW
#     крахов — supervisor выходит с кодом 99. «Молотить в стену» бессмысленно:
#     явно что-то сломано в коде/прокси/инфре, нужен человек.
#
# ENV (все опциональны):
#   RAS_PARSER_RESTART_DELAY_SEC      минимальная задержка (def 5)
#   RAS_PARSER_RESTART_DELAY_MAX_SEC  потолок задержки (def 300)
#   RAS_PARSER_SHORT_RUN_SEC          порог "короткой жизни" (def 60)
#   RAS_PARSER_HEALTHY_RUN_SEC        порог "здоровой жизни" (def 600)
#   RAS_PARSER_FLAP_WINDOW_SEC        окно для flap-detect (def 300)
#   RAS_PARSER_FLAP_MAX_IN_WINDOW     максимум крахов в окне (def 10)
#   RAS_PARSER_MAX_RESTARTS           общий лимит рестартов (def 0 = безлимит)
#
# Node запускается в foreground (без `&`), чтобы stdin был привязан к
# терминалу для ПЕРВОГО attempt'а (где парсер интерактивный). Ctrl+C из
# терминала отправляет SIGINT всей process group, поэтому node получает
# сигнал сам без явного trap'а.
set -u

restart_delay_min="${RAS_PARSER_RESTART_DELAY_SEC:-5}"
restart_delay_max="${RAS_PARSER_RESTART_DELAY_MAX_SEC:-300}"
short_run_threshold="${RAS_PARSER_SHORT_RUN_SEC:-60}"
healthy_run_threshold="${RAS_PARSER_HEALTHY_RUN_SEC:-600}"
flap_window_sec="${RAS_PARSER_FLAP_WINDOW_SEC:-300}"
flap_max_in_window="${RAS_PARSER_FLAP_MAX_IN_WINDOW:-10}"
max_restarts="${RAS_PARSER_MAX_RESTARTS:-0}"

attempt=0
current_delay=$restart_delay_min
recent_crashes=()  # bash array of unix timestamps of recent crashes

while true; do
  attempt=$((attempt + 1))
  echo "[supervisor] attempt #$attempt starting parser (delay=${current_delay}s)..." >&2

  started_at=$(date +%s)

  if [ "$attempt" -eq 1 ]; then
    # Первый запуск: TTY-интерактив, чтобы человек настроил параметры.
    node --env-file=.env parser.js
  else
    # Рестарт: пропускаем интерактив, параметры из env + state.json.
    RAS_NONINTERACTIVE=1 node --env-file=.env parser.js
  fi
  ec=$?

  ended_at=$(date +%s)
  uptime=$((ended_at - started_at))

  # Чистый выход или пользовательский сигнал — не рестартим.
  if [ $ec -eq 0 ] || [ $ec -eq 130 ] || [ $ec -eq 143 ]; then
    echo "[supervisor] parser exit=$ec (uptime=${uptime}s) — выхожу без рестарта" >&2
    exit $ec
  fi

  if [ "$max_restarts" != "0" ] && [ "$attempt" -ge "$max_restarts" ]; then
    echo "[supervisor] достигнут лимит рестартов ($max_restarts), exit=$ec" >&2
    exit $ec
  fi

  # Flap-detect: считаем крахи в скользящем окне.
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
    echo "[supervisor] FLAP-DETECT: ${#recent_crashes[@]} крахов за ${flap_window_sec}s " \
      "(порог=${flap_max_in_window}) — парсер не успевает стартовать. Чини проблему руками." >&2
    echo "[supervisor] Последний exit=$ec, uptime=${uptime}s. Выход 99." >&2
    exit 99
  fi

  # Exponential backoff: короткая жизнь → удваиваем, здоровая → reset.
  if [ "$uptime" -lt "$short_run_threshold" ]; then
    new_delay=$((current_delay * 2))
    if [ "$new_delay" -gt "$restart_delay_max" ]; then
      new_delay=$restart_delay_max
    fi
    if [ "$new_delay" -ne "$current_delay" ]; then
      echo "[supervisor] парсер жил ${uptime}s (<${short_run_threshold}s) — " \
        "backoff: delay ${current_delay}s → ${new_delay}s" >&2
    fi
    current_delay=$new_delay
  elif [ "$uptime" -ge "$healthy_run_threshold" ]; then
    if [ "$current_delay" -ne "$restart_delay_min" ]; then
      echo "[supervisor] парсер жил ${uptime}s (≥${healthy_run_threshold}s) — " \
        "reset delay → ${restart_delay_min}s" >&2
      current_delay=$restart_delay_min
    fi
  fi

  echo "[supervisor] parser exit=$ec (uptime=${uptime}s), " \
    "рестарт через ${current_delay}s (крахов в окне ${flap_window_sec}s: ${#recent_crashes[@]}/${flap_max_in_window})" >&2
  sleep "$current_delay"
done
