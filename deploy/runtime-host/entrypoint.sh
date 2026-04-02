#!/bin/sh
# Start both the Restate endpoint (9080) and RuntimeHost server (9100)
node packages/flamecast/dist/restate/serve-endpoint.js &
node packages/flamecast/dist/runtime-host/serve.js &
wait
