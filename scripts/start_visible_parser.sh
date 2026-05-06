#!/usr/bin/env bash
set -euo pipefail

# Запуск парсера с опциональным виртуальным дисплеем (Xvfb + x11vnc).
# В начале спрашивает: показывать экран или нет. Если нет — Xvfb/VNC не поднимаются.
#
# Usage:
#   scripts/start_visible_parser.sh
# Optional env:
#   DISPLAY_NUM=99
#   SCREEN_GEOMETRY=1920x1080x24
#   VNC_PORT=5900
#   RAS_HEADLESS=0|1 — если задано до запуска, вопрос не задаётся:
#                      0 = поднять Xvfb+VNC и окно браузера;
#                      1 = без виртуального экрана, headless.

DISPLAY_NUM="${DISPLAY_NUM:-99}"
SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1920x1080x24}"
VNC_PORT="${VNC_PORT:-5900}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DISPLAY_ID=":${DISPLAY_NUM}"
XVFB_PID_FILE="/tmp/ras_xvfb_${DISPLAY_NUM}.pid"
FLUXBOX_PID_FILE="/tmp/ras_fluxbox_${DISPLAY_NUM}.pid"
X11VNC_PID_FILE="/tmp/ras_x11vnc_${DISPLAY_NUM}.pid"

ensure_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[err] command not found: $1"
    echo "[hint] install: sudo apt install -y xvfb x11vnc fluxbox"
    exit 1
  fi
}

start_if_needed() {
  local name="$1"
  local pid_file="$2"
  shift 2

  if [[ -f "$pid_file" ]]; then
    local old_pid
    old_pid="$(cat "$pid_file" || true)"
    if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" >/dev/null 2>&1; then
      echo "[ok] ${name} already running (pid=${old_pid})"
      return 0
    fi
  fi

  "$@" >/tmp/"${name}_${DISPLAY_NUM}".log 2>&1 &
  local new_pid=$!
  echo "$new_pid" >"$pid_file"
  echo "[ok] started ${name} (pid=${new_pid})"
}

ensure_cmd node

START_XVFB=0
if [[ -n "${RAS_HEADLESS+x}" ]]; then
  if [[ "${RAS_HEADLESS}" == "0" ]]; then
    START_XVFB=1
  fi
  echo "[setup] RAS_HEADLESS=${RAS_HEADLESS} (из окружения)"
else
  while true; do
    read -r -p "Показывать экран браузера (VNC + виртуальный дисплей)? [1] да [2] нет: " choice || true
    case "${choice:-}" in
      1)
        START_XVFB=1
        export RAS_HEADLESS=0
        break
        ;;
      2)
        START_XVFB=0
        export RAS_HEADLESS=1
        break
        ;;
      *)
        echo "Введи 1 или 2."
        ;;
    esac
  done
fi

if [[ "${START_XVFB}" == "1" ]]; then
  ensure_cmd Xvfb
  ensure_cmd x11vnc
  ensure_cmd fluxbox

  start_if_needed "xvfb" "$XVFB_PID_FILE" Xvfb "$DISPLAY_ID" -screen 0 "$SCREEN_GEOMETRY"
  export DISPLAY="$DISPLAY_ID"
  start_if_needed "fluxbox" "$FLUXBOX_PID_FILE" fluxbox

  if [[ ! -f "$HOME/.vnc/passwd" ]]; then
    echo "[warn] VNC password file not found: $HOME/.vnc/passwd"
    echo "[warn] create it once with: x11vnc -storepasswd"
    echo "[warn] fallback: insecure mode (-nopw) will be used"
    start_if_needed "x11vnc" "$X11VNC_PID_FILE" \
      x11vnc -display "$DISPLAY_ID" -forever -shared -rfbport "$VNC_PORT" -nopw
  else
    start_if_needed "x11vnc" "$X11VNC_PID_FILE" \
      x11vnc -display "$DISPLAY_ID" -forever -shared -rfbport "$VNC_PORT" -rfbauth "$HOME/.vnc/passwd"
  fi

  echo "[info] display: $DISPLAY_ID"
  echo "[info] vnc port: $VNC_PORT"
  echo "[info] project: $ROOT_DIR"
  echo
  echo "[next] on laptop: ssh -L ${VNC_PORT}:127.0.0.1:${VNC_PORT} <user>@<server>"
  echo "[next] then open VNC client: 127.0.0.1:${VNC_PORT}"
  echo
else
  echo "[info] виртуальный экран не нужен — запуск headless (RAS_HEADLESS=${RAS_HEADLESS:-1})"
fi

cd "$ROOT_DIR"
if [[ "${START_XVFB}" == "1" ]]; then
  export DISPLAY="$DISPLAY_ID"
fi
echo "[run] RAS_HEADLESS=${RAS_HEADLESS:-1} node --env-file=.env parser.js"
node --env-file=.env parser.js
