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
    function ipv6_group_count(side, groups, count, i) {
        if (side == "") {
            return 0
        }
        count = split(side, groups, ":")
        for (i = 1; i <= count; i++) {
            if (length(groups[i]) < 1 || length(groups[i]) > 4 || groups[i] !~ /^[A-Fa-f0-9]+$/) {
                return -1
            }
        }
        return count
    }

    function valid_ipv6(address, compression, left, right, left_count, right_count) {
        if (address !~ /^[A-Fa-f0-9:]+$/ || address ~ /:::/) {
            return 0
        }

        compression = index(address, "::")
        if (compression > 0) {
            if (index(substr(address, compression + 2), "::") > 0) {
                return 0
            }
            left = substr(address, 1, compression - 1)
            right = substr(address, compression + 2)
            left_count = ipv6_group_count(left)
            right_count = ipv6_group_count(right)
            return left_count >= 0 && right_count >= 0 && left_count + right_count < 8
        }

        return ipv6_group_count(address) == 8
    }

    function valid_port(port) {
        return port ~ /^[0-9]+$/ && length(port) <= 5 && port + 0 >= 1 && port + 0 <= 65535
    }

    {
        value = $0
        if (length(value) > 300 || value !~ /^ws:\/\//) {
            exit 1
        }

        authority = substr(value, 6)
        if (substr(authority, 1, 1) == "[") {
            close_bracket = index(authority, "]")
            if (close_bracket == 0) {
                exit 1
            }
            host = substr(authority, 2, close_bracket - 2)
            suffix = substr(authority, close_bracket + 1)
            if (!valid_ipv6(host)) {
                exit 1
            }
            if (suffix != "") {
                if (suffix !~ /^:[0-9]+$/ || !valid_port(substr(suffix, 2))) {
                    exit 1
                }
            }
        } else {
            if (authority !~ /^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)(\.([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?))*(:[0-9]+)?$/) {
                exit 1
            }
            if (authority ~ /:/) {
                split(authority, parts, ":")
                if (!valid_port(parts[2])) {
                    exit 1
                }
            }
        }
    }
'; then
    reject_origin
fi

# Export an explicitly empty value when unset, so envsubst always produces a
# syntactically valid default policy.
export LIVEKIT_CSP_WS_ORIGIN="$origin"
