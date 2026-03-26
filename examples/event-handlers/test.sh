#!/bin/bash
# Smoke test — creates a session, sends a prompt via REST, terminates.
# Run this in a separate terminal while the example server is running.
#
# Usage:
#   # Terminal 1:
#   cd examples/event-handlers && pnpm start
#
#   # Terminal 2:
#   ./examples/event-handlers/test.sh

set -e

BASE="http://localhost:3001/api"

echo "=== Creating session ==="
SESSION=$(curl -s -X POST "$BASE/agents" \
  -H 'Content-Type: application/json' \
  -d '{"agentTemplateId": "example"}')

echo "$SESSION" | jq .
SESSION_ID=$(echo "$SESSION" | jq -r .id)

echo ""
echo "=== Session created: $SESSION_ID ==="

echo ""
echo "=== Sending prompt via REST ==="
PROMPT_RESULT=$(curl -s -X POST "$BASE/agents/$SESSION_ID/prompts" \
  -H 'Content-Type: application/json' \
  -d '{"text": "write a file to disk"}')

echo "$PROMPT_RESULT" | jq .
echo ""
echo "=== Prompt response received ==="

echo ""
echo "=== Terminating session ==="
curl -s -X DELETE "$BASE/agents/$SESSION_ID" | jq .

echo ""
echo "=== Done — check server terminal for handler output ==="
