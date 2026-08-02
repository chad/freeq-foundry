#!/usr/bin/env bash
# Launch a corporate session cleanly.
#
# Ad-hoc process management cost several runs: a previous launcher stayed alive holding
# all thirteen bot identities, so the next run got three agents and a game that could
# never reach quorum. This script makes the sequence unskippable: stop, wait out the
# server's ghost window, launch, verify.
set -euo pipefail

RUN_ID="${1:-corp-$(date +%H%M%S)}"
CHANNEL="${CHANNEL:-#foundry}"
OWNER="${OWNER:-did:plc:4qsyxmnsblo4luuycm3572bq}"
MAX_SPEND="${MAX_SPEND:-8.00}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="/tmp/${RUN_ID}.log"

# Kill only sessions of THIS arena, and say so. A blanket `pkill -f cli.js` here quietly
# executed every run I was still monitoring, and I spent an evening diagnosing the
# resulting "mysterious 7-minute deaths" as a server problem.
echo "→ stopping running sessions on ${CHANNEL}"
VICTIMS=$(pgrep -f "cli.js .*--channel ${CHANNEL}" || true)
if [ -n "$VICTIMS" ]; then
  echo "  killing: $VICTIMS"
  kill -TERM $VICTIMS 2>/dev/null || true
fi
for _ in $(seq 1 15); do
  pgrep -f "cli.js .*--channel ${CHANNEL}" >/dev/null 2>&1 || break
  sleep 1
done
pgrep -f "cli.js .*--channel ${CHANNEL}" | xargs -r kill -KILL 2>/dev/null || true

# The server holds a disconnected DID's nick for a ~30s grace window, longer when the
# QUIT never arrived. Reconnecting inside it is what produces "disconnected before ready".
echo "→ waiting 45s for the server's ghost window"
sleep 45

echo "→ launching ${RUN_ID} into ${CHANNEL}"
cd "$ROOT"
nohup node apps/foundry-agents/dist/cli.js \
  --owner "$OWNER" --yes-spend-money --max-spend-usd "$MAX_SPEND" \
  --channel "$CHANNEL" --run-id "$RUN_ID" > "$LOG" 2>&1 &

sleep 75
CONNECTED=$(grep -c '✓' "$LOG" || true)
echo "→ connected: ${CONNECTED}/13"
if [ "$CONNECTED" -lt 13 ]; then
  echo "  ! incomplete roster — see $LOG"
  grep '✗' "$LOG" | head -5 || true
fi
echo "→ log: $LOG"
echo "→ events: ${ROOT}/out/${RUN_ID}/events.ndjson"
