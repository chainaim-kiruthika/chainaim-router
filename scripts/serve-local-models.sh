#!/usr/bin/env bash
# Start the Iteration 0 local model servers (llama.cpp llama-server, OpenAI-compatible).
# Every value is a flag; defaults match config/catalog.json.
set -euo pipefail

LLAMA_SERVER="${LLAMA_SERVER:-llama-server}"
MODELS_DIR="models"
THREADS=2
CTX=4096
HOST=127.0.0.1
LOG_DIR="data/model-logs"
STOP=0

usage() {
  cat <<USAGE
serve-local-models.sh [--llama-server PATH] [--models-dir DIR] [--threads N] [--ctx N]
                      [--host HOST] [--log-dir DIR] [--stop]
Starts:  qwen2.5-0.5b on :8081   qwen2.5-1.5b on :8082
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --llama-server) LLAMA_SERVER="$2"; shift 2 ;;
    --models-dir)   MODELS_DIR="$2"; shift 2 ;;
    --threads)      THREADS="$2"; shift 2 ;;
    --ctx)          CTX="$2"; shift 2 ;;
    --host)         HOST="$2"; shift 2 ;;
    --log-dir)      LOG_DIR="$2"; shift 2 ;;
    --stop)         STOP=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

mkdir -p "$LOG_DIR"
declare -A PORT=( [qwen2.5-0.5b]=8081 [qwen2.5-1.5b]=8082 )
declare -A FILE=( [qwen2.5-0.5b]=qwen2.5-0.5b-instruct-q4_k_m.gguf [qwen2.5-1.5b]=qwen2.5-1.5b-instruct-q4_k_m.gguf )

for name in "${!PORT[@]}"; do
  pidfile="$LOG_DIR/$name.pid"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    if [[ $STOP -eq 1 ]]; then kill "$(cat "$pidfile")"; rm -f "$pidfile"; echo "stopped $name"; else echo "$name already running (pid $(cat "$pidfile"))"; fi
    continue
  fi
  [[ $STOP -eq 1 ]] && continue
  model="$MODELS_DIR/${FILE[$name]}"
  [[ -f "$model" ]] || { echo "missing $model" >&2; exit 1; }
  nohup "$LLAMA_SERVER" -m "$model" --alias "$name" --host "$HOST" --port "${PORT[$name]}" \
    -c "$CTX" -t "$THREADS" -np 1 > "$LOG_DIR/$name.log" 2>&1 &
  echo $! > "$pidfile"
  echo "started $name on $HOST:${PORT[$name]} (pid $!)"
done
