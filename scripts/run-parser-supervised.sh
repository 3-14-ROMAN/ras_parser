#!/usr/bin/env bash
# Supervisor для parser.js: рестартит процесс при ненулевых exit-кодах
# (включая 73 от watchdog'а «тишины» в parser.js — см. log() и
# _startStuckWatchdog()). Сигналы пользователя (130=SIGINT/Ctrl+C,
# 143=SIGTERM) и чистый exit=0 НЕ перезапускают цикл — даём остановить
# процесс штатно.
#
# Запуск: npm start
# Настройка задержки между рестартами: RAS_PARSER_RESTART_DELAY_SEC=5
#
# Node запускается в foreground (без `&`), чтобы stdin был привязан к
# терминалу — иначе интерактивные readline-вопросы парсера висят
# навсегда. Ctrl+C из терминала отправляет SIGINT всей process group,
# поэтому node получает сигнал сам без явного trap'а.
set -u

restart_delay="${RAS_PARSER_RESTART_DELAY_SEC:-5}"
max_restarts="${RAS_PARSER_MAX_RESTARTS:-0}"  # 0 = безлимит
attempt=0

while true; do
  attempt=$((attempt + 1))
  echo "[supervisor] attempt #$attempt starting parser..." >&2
  node --env-file=.env parser.js
  ec=$?

  # Чистый выход или пользовательский сигнал — не рестартим.
  if [ $ec -eq 0 ] || [ $ec -eq 130 ] || [ $ec -eq 143 ]; then
    echo "[supervisor] parser exit=$ec — выхожу без рестарта" >&2
    exit $ec
  fi

  if [ "$max_restarts" != "0" ] && [ "$attempt" -ge "$max_restarts" ]; then
    echo "[supervisor] достигнут лимит рестартов ($max_restarts), exit=$ec" >&2
    exit $ec
  fi

  echo "[supervisor] parser exit=$ec, рестарт через ${restart_delay}s" >&2
  sleep "$restart_delay"
done
