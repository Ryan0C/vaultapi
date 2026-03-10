#!/usr/bin/env bash
set -euo pipefail

# -----------------------------
# Config (override via env vars)
# -----------------------------
BASE_URL="${BASE_URL:-http://localhost:4000}"
API_KEY="${VAULT_API_KEY:-${API_KEY:-dev-key}}"
AUTH_HEADER="Authorization: Bearer ${API_KEY}"

# Optional overrides:
WORLD_ID="${WORLD_ID:-}"         # if empty, script auto-discovers
TOMBSTONE_ACTOR_ID="${TOMBSTONE_ACTOR_ID:-8rqNfpV31YqHoosS}"  # your known tombstone example
CHAT_LIMIT="${CHAT_LIMIT:-50}"

# -----------------------------
# Dependencies
# -----------------------------
need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing dependency: $1" >&2
    exit 2
  }
}
need curl
need jq

# -----------------------------
# Test helpers
# -----------------------------
PASS=0
FAIL=0

ok()   { echo "✅ $*"; PASS=$((PASS+1)); }
bad()  { echo "❌ $*"; FAIL=$((FAIL+1)); }

# curl wrapper: prints "HTTPSTATUS:<code>" on last line, body before that
req() {
  local method="$1"; shift
  local url="$1"; shift
  local data="${1:-}"

  if [[ "$method" == "GET" ]]; then
    curl -sS -D /tmp/headers.$$ \
      -H "$AUTH_HEADER" \
      "$url" \
      -o /tmp/body.$$
  else
    curl -sS -D /tmp/headers.$$ \
      -H "$AUTH_HEADER" \
      -H "Content-Type: application/json" \
      -X "$method" \
      -d "$data" \
      "$url" \
      -o /tmp/body.$$
  fi

  local status
  status="$(awk 'NR==1 {print $2}' /tmp/headers.$$)"
  cat /tmp/body.$$
  echo
  echo "HTTPSTATUS:$status"
}

req_noauth() {
  local method="$1"; shift
  local url="$1"; shift
  local data="${1:-}"

  if [[ "$method" == "GET" ]]; then
    curl -sS -D /tmp/headers.$$ \
      "$url" \
      -o /tmp/body.$$
  else
    curl -sS -D /tmp/headers.$$ \
      -H "Content-Type: application/json" \
      -X "$method" \
      -d "$data" \
      "$url" \
      -o /tmp/body.$$
  fi

  local status
  status="$(awk 'NR==1 {print $2}' /tmp/headers.$$)"
  cat /tmp/body.$$
  echo
  echo "HTTPSTATUS:$status"
}

get_status() {
  echo "$1" | awk -F'HTTPSTATUS:' 'END{print $2}'
}

get_body() {
  # everything except last status line
  echo "$1" | sed '$d'
}

assert_status() {
  local name="$1"; local expected="$2"; local resp="$3"
  local status
  status="$(get_status "$resp")"
  if [[ "$status" == "$expected" ]]; then
    ok "$name (status=$status)"
  else
    bad "$name (expected $expected got $status)"
    echo "---- body ----"
    get_body "$resp" | head -c 2000; echo
  fi
}

assert_jq() {
  local name="$1"; local jqexpr="$2"; local resp="$3"
  local body
  body="$(get_body "$resp")"
  if echo "$body" | jq -e "$jqexpr" >/dev/null 2>&1; then
    ok "$name (jq ok)"
  else
    bad "$name (jq failed: $jqexpr)"
    echo "---- body ----"
    echo "$body" | jq . 2>/dev/null || echo "$body"
  fi
}

# -----------------------------
# Begin tests
# -----------------------------
echo "== vault-api bash test =="
echo "BASE_URL=$BASE_URL"
echo

# 1) /health should be OK without auth
resp="$(req_noauth GET "$BASE_URL/health")"
assert_status "GET /health (no auth)" "200" "$resp"
assert_jq "GET /health has ok=true" '.ok == true' "$resp"

# 2) /worlds should require auth
resp="$(req_noauth GET "$BASE_URL/worlds")"
# Depending on how your middleware is written, could be 401 or 403.
# You currently use unauthorized() => 401.
status="$(get_status "$resp")"
if [[ "$status" == "401" || "$status" == "403" ]]; then
  ok "GET /worlds (no auth) blocked (status=$status)"
else
  bad "GET /worlds (no auth) should be blocked (got $status)"
  get_body "$resp" | head -c 2000; echo
fi

# 3) /worlds with auth should work
resp="$(req GET "$BASE_URL/worlds")"
assert_status "GET /worlds" "200" "$resp"
# Your worlds route returns { worlds: [...] }
assert_jq "GET /worlds returns worlds array" '.worlds | type=="array"' "$resp"

# discover worldId if not provided
if [[ -z "$WORLD_ID" ]]; then
  # Prefer a world that actually has meta, fallback to first id
  WORLD_ID="$(
    get_body "$resp" | jq -r '
      (.worlds[] | select(.meta != null) | .id) // (.worlds[0].id) // empty
    ' | head -n 1
  )"
fi

if [[ -z "$WORLD_ID" ]]; then
  bad "No worlds found. Check VAULT_ROOT points at the folder containing /worlds/<id>/..."
  echo
  echo "Tip:"
  echo "  export VAULT_ROOT=/path/to/FoundryVTT/Data/vault"
  echo "  (so that VAULT_ROOT/worlds/vault-work/meta/world.json exists)"
  exit 1
fi

echo
echo "Using WORLD_ID=$WORLD_ID"
echo

# 4) World meta
resp="$(req GET "$BASE_URL/worlds/$WORLD_ID/meta")"
assert_status "GET /worlds/:worldId/meta" "200" "$resp"
assert_jq "meta has world object" '.world != null' "$resp"

# 5) Actors list
resp="$(req GET "$BASE_URL/worlds/$WORLD_ID/actors")"
assert_status "GET /worlds/:worldId/actors" "200" "$resp"
# Depending on whether manifest exists, you might return either manifest directly or fallback object.
# Validate at least it has an actors-ish list.
# If manifest: .actors is array of summaries. If fallback: .actors is array of {id}.
assert_jq "actors list returns actors array" '.actors | type=="array"' "$resp"

# pick one actor id to fetch (prefer a non-tombstone one if possible)
ACTOR_ID="$(get_body "$resp" | jq -r '.actors[0].id // .actors[0].vaultId // empty')"
if [[ -z "$ACTOR_ID" ]]; then
  bad "Could not pick actor id from actors list response"
else
  resp2="$(req GET "$BASE_URL/worlds/$WORLD_ID/actors/$ACTOR_ID")"
  assert_status "GET /worlds/:worldId/actors/:actorId" "200" "$resp2"
  assert_jq "actor fetch ok=true" '.ok == true' "$resp2"
fi

# 6) Tombstone actor (optional)
# If your vault currently has a tombstone for 8rqNfpV31YqHoosS, this should be 410.
resp="$(req GET "$BASE_URL/worlds/$WORLD_ID/actors/$TOMBSTONE_ACTOR_ID")"
status="$(get_status "$resp")"
if [[ "$status" == "410" ]]; then
  ok "tombstone actor returns 410 (as expected)"
elif [[ "$status" == "404" || "$status" == "200" ]]; then
  ok "tombstone actor test skipped (status=$status; not tombstoned or not present)"
else
  bad "tombstone actor unexpected status=$status"
  get_body "$resp" | head -c 2000; echo
fi

# 7) Chat days
resp="$(req GET "$BASE_URL/worlds/$WORLD_ID/chat/days")"
assert_status "GET /worlds/:worldId/chat/days" "200" "$resp"
assert_jq "chat days ok=true" '.ok == true' "$resp"

DAY="$(get_body "$resp" | jq -r '.days[0] // empty')"
if [[ -z "$DAY" ]]; then
  ok "No chat days found — skipping chat shard tests"
else
  # 8) Chat hours
  resp="$(req GET "$BASE_URL/worlds/$WORLD_ID/chat/days/$DAY/hours")"
  assert_status "GET /worlds/:worldId/chat/days/:day/hours" "200" "$resp"
  assert_jq "chat hours returns array" '.hours | type=="array"' "$resp"

  HOUR="$(get_body "$resp" | jq -r '.hours[0] // empty')"
  if [[ -z "$HOUR" ]]; then
    ok "No chat hours found for day=$DAY — skipping"
  else
    # 9) Shard manifest
    resp="$(req GET "$BASE_URL/worlds/$WORLD_ID/chat/manifests/$DAY/$HOUR")"
    status="$(get_status "$resp")"
    if [[ "$status" == "200" ]]; then
      ok "GET shard manifest (day=$DAY hour=$HOUR)"
    else
      bad "GET shard manifest expected 200 got $status"
      get_body "$resp" | head -c 2000; echo
    fi

    # 10) Shard events list
    resp="$(req GET "$BASE_URL/worlds/$WORLD_ID/chat/events/$DAY/$HOUR?afterTs=0&limit=$CHAT_LIMIT")"
    assert_status "GET shard events list" "200" "$resp"
    assert_jq "events list ok=true" '.ok == true' "$resp"
    assert_jq "events list has events array" '.events | type=="array"' "$resp"

    # 11) Single event fetch by filename (construct from first event)
    FILE="$(get_body "$resp" | jq -r '.events[0] | select(.) | "\(.ts)-\(.op)-\(.id).json"' 2>/dev/null || true)"
    if [[ -n "$FILE" ]]; then
      resp2="$(req GET "$BASE_URL/worlds/$WORLD_ID/chat/events/$DAY/$HOUR/$FILE")"
      assert_status "GET single event file" "200" "$resp2"
      assert_jq "single event ok=true" '.ok == true' "$resp2"
    else
      ok "No events in shard to test single-event fetch"
    fi
  fi
fi

echo
echo "== Summary =="
echo "PASS=$PASS"
echo "FAIL=$FAIL"
echo

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi