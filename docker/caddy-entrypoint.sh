#!/bin/sh
set -eu

IFACE="${NETWORK_INTERFACE:-ens33}"
ENV_FILE="/env/.env"

detect_ip() {
  ip -4 -o addr show "$IFACE" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1
}

IP=""
for i in $(seq 1 10); do
  IP="$(detect_ip || true)"
  [ -n "$IP" ] && break
  echo "[entrypoint] interface '$IFACE' not up yet, retrying ($i/10)..."
  sleep 2
done

if [ -z "$IP" ]; then
  echo "[entrypoint] WARNING: no IPv4 address found on interface '$IFACE'." >&2
  ip -4 -o addr show 2>/dev/null | awk '{print "  " $2, $4}' >&2 || true
  echo "[entrypoint] Keeping whatever SERVER_ADDRESS is already in .env (if any)." >&2
else
  echo "[entrypoint] detected $IFACE = $IP"
  export SERVER_ADDRESS="$IP"
  if [ -f "$ENV_FILE" ]; then
    TMP_ENV="$(mktemp)"
    if grep -q '^SERVER_ADDRESS=' "$ENV_FILE"; then
      sed "s/^SERVER_ADDRESS=.*/SERVER_ADDRESS=$IP/" "$ENV_FILE" > "$TMP_ENV"
    else
      cat "$ENV_FILE" > "$TMP_ENV"
      printf '\nSERVER_ADDRESS=%s\n' "$IP" >> "$TMP_ENV"
    fi
    cat "$TMP_ENV" > "$ENV_FILE"
    rm -f "$TMP_ENV"
    echo "[entrypoint] updated $ENV_FILE with SERVER_ADDRESS=$IP"
  else
    echo "[entrypoint] WARNING: $ENV_FILE not found (mount it as a volume) — cannot persist the detected address." >&2
  fi
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
