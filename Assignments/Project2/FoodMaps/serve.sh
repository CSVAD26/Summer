#!/bin/sh
# Serve FoodMaps locally (this machine only) and open the globe.
cd "$(dirname "$0")"
PORT="${PORT:-8236}"
echo "FoodMaps: http://127.0.0.1:$PORT/public/   (Ctrl+C to stop)"
( sleep 1; open "http://127.0.0.1:$PORT/public/" ) &
exec python3 -m http.server "$PORT" --bind 127.0.0.1
