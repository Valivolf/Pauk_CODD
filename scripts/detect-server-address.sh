#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

is_private() {
  case "$1" in
    10.*|192.168.*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0 ;;
    *) return 1 ;;
  esac
}

list_candidates() {
  if command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show scope global 2>/dev/null | awk '{split($4,a,"/"); print a[1], $2}'
    return
  fi
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command \
      "Get-NetIPConfiguration | Where-Object { \$_.IPv4Address -and \$_.IPv4DefaultGateway } | ForEach-Object { \$_.IPv4Address.IPAddress + ' ' + \$_.InterfaceAlias }" \
      2>/dev/null | tr -d '\r'
    return
  fi
}

CANDIDATES="$(list_candidates || true)"
if [ -z "${CANDIDATES:-}" ]; then
  echo "Не удалось определить IP-адрес автоматически." >&2
  echo "Впишите в .env строку SERVER_ADDRESS=<ваш IP> вручную." >&2
  exit 1
fi

echo "Найденные сетевые адреса этой машины:"
echo "$CANDIDATES" | while read -r ip iface; do
  [ -n "$ip" ] || continue
  if is_private "$ip"; then mark="вероятно, локальная сеть"; else mark="скорее всего VPN/публичный"; fi
  printf '  %-16s %-40s %s\n' "$ip" "$iface" "$mark"
done

BEST="$(echo "$CANDIDATES" | while read -r ip iface; do [ -n "$ip" ] || continue; if is_private "$ip"; then echo "$ip"; fi; done | head -1)"
if [ -z "$BEST" ]; then
  BEST="$(echo "$CANDIDATES" | head -1 | awk '{print $1}')"
fi

[ -f .env ] || cp .env.example .env

if grep -q '^SERVER_ADDRESS=' .env; then
  if grep -q '^SERVER_ADDRESS=$' .env; then
    sed -i "s/^SERVER_ADDRESS=$/SERVER_ADDRESS=${BEST}/" .env
  else
    echo
    echo "В .env уже указан SERVER_ADDRESS — оставляю как есть."
    exit 0
  fi
else
  printf '\nSERVER_ADDRESS=%s\n' "$BEST" >> .env
fi

echo
echo "В .env выставлен SERVER_ADDRESS=$BEST"
