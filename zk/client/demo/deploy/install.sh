#!/usr/bin/env bash
# Installs demo.grayr.xyz on this server: Caddy (HTTPS, reverse proxy) + the demo as systemd
# services. Run with sudo from zk/client. Idempotent. Prereq: Porkbun A record demo -> this IP.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
CADDY_SRC=${CADDY_SRC:-/home/ubuntu/.local/opt/caddy-2.11.7/caddy}

install -m 755 "$CADDY_SRC" /usr/local/bin/caddy
id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
install -d -o caddy -g caddy /var/lib/caddy /var/log/caddy
install -d /etc/caddy
[ -f /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
install -m 644 "$here/Caddyfile" /etc/caddy/Caddyfile
install -m 644 "$here/caddy.service" /etc/systemd/system/caddy.service
install -m 644 "$here/grayr-demo.service" /etc/systemd/system/grayr-demo.service
/usr/local/bin/caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null

# the demo moves from tmux to systemd (same port, 8787)
sudo -u ubuntu tmux kill-session -t grayr-demo 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now grayr-demo.service
systemctl enable --now caddy.service
systemctl --no-pager --lines=0 status grayr-demo.service caddy.service | grep -E "●|Active:"
echo "ok. Certificate issuance needs the DNS record live; watch: journalctl -u caddy -f"
