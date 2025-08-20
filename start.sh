#!/usr/bin/env bash
set -euo pipefail
MODE=${MODE:-wasm}
if [ "$MODE" = "server" ]; then
	echo "Starting in server mode"
	npx cross-env MODE=server node server/index.js
else
	echo "Starting in wasm mode"
	npx cross-env MODE=wasm node server/index.js
fi 