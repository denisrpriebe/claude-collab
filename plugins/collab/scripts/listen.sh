#!/bin/bash
# Holds an SSE connection to the relay for this session and prints each pushed message.
# Every printed line reaches Claude as a notification, so nothing else goes to stdout.
dir="${COLLAB_DIR:-$HOME/.claude/collab}"
[ -f "$dir/token" ] || exit 0
if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
    echo "[collab] can't tell which session this is, so collab is off here"
    exit 0
fi
url=$("$(dirname "$0")/../bin/collab" url)
repo=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
find "$dir/online" -type f -mtime +1 -delete 2>/dev/null

status=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat "$dir/token")" "$url/me")
if [ "$status" = "401" ]; then
    echo "[collab] the relay rejected your token; run /collab:setup <token>"
    exit 0
fi

backoff=5
while true; do
    started=$(date +%s)
    online=$([ -f "$dir/online/$CLAUDE_CODE_SESSION_ID" ] && echo 1)
    # The relay pings every 25s, so a connection that goes quiet for 90s (e.g. after laptop sleep) is dead.
    curl -sN --speed-limit 1 --speed-time 90 -H "Authorization: Bearer $(cat "$dir/token")" \
        "$url/stream?session=$CLAUDE_CODE_SESSION_ID&repo=$repo&online=$online" |
        while IFS= read -r line; do
            case "$line" in
                "data: [collab] no longer online"*)
                    rm -f "$dir/online/$CLAUDE_CODE_SESSION_ID"
                    printf '%s\n' "${line#data: }"
                    ;;
                data:*) printf '%s\n' "${line#data: }" ;;
            esac
        done
    # Reset the backoff after a connection that lasted, otherwise back off up to 60s.
    if [ $(($(date +%s) - started)) -gt 60 ]; then backoff=5; else backoff=$((backoff * 2 > 60 ? 60 : backoff * 2)); fi
    sleep "$backoff"
done
