#!/usr/bin/env bash
# ops/doczilla-smoke.sh — smoke-тест Doczilla facade'а для RAS Search — Supply.
#
# Покрывает:
#   1.  login (dev-open или с apiKey, если задан DOCZILLA_API_TOKEN)
#   2.  structureRead
#   3.  createDocz
#   3b. get на свежесозданном → 409 report_not_completed
#   3c. fillDocz с пустым query → 400 bad_request
#   3d. fillDocz с несуществующим uuid → 404 not_found
#   4.  fillDocz РЕАЛЬНЫЙ (~10-30s)
#   5.  getById
#   6.  get(json) — compact-only
#   7.  get(html) — XSS-safe escaped
#   8.  get(pdf) → 501 not_implemented
#   9.  unsupported document method (move) → 501
#  10.  create (НЕ createDocz) → 501 (роутер не должен перехватывать createDocz)
#
# Использование:
#   1) Запустить API: npm run search:api
#   2) Применить миграцию (один раз): npm run db:migrate-reports
#   3) ./ops/doczilla-smoke.sh
#
# ENV:
#   BASE  — base URL (default: http://127.0.0.1:8091)
#   QUERY — текст запроса (default: тестовый запрос про неустойку)
#   DOCZILLA_API_TOKEN — если задан, login будет использован с apiKey,
#                        иначе dev-mode login/password

set -u
set -o pipefail

BASE="${BASE:-http://127.0.0.1:8091}"
QUERY="${QUERY:-взыскание неустойки за просрочку поставки товара по договору поставки}"

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
blue()   { printf "\033[34m%s\033[0m\n" "$*"; }

step() {
  echo
  yellow "── $* ──"
}

require() {
  command -v "$1" >/dev/null 2>&1 || { red "Need $1 installed"; exit 2; }
}
require curl
require jq

FAIL_COUNT=0
assert_http() {
  local expected="$1" actual="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    green "  ✓ $label: HTTP $actual (expected $expected)"
  else
    red   "  ✗ $label: HTTP $actual (expected $expected)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# 1. login
step "1. POST /doczilla-api/login"
if [ -n "${DOCZILLA_API_TOKEN:-}" ]; then
  blue "  using apiKey-mode (DOCZILLA_API_TOKEN is set)"
  LOGIN_RESP=$(curl -sS -X POST -H "content-type: application/json" \
    -d "{\"apiKey\":\"$DOCZILLA_API_TOKEN\"}" \
    "$BASE/doczilla-api/login")
else
  blue "  using dev-mode (DOCZILLA_API_TOKEN not set)"
  LOGIN_RESP=$(curl -sS -X POST -H "content-type: application/json" \
    -d '{"login":"smoke","password":"smoke"}' \
    "$BASE/doczilla-api/login")
fi
echo "$LOGIN_RESP" | jq .
TOKEN=$(echo "$LOGIN_RESP" | jq -r '.data.token // empty')
MODE=$(echo "$LOGIN_RESP"  | jq -r '.data.mode  // empty')
if [ -z "$TOKEN" ]; then red "login: no token"; exit 1; fi
green "login OK (mode=$MODE, token=${TOKEN:0:12}…)"

# 1b. login с неверным apiKey, если token-required mode
if [ -n "${DOCZILLA_API_TOKEN:-}" ]; then
  step "1b. POST /doczilla-api/login с неверным apiKey → ждём 401"
  HTTP_BAD=$(curl -sS -o /tmp/doczilla_bad_login.json -w "%{http_code}" \
    -X POST -H "content-type: application/json" \
    -d '{"apiKey":"definitely-wrong-key"}' \
    "$BASE/doczilla-api/login")
  cat /tmp/doczilla_bad_login.json | jq .
  assert_http "401" "$HTTP_BAD" "login wrong apiKey"
fi

# 2. structureRead
step "2. GET /doczilla-api/document/structureRead?templateId=ras_supply_search"
curl -sS "$BASE/doczilla-api/document/structureRead?templateId=ras_supply_search" \
  | jq '{success, templateId: .data.templateId, name: .data.name, fields_n: (.data.fields|length)}'

# 2b. structureRead с неизвестным templateId
step "2b. GET /doczilla-api/document/structureRead?templateId=foobar → ждём 404"
HTTP_TPL=$(curl -sS -o /tmp/doczilla_tpl.json -w "%{http_code}" \
  "$BASE/doczilla-api/document/structureRead?templateId=foobar")
cat /tmp/doczilla_tpl.json | jq .
assert_http "404" "$HTTP_TPL" "structureRead unknown template"

# 3. createDocz
step "3. POST /doczilla-api/document/createDocz"
CREATE_RESP=$(curl -sS -X POST -H "content-type: application/json" \
  -d '{"templateId":"ras_supply_search","name":"smoke test report"}' \
  "$BASE/doczilla-api/document/createDocz")
echo "$CREATE_RESP" | jq .
DOCZ_ID=$(echo "$CREATE_RESP" | jq -r '.data.doczId // .data.id // empty')
if [ -z "$DOCZ_ID" ]; then red "createDocz: no doczId"; exit 1; fi
green "createDocz OK (doczId=$DOCZ_ID)"

# 3b. get(json) на не-completed → 409
step "3b. POST /doczilla-api/document/get на status='created' → ждём 409 report_not_completed"
HTTP_NR=$(curl -sS -o /tmp/doczilla_notready.json -w "%{http_code}" \
  -X POST -H "content-type: application/json" \
  -d "{\"doczId\":\"$DOCZ_ID\",\"format\":\"json\"}" \
  "$BASE/doczilla-api/document/get")
cat /tmp/doczilla_notready.json | jq .
assert_http "409" "$HTTP_NR" "get on non-completed"

# 3c. fillDocz с пустым query → 400
step "3c. POST /doczilla-api/document/fillDocz с пустым answers.query → ждём 400"
HTTP_EMPTY=$(curl -sS -o /tmp/doczilla_empty.json -w "%{http_code}" \
  -X POST -H "content-type: application/json" \
  -d "{\"doczId\":\"$DOCZ_ID\",\"answers\":{\"query\":\"   \"}}" \
  "$BASE/doczilla-api/document/fillDocz")
cat /tmp/doczilla_empty.json | jq .
assert_http "400" "$HTTP_EMPTY" "fillDocz empty query"

# 3d. fillDocz с несуществующим uuid → 404
step "3d. POST /doczilla-api/document/fillDocz с несуществующим uuid → ждём 404"
HTTP_NF=$(curl -sS -o /tmp/doczilla_notfound.json -w "%{http_code}" \
  -X POST -H "content-type: application/json" \
  -d "{\"doczId\":\"00000000-0000-0000-0000-000000000000\",\"answers\":{\"query\":\"foo\"}}" \
  "$BASE/doczilla-api/document/fillDocz")
cat /tmp/doczilla_notfound.json | jq .
assert_http "404" "$HTTP_NF" "fillDocz non-existing uuid"

# 4. fillDocz (запускает реальный pipeline → долго)
step "4. POST /doczilla-api/document/fillDocz РЕАЛЬНЫЙ (ждать ~10-30s)"
FILL_RESP=$(curl -sS -X POST -H "content-type: application/json" \
  -d "{
    \"doczId\":\"$DOCZ_ID\",
    \"answers\":{
      \"query\":\"$QUERY\",
      \"use_hyde\":true,
      \"use_summary\":true,
      \"top_k\":5
    }
  }" \
  --max-time 120 \
  "$BASE/doczilla-api/document/fillDocz")
echo "$FILL_RESP" | jq '{success, error, doczId: .data.doczId, status: .data.status, searchId: .data.searchId, n: (.data.topActs|length), summary_chars: (.data.summary|length)}'
SUCC=$(echo "$FILL_RESP" | jq -r '.success')
if [ "$SUCC" != "true" ]; then red "fillDocz failed"; echo "$FILL_RESP" | jq .; exit 1; fi
green "fillDocz OK"

# 5. getById
step "5. GET /doczilla-api/document/getById?id=$DOCZ_ID"
curl -sS "$BASE/doczilla-api/document/getById?id=$DOCZ_ID" \
  | jq '{success, status: .data.status, summary_chars: (.data.summary|length), n: (.data.topActs|length), formats: .data.availableFormats}'

# 6. get(json)
step "6. POST /doczilla-api/document/get format=json"
GET_JSON=$(curl -sS -X POST -H "content-type: application/json" \
  -d "{\"doczId\":\"$DOCZ_ID\",\"format\":\"json\"}" \
  "$BASE/doczilla-api/document/get")
echo "$GET_JSON" | jq '{success, format: .data.format, n: (.data.report.topActs|length), summary_chars: (.data.report.summary|length), id: .data.report.id, status: .data.report.status}'
# sanity: топ-акты НЕ должны содержать полный act_text (только snippet)
HAS_FULL_TEXT=$(echo "$GET_JSON" | jq '[.data.report.topActs[]? | select(.act_text != null)] | length')
if [ "$HAS_FULL_TEXT" != "0" ]; then
  red   "  ✗ json export leaks full act_text (count=$HAS_FULL_TEXT)"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  green "  ✓ json export: no full act_text leaked"
fi

# 7. get(html)
step "7. POST /doczilla-api/document/get format=html"
HTML_FILE="/tmp/doczilla_$DOCZ_ID.html"
HTTP_HTML=$(curl -sS -o "$HTML_FILE" -w "%{http_code}" \
  -X POST -H "content-type: application/json" \
  -d "{\"doczId\":\"$DOCZ_ID\",\"format\":\"html\"}" \
  "$BASE/doczilla-api/document/get")
assert_http "200" "$HTTP_HTML" "get html"
echo "bytes=$(wc -c < "$HTML_FILE")  preview:"
head -c 400 "$HTML_FILE"; echo "…"
# sanity: НЕТ inline <script>, нет javascript:/data:/vbscript: в href
if grep -q "<script" "$HTML_FILE"; then
  red   "  ✗ html export contains <script> tag"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  green "  ✓ html export: no <script> tag"
fi
if grep -Eqi 'href="(javascript|data|file|vbscript):' "$HTML_FILE"; then
  red   "  ✗ html export contains dangerous URL scheme in href"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  green "  ✓ html export: no dangerous URL scheme in href"
fi

# 8. get(pdf) → 501
step "8. POST /doczilla-api/document/get format=pdf → ждём 501 not_implemented"
HTTP_PDF=$(curl -sS -o /tmp/doczilla_pdf.json -w "%{http_code}" \
  -X POST -H "content-type: application/json" \
  -d "{\"doczId\":\"$DOCZ_ID\",\"format\":\"pdf\"}" \
  "$BASE/doczilla-api/document/get")
cat /tmp/doczilla_pdf.json | jq .
assert_http "501" "$HTTP_PDF" "get pdf"

# 9. unsupported method (move) → 501
step "9. POST /doczilla-api/document/move → ждём 501 not_implemented"
HTTP_MOVE=$(curl -sS -o /tmp/doczilla_move.json -w "%{http_code}" \
  -X POST -H "content-type: application/json" \
  -d '{"doczId":"x"}' \
  "$BASE/doczilla-api/document/move")
cat /tmp/doczilla_move.json | jq .
assert_http "501" "$HTTP_MOVE" "move"

# 10. POST .../document/create (НЕ createDocz) → 501 (не должен перехватывать createDocz)
step "10. POST /doczilla-api/document/create → ждём 501 (а createDocz продолжает работать)"
HTTP_CREATE=$(curl -sS -o /tmp/doczilla_create.json -w "%{http_code}" \
  -X POST -H "content-type: application/json" \
  -d '{"doczId":"x"}' \
  "$BASE/doczilla-api/document/create")
cat /tmp/doczilla_create.json | jq .
assert_http "501" "$HTTP_CREATE" "create (unsupported)"

# 11. POST .../document/getByLink → 501 (Doczilla метод для shared-link, у нас нет share)
step "11. POST /doczilla-api/document/getByLink → ждём 501"
HTTP_GBL=$(curl -sS -o /tmp/doczilla_gbl.json -w "%{http_code}" \
  -X POST -H "content-type: application/json" \
  -d '{"link":"https://example/share/x"}' \
  "$BASE/doczilla-api/document/getByLink")
cat /tmp/doczilla_gbl.json | jq .
assert_http "501" "$HTTP_GBL" "getByLink (unsupported)"

# 12. POST .../users/read → 501 (нет user-системы)
step "12. POST /doczilla-api/users/read → ждём 501"
HTTP_USR=$(curl -sS -o /tmp/doczilla_users.json -w "%{http_code}" \
  -X POST -H "content-type: application/json" \
  -d '{"userId":"x"}' \
  "$BASE/doczilla-api/users/read")
cat /tmp/doczilla_users.json | jq .
assert_http "501" "$HTTP_USR" "users/read (unsupported)"

# 13. POST .../users/unknownMethod → 501 (вся семья users 501, даже неизвестные методы)
step "13. POST /doczilla-api/users/whatever → ждём 501 (вся семья users)"
HTTP_USR2=$(curl -sS -o /tmp/doczilla_users2.json -w "%{http_code}" \
  -X POST -H "content-type: application/json" \
  -d '{}' \
  "$BASE/doczilla-api/users/whatever")
cat /tmp/doczilla_users2.json | jq .
assert_http "501" "$HTTP_USR2" "users/whatever (unsupported)"

# Финальный отчёт
echo
if [ "$FAIL_COUNT" = "0" ]; then
  green "── doczilla smoke OK (all assertions passed) ──"
else
  red   "── doczilla smoke FAILED ($FAIL_COUNT assertion(s) failed) ──"
fi
echo
echo "Подробности отчёта (включая HTML): $HTML_FILE"
echo "doczId для последующих ручных запросов: $DOCZ_ID"

[ "$FAIL_COUNT" = "0" ] || exit 1
