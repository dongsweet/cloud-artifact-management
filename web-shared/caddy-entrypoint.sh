#!/bin/sh
set -eu

# Render the Caddyfile at startup so each externally published channel can be
# switched between HTTP and HTTPS without rebuilding the web image.  The
# certificate paths are paths inside the container (the deployment Compose
# files mount CAM_*_TLS_DIR at /tls).
module=${CAM_CADDY_MODULE:?CAM_CADDY_MODULE is required}
template=${CAM_CADDY_TEMPLATE:-/etc/caddy/Caddyfile}

case "$module" in
  edge)
    web_https=${CAM_EDGE_WEB_HTTPS:-false}
    web_cert=${CAM_EDGE_WEB_TLS_CERT_FILE:-}
    web_key=${CAM_EDGE_WEB_TLS_KEY_FILE:-}
    control_https=${CAM_EDGE_CONTROL_HTTPS:-false}
    control_cert=${CAM_EDGE_CONTROL_TLS_CERT_FILE:-}
    control_key=${CAM_EDGE_CONTROL_TLS_KEY_FILE:-}
    transfer_https=${CAM_EDGE_TRANSFER_HTTPS:-false}
    transfer_cert=${CAM_EDGE_TRANSFER_TLS_CERT_FILE:-}
    transfer_key=${CAM_EDGE_TRANSFER_TLS_KEY_FILE:-}
    ;;
  core)
    web_https=${CAM_CORE_WEB_HTTPS:-false}
    web_cert=${CAM_CORE_WEB_TLS_CERT_FILE:-}
    web_key=${CAM_CORE_WEB_TLS_KEY_FILE:-}
    control_https=${CAM_CORE_CONTROL_HTTPS:-false}
    control_cert=${CAM_CORE_CONTROL_TLS_CERT_FILE:-}
    control_key=${CAM_CORE_CONTROL_TLS_KEY_FILE:-}
    transfer_https=${CAM_CORE_TRANSFER_HTTPS:-false}
    transfer_cert=${CAM_CORE_TRANSFER_TLS_CERT_FILE:-}
    transfer_key=${CAM_CORE_TRANSFER_TLS_KEY_FILE:-}
    ;;
  *)
    echo "unsupported CAM_CADDY_MODULE: $module" >&2
    exit 64
    ;;
esac

tls_enabled() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    0|false|no|off|'') return 1 ;;
    *) echo "invalid HTTPS switch: $1 (use true or false)" >&2; exit 64 ;;
  esac
}

emit_tls() {
  enabled=$1
  cert=$2
  key=$3
  if tls_enabled "$enabled"; then
    if [ -z "$cert" ] || [ -z "$key" ]; then
      echo "HTTPS is enabled but the certificate or private-key path is empty" >&2
      exit 64
    fi
    if [ ! -f "$cert" ] || [ ! -r "$cert" ]; then
      echo "TLS certificate is not readable: $cert" >&2
      exit 64
    fi
    if [ ! -f "$key" ] || [ ! -r "$key" ]; then
      echo "TLS private key is not readable: $key" >&2
      exit 64
    fi
    printf '  tls "%s" "%s"\n' "$cert" "$key"
  fi
}

if [ ! -r "$template" ]; then
  echo "Caddyfile template is not readable: $template" >&2
  exit 64
fi

mkdir -p /tmp/cam-caddy
output=/tmp/cam-caddy/Caddyfile

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    *'CAM-CADDY-TLS: WEB'*)
      emit_tls "$web_https" "$web_cert" "$web_key"
      ;;
    *'CAM-CADDY-TLS: CONTROL'*)
      emit_tls "$control_https" "$control_cert" "$control_key"
      ;;
    *'CAM-CADDY-TLS: TRANSFER'*)
      emit_tls "$transfer_https" "$transfer_cert" "$transfer_key"
      ;;
    *)
      printf '%s\n' "$line"
      ;;
  esac
done < "$template" > "$output"

exec caddy run --config "$output" --adapter caddyfile
