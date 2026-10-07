#!/usr/bin/env bash
# First-time setup of a fresh Debian 12 / Ubuntu 22.04+ VPS. Run as root (or with sudo):
#
#   curl -fsSL https://raw.githubusercontent.com/<org>/rephoto/main/deploy/scripts/bootstrap.sh | sudo bash -s -- \
#     --repo https://github.com/<org>/rephoto.git --domain rephoto.example.com --email ops@example.com
#
# What it does, in order (each step is idempotent):
#   1. apt: ca-certificates curl git ufw fail2ban, Docker Engine + Compose plugin from download.docker.com
#   2. creates the system user `rephoto` (member of `docker`) and /srv/rephoto/{backup}
#   3. clones the repo into /srv/rephoto/app (or `git pull` when it exists)
#   4. copies deploy/.env.production.example → deploy/.env.production, sets DOMAIN/ACME_EMAIL,
#      runs gen-secrets.sh  (the mail provider values still have to be filled by hand)
#   5. installs deploy/systemd/rephoto.service and enables it
#   6. ufw: allow 22/80/443, deny the rest
#   7. unless --no-up: builds the images and starts the stack
#
# After it finishes: edit /srv/rephoto/app/deploy/.env.production (SMTP_*, EVENT_SLUG,
# BACKUP_DIR on the second disk), then `systemctl restart rephoto`.
set -euo pipefail

REPO=""
DOMAIN=""
EMAIL=""
BRANCH="main"
APP_USER="rephoto"
BASE_DIR="/srv/rephoto"
NO_UP="false"

usage() {
  sed -n '2,20p' "$0"
  exit 64
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --base-dir) BASE_DIR="$2"; shift 2 ;;
    --no-up) NO_UP="true"; shift ;;
    -h|--help) usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

[[ -n "$REPO" && -n "$DOMAIN" && -n "$EMAIL" ]] || { echo "--repo, --domain and --email are required" >&2; usage; }
[[ "$(id -u)" -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }

log() { printf '\n==> %s\n' "$*"; }

APP_DIR="$BASE_DIR/app"
export DEBIAN_FRONTEND=noninteractive

log "packages"
apt-get update -q
apt-get install -y -q ca-certificates curl git gnupg ufw fail2ban

if ! command -v docker >/dev/null 2>&1; then
  log "docker engine + compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  . /etc/os-release
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  log "docker already installed: $(docker --version)"
fi

log "user $APP_USER and $BASE_DIR"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$BASE_DIR" --shell /bin/bash "$APP_USER"
fi
usermod -aG docker "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" "$BASE_DIR" "$BASE_DIR/backup"

log "repository → $APP_DIR ($BRANCH)"
if [[ -d "$APP_DIR/.git" ]]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch --quiet origin
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout --quiet "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --quiet --ff-only origin "$BRANCH"
else
  sudo -u "$APP_USER" git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

DEPLOY_DIR="$APP_DIR/deploy"
ENV_FILE="$DEPLOY_DIR/.env.production"
if [[ ! -f "$ENV_FILE" ]]; then
  log "env file"
  sudo -u "$APP_USER" cp "$DEPLOY_DIR/.env.production.example" "$ENV_FILE"
  sudo -u "$APP_USER" sed -i -E \
    -e "s|^DOMAIN=.*$|DOMAIN=${DOMAIN}|" \
    -e "s|^ACME_EMAIL=.*$|ACME_EMAIL=${EMAIL}|" \
    -e "s|^BACKUP_DIR=.*$|BACKUP_DIR=${BASE_DIR}/backup|" \
    "$ENV_FILE"
  sudo -u "$APP_USER" bash "$DEPLOY_DIR/scripts/gen-secrets.sh" "$ENV_FILE"
else
  log "env file exists, left untouched: $ENV_FILE"
fi

log "systemd unit"
sed -e "s|/srv/rephoto/app|${APP_DIR}|g" -e "s|User=rephoto|User=${APP_USER}|" \
  "$DEPLOY_DIR/systemd/rephoto.service" > /etc/systemd/system/rephoto.service
systemctl daemon-reload
systemctl enable rephoto.service

log "firewall (ufw): 22, 80, 443"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/  /'

log "fail2ban: sshd jail on, caddy jail template in deploy/README.md"
systemctl enable --now fail2ban

if [[ "$NO_UP" == "true" ]]; then
  log "skipping start (--no-up). Next: edit $ENV_FILE, then: systemctl start rephoto"
  exit 0
fi

if grep -qE '^SMTP_PASSWORD=GENERATE' "$ENV_FILE"; then
  log "WARNING: SMTP_* are still placeholders in $ENV_FILE: e-mails will not leave the box"
fi

log "build images (face-service downloads the model pack, several minutes)"
sudo -u "$APP_USER" docker compose --project-directory "$DEPLOY_DIR" --env-file "$ENV_FILE" build

log "start"
systemctl start rephoto.service
sudo -u "$APP_USER" docker compose --project-directory "$DEPLOY_DIR" --env-file "$ENV_FILE" ps

log "done. Point DNS for ${DOMAIN}, www.${DOMAIN}, media.${DOMAIN}, status.${DOMAIN} at this host;"
echo "    Caddy obtains certificates on the first request. Logs: $DEPLOY_DIR/scripts/logs.sh"
