#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Runtime data root. Volumes are mounted at runtime (Railway, compose, k8s)
# and mount over whatever the image created, so runtime directories and
# ownership must be fixed here at boot — image-time RUN chown does not stick.
PAPERCLIP_HOME="${PAPERCLIP_HOME:-/data/paperclip}"
PAPERCLIP_INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}"
INSTANCE_DIR="$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID"

# Without root we can neither remap the node user (usermod/groupmod/chown)
# nor switch users (gosu needs CAP_SETUID/CAP_SETGID), so exec directly.
# This covers Kubernetes restricted PodSecurity (runAsNonRoot + runAsUser)
# as well as platforms that assign arbitrary UIDs (e.g. OpenShift); for the
# latter a UID/GID mismatch is unfixable here, so warn instead of letting
# usermod fail cryptically and keep volume-permission issues diagnosable.
if [ "$(id -u)" -ne 0 ]; then
    if [ "$(id -u)" -ne "$PUID" ] || [ "$(id -g)" -ne "$PGID" ]; then
        echo "docker-entrypoint.sh: running unprivileged as $(id -u):$(id -g); cannot remap to requested ${PUID}:${PGID}" >&2
    fi
    # Best effort: the volume may already be writable by this UID.
    mkdir -p "$INSTANCE_DIR/logs" "$INSTANCE_DIR/data/storage" "$INSTANCE_DIR/data/run-logs" 2>/dev/null || true
    exec "$@"
fi

mkdir -p "$INSTANCE_DIR/logs" "$INSTANCE_DIR/data/storage" "$INSTANCE_DIR/data/run-logs"

# Adjust the node user's UID/GID if they differ from the runtime request
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

# After a remap the image-owned home also needs re-owning.
if [ "$changed" = "1" ] && [ "$PAPERCLIP_HOME" != "/paperclip" ]; then
    chown -R node:node /paperclip
fi

# Always fix data-root ownership: a runtime-mounted volume arrives root-owned
# even when no UID remap happened, which is exactly the Railway crash case.
# ponytail: chown -R on every boot; add an ownership marker file if large
# volumes ever make startup slow.
chown -R node:node "$PAPERCLIP_HOME"

exec gosu node "$@"
