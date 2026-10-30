#!/usr/bin/env bash
# Reproducible process setup for the single Dilmune VM (1 vCPU, 2 GB RAM).
#
# Run from the API site's root after every deploy (idempotent):
#   bash ops/dilmune/setup.sh
#
# It builds the Go settlement binary and installs three systemd services that
# start on boot and restart themselves after a crash:
#
#   filspay-api         Node API         CPUQuota=50%  MemoryMax=512M  (judging limit: 0.5 vCPU / 512 MB)
#   filspay-settlement  Go daemon        CPUQuota=25%  MemoryMax=256M  (daily close, payouts, internal API on 127.0.0.1)
#   filspay-reporting   Node worker      CPUQuota=20%  MemoryMax=256M  (outbox -> reporting rollups)
#
# Postgres and nginx are managed by Dilmune. Settings come from the site's
# .env. Dilmune writes it from the site's Environment variables only when
# "env in deploy" is on for the site; otherwise copy it there yourself
# (see docs/DEPLOY.md). Nothing secret lives in this file.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_USER="$(id -un)"
GO_VERSION="1.22.12"

cd "$ROOT"
if [ ! -f .env ]; then
  echo "setup: $ROOT/.env is missing."
  echo "       Turn on 'env in deploy' for this site in Dilmune and redeploy,"
  echo "       or copy the site's variables into $ROOT/.env, then re-run."
  exit 1
fi
chmod 600 .env

# Load .env for this script (migrate and the KYC dir below need it).
set -a; . ./.env; set +a
for var in DATABASE_URL NODE_ENV WEBHOOK_SECRET_ENCRYPTION_KEY SETTLEMENT_INTERNAL_TOKEN ACQUIRER_CALLBACK_SIGNING_SECRET; do
  [ -n "${!var:-}" ] || { echo "setup: $var is not set in .env"; exit 1; }
done
LOAD_SHED_MAX_INFLIGHT="${LOAD_SHED_MAX_INFLIGHT:-10}"

if [ -n "${KYC_UPLOAD_DIR:-}" ]; then
  mkdir -p "$KYC_UPLOAD_DIR"
  chmod 700 "$KYC_UPLOAD_DIR"
fi

echo "setup: applying database migrations"
"$ROOT/node_modules/.bin/tsx" db/migrate.ts

# --- Go toolchain (only needed to build settlement) -------------------------
GO="$(command -v go || true)"
if [ -z "$GO" ]; then
  GO="$HOME/.local/go/bin/go"
  if [ ! -x "$GO" ]; then
    case "$(uname -m)" in
      x86_64) GOARCH=amd64 ;;
      aarch64 | arm64) GOARCH=arm64 ;;
      *) echo "setup: unsupported architecture $(uname -m)"; exit 1 ;;
    esac
    echo "setup: installing Go $GO_VERSION to ~/.local/go"
    mkdir -p "$HOME/.local"
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${GOARCH}.tar.gz" | tar -xz -C "$HOME/.local"
  fi
fi

echo "setup: building settlement"
mkdir -p "$ROOT/bin"
(cd apps/settlement && CGO_ENABLED=0 "$GO" build -trimpath -o "$ROOT/bin/settlement" ./cmd/settlement)

# --- systemd units -----------------------------------------------------------
write_unit() {
  local name="$1" body="$2"
  printf '%s\n' "$body" | sudo tee "/etc/systemd/system/$name.service" >/dev/null
}

COMMON="[Unit]
After=network-online.target postgresql.service
Wants=network-online.target
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target"

write_unit filspay-api "$COMMON

[Service]
User=$RUN_USER
WorkingDirectory=$ROOT
EnvironmentFile=$ROOT/.env
Environment=NODE_OPTIONS=--max-old-space-size=320
Environment=LOAD_SHED_MAX_INFLIGHT=$LOAD_SHED_MAX_INFLIGHT
ExecStart=$ROOT/node_modules/.bin/tsx apps/api/src/index.ts
CPUQuota=50%
MemoryMax=512M
MemorySwapMax=0
Restart=always
RestartSec=2
KillMode=control-group
TimeoutStopSec=15"

write_unit filspay-settlement "$COMMON

[Service]
User=$RUN_USER
WorkingDirectory=$ROOT
EnvironmentFile=$ROOT/.env
Environment=SETTLEMENT_INTERNAL_HOST=127.0.0.1
ExecStart=$ROOT/bin/settlement daemon
CPUQuota=25%
MemoryMax=256M
Restart=always
RestartSec=2
TimeoutStopSec=30"

write_unit filspay-reporting "$COMMON

[Service]
User=$RUN_USER
WorkingDirectory=$ROOT
EnvironmentFile=$ROOT/.env
Environment=NODE_OPTIONS=--max-old-space-size=160
ExecStart=$ROOT/node_modules/.bin/tsx apps/reporting/src/index.ts worker
CPUQuota=20%
MemoryMax=256M
Restart=always
RestartSec=2
KillMode=control-group"

# The API used to run under pm2 (hand-started). Hand it over to systemd so
# there is exactly one owner of port 3000 and of restarts.
if command -v pm2 >/dev/null 2>&1 && pm2 describe filspay-api >/dev/null 2>&1; then
  echo "setup: removing the old pm2-managed filspay-api"
  pm2 delete filspay-api >/dev/null
  pm2 save --force >/dev/null
fi

sudo systemctl daemon-reload
for svc in filspay-api filspay-settlement filspay-reporting; do
  sudo systemctl enable "$svc" >/dev/null 2>&1
  sudo systemctl restart "$svc"
done

# --- check ------------------------------------------------------------------
ready=0
for i in $(seq 1 30); do
  if curl -fsS -m 2 http://127.0.0.1:3000/readyz >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
failed=0
for svc in filspay-api filspay-settlement filspay-reporting; do
  state="$(systemctl is-active "$svc" || true)"
  printf '%-20s %s\n' "$svc" "$state"
  [ "$state" = "active" ] || failed=1
done
echo "api readyz: $(curl -s -m 2 http://127.0.0.1:3000/readyz || echo unreachable)"
if [ "$ready" -ne 1 ] || [ "$failed" -ne 0 ]; then
  echo "setup: FAILED. See: journalctl -u filspay-api -u filspay-settlement -u filspay-reporting -n 50"
  exit 1
fi
echo "setup: OK"
