#!/usr/bin/env bash
# ============================================================
# Local test: generation queue (task-queue feature)
#
# Prerequisites:
#   1. Dispatcher running on http://127.0.0.1:8090
#   2. Processor connected with a generation model (flux2-klein-4b-q4)
#   3. A site with media.generate operation enabled
#
# Setup (once):
#   ./dispatcher site-create --name test-site
#   ./dispatcher device-create --site test-site   # copy device token
#   # Set SITE_TOKEN and DEVICE_TOKEN env vars
#
# Usage:
#   export SITE_TOKEN=<your-site-token>
#   export DEVICE_TOKEN=<your-device-token>
#   ./scripts/test-generation-queue.sh
# ============================================================

set -euo pipefail

DISPATCHER="${DISPATCHER:-http://127.0.0.1:8090}"
SITE_TOKEN="${SITE_TOKEN:?Set SITE_TOKEN environment variable}"
DEVICE_TOKEN="${DEVICE_TOKEN:-}"

PASS=0
FAIL=0

check() {
  local desc="$1"
  local actual="$2"
  local expected="$3"
  if echo "$actual" | grep -qF "$expected"; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    echo "    expected: $expected"
    echo "    actual:   $$(echo "$actual" | head -5)"
    FAIL=$((FAIL + 1))
  fi
}

echo "============================================================"
echo " Test: Generation Queue (task-queue)"
echo " Dispatcher: $DISPATCHER"
echo "============================================================"
echo

# --- Step 1: Submit first generation job ---
echo "[1/7] Submit first generation job (will occupy the model)..."
RESP=$(curl -s -X POST "$DISPATCHER/api/v2/site/jobs" \
  -H "Authorization: Bearer $SITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"jq-test-1","type":"media.generate","params":{"modelId":"flux2-klein-4b-q4","modelRevision":"abc123","profileRevision":"abc123","inputs":{"prompt":"test image 1","width":512,"height":512,"seed":42}},"source":{}}')
echo "  Response: $RESP"
check "Job 1 submitted" "$RESP" "QUEUED"
echo

# Wait for processor to pick up and start
echo "  Waiting 5s for processor to start job 1..."
sleep 5

# --- Step 2: Submit second generation job (should queue) ---
echo "[2/7] Submit second generation job (should go to queue)..."
RESP=$(curl -s -X POST "$DISPATCHER/api/v2/site/jobs" \
  -H "Authorization: Bearer $SITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"jq-test-2","type":"media.generate","params":{"modelId":"flux2-klein-4b-q4","modelRevision":"abc123","profileRevision":"abc123","inputs":{"prompt":"test image 2","width":512,"height":512,"seed":43}},"source":{}}')
echo "  Response: $RESP"
check "Job 2 submitted" "$RESP" "QUEUED"
echo

# The dispatcher keeps the second job queued until the device is free.
sleep 5

# --- Step 3: Check job 2 status (stays QUEUED while the device is busy) ---
echo "[3/7] Check second job status (expected: QUEUED)..."
RESP=$(curl -s "$DISPATCHER/api/v2/site/jobs/jq-test-2" \
  -H "Authorization: Bearer $SITE_TOKEN")
echo "  Status: $RESP"
check "Job 2 stays QUEUED" "$RESP" "QUEUED"
echo

# --- Step 4: Check model availability ---
echo "[4/7] Check generation models (model visible even when busy)..."
RESP=$(curl -s "$DISPATCHER/api/v2/site/generation/models" \
  -H "Authorization: Bearer $SITE_TOKEN")
echo "  Models: $RESP"
check "Model still available" "$RESP" "flux2"
echo

# --- Step 5: Wait for job 1 to complete and verify job 2 starts ---
echo "[5/7] Waiting for job 1 to complete, then job 2 should start..."
TIMEOUT=60
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  RESP=$(curl -s "$DISPATCHER/api/v2/site/jobs/jq-test-1" \
    -H "Authorization: Bearer $SITE_TOKEN")
  if echo "$RESP" | grep -qF '"status":"SUCCEEDED"'; then
    echo "  Job 1 completed after ${ELAPSED}s"
    break
  fi
  sleep 3
  ELAPSED=$((ELAPSED + 3))
done

if [ $ELAPSED -ge $TIMEOUT ]; then
  echo "  ⚠ Job 1 did not complete within ${TIMEOUT}s (expected for smoke test)"
fi

# Check if job 2 started
sleep 5
RESP=$(curl -s "$DISPATCHER/api/v2/site/jobs/jq-test-2" \
  -H "Authorization: Bearer $SITE_TOKEN")
echo "  Job 2 status: $RESP"
if echo "$RESP" | grep -qF '"status":"RUNNING"'; then
  echo "  ✓ Job 2 started after job 1 completed"
  PASS=$((PASS + 1))
elif echo "$RESP" | grep -qF '"status":"SUCCEEDED"'; then
  echo "  ✓ Job 2 completed"
  PASS=$((PASS + 1))
else
  echo "  ⚠ Job 2 status is not RUNNING/SUCCEEDED (may need longer wait)"
  FAIL=$((FAIL + 1))
fi
echo

# --- Step 6: Test cancel of a queued job ---
echo "[6/7] Submit third job and cancel it..."
curl -s -X POST "$DISPATCHER/api/v2/site/jobs" \
  -H "Authorization: Bearer $SITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"jq-test-3","type":"media.generate","params":{"modelId":"flux2-klein-4b-q4","modelRevision":"abc123","profileRevision":"abc123","inputs":{"prompt":"test image 3","width":512,"height":512,"seed":44}},"source":{}}' > /dev/null
sleep 3

RESP=$(curl -s -X POST "$DISPATCHER/api/v2/site/jobs/jq-test-3/cancel" \
  -H "Authorization: Bearer $SITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"requestId":"cancel-1"}')
echo "  Cancel response: $RESP"
check "Job 3 cancelled" "$RESP" "CANCELLED"
echo

# --- Step 7: Verify job 2 continues after cancel ---
echo "[7/7] Verify job 2 continues (cancel of job 3 should not affect it)..."
RESP=$(curl -s "$DISPATCHER/api/v2/site/jobs/jq-test-2" \
  -H "Authorization: Bearer $SITE_TOKEN")
echo "  Job 2 status: $RESP"
if echo "$RESP" | grep -qF '"status":"RUNNING"'; then
  echo "  ✓ Job 2 still running after job 3 cancel"
  PASS=$((PASS + 1))
else
  echo "  ⚠ Job 2 status changed (may have completed)"
  if echo "$RESP" | grep -qF '"status":"SUCCEEDED"'; then
    PASS=$((PASS + 1))
    echo "  ✓ Job 2 completed"
  else
    FAIL=$((FAIL + 1))
  fi
fi
echo

# --- Summary ---
echo "============================================================"
echo " Results: $PASS passed, $FAIL failed"
echo "============================================================"

if [ $FAIL -gt 0 ]; then
  exit 1
fi
exit 0
