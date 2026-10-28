#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu/Debian server (run as root or with sudo):
# Docker Engine + Compose plugin, firewall (SSH/80/443 only), automatic security updates,
# and a swap file on small machines.
# Usage: sudo ./scripts/server-setup.sh [deploy-user]
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }
DEPLOY_USER=${1:-${SUDO_USER:-}}

echo "==> Base packages"
apt-get update
apt-get install -y ca-certificates curl gnupg ufw unattended-upgrades

if ! command -v docker >/dev/null; then
  echo "==> Installing Docker Engine"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
if [[ -n "$DEPLOY_USER" && "$DEPLOY_USER" != root ]]; then
  usermod -aG docker "$DEPLOY_USER"
  echo "    $DEPLOY_USER added to the docker group (log out and back in)."
fi

echo "==> Firewall: allow SSH, HTTP, HTTPS (incl. HTTP/3)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "==> Automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

if [[ ! -f /swapfile ]] && (( $(free -m | awk '/^Mem:/{print $2}') < 2048 )); then
  echo "==> Adding 2G swap (less than 2 GB RAM detected)"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

docker --version
docker compose version
echo "Server ready. Next: cp .env.production.example .env.production && ./scripts/deploy.sh"
