#!/bin/bash
set -e

MAX_ITERATIONS=${1:-10}
PAUSE_SECONDS=${2:-2}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT_TEXT=$(cat "$SCRIPT_DIR/ralph-prompt.txt")

echo "Launching Ralph agent — up to $MAX_ITERATIONS runs"
echo ""

for ((i=1; i<=MAX_ITERATIONS; i++)); do
    echo "==========================================="
    echo "  Run $i of $MAX_ITERATIONS"
    echo "==========================================="

    result=$(claude --dangerously-skip-permissions --output-format text -p "$PROMPT_TEXT")

    echo "$result"
    echo ""

    if [[ "$result" == *"<promise>COMPLETE</promise>"* ]]; then
        echo "==========================================="
        echo "  All work finished in $i runs"
        echo "==========================================="
        exit 0
    fi

    sleep $PAUSE_SECONDS
done

echo "==========================================="
echo "  Maximum runs reached ($MAX_ITERATIONS)"
echo "==========================================="
exit 1
