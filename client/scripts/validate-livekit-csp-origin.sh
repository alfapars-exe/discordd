#!/bin/sh
# Runs before the nginx image's 20-envsubst-on-templates.sh entrypoint hook.
# LIVEKIT_CSP_WS_ORIGIN is operator-controlled deployment config; reject
# anything except one plain ws:// DNS hostname (with optional valid port).
set -eu

origin=${LIVEKIT_CSP_WS_ORIGIN:-}
if [ -z "$origin" ]; then
    export LIVEKIT_CSP_WS_ORIGIN=""
    exit 0
fi

reject_origin() {
    printf '%s\n' 'Invalid LIVEKIT_CSP_WS_ORIGIN: expected one exact ws://hostname[:port] origin (single line, no path, query, credentials, or extra CSP tokens).' >&2
    exit 1
}

# awk validates records individually, so reject line breaks before invoking
# it; otherwise two individually valid origins on separate lines could pass.
newline=$(printf '\nx')
newline=${newline%x}
case "$origin" in
    *"$newline"*) reject_origin ;;
esac

if ! printf '%s' "$origin" | awk '
    {
        value = $0
        if (length(value) > 260 || value !~ /^ws:\/\/([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)(\.([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?))*(:[0-9]+)?$/) {
            exit 1
        }

        authority = substr(value, 6)
        if (authority ~ /:/) {
            split(authority, parts, ":")
            port = parts[2]
            if (port !~ /^[0-9]+$/ || length(port) > 5 || port + 0 < 1 || port + 0 > 65535) {
                exit 1
            }
        }
    }
'; then
    reject_origin
fi

# Export an explicitly empty value when unset, so envsubst always produces a
# syntactically valid default policy.
export LIVEKIT_CSP_WS_ORIGIN="$origin"
