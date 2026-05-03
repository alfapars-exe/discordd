#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  HiChat! — LiveKit Auto-Setup Script (Linux)
#
#  Sets up a LiveKit voice server with a single command:
#    1. Install LiveKit binary
#    2. Open firewall ports
#    3. Generate API Key + Secret
#    4. Create livekit.yaml config
#    5. Start LiveKit as a systemd service
#    6. (Optional) Install Caddy + Let's Encrypt SSL when DOMAIN is set
#       → produces a wss:// URL that web browsers can connect to
#
#  Usage (plain ws:// — Electron/desktop only):
#    curl -fsSL https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/livekit-setup.sh | sudo bash
#
#  Usage (wss:// — works in browsers, requires DNS pointing to this VPS):
#    curl -fsSL <url> | sudo DOMAIN=livekit.yourdomain.com EMAIL=you@yourdomain.com bash
#
#  EMAIL is sent to Let's Encrypt for cert renewal notifications.
#  Without DOMAIN set, the script behaves exactly as before.
#
# ═══════════════════════════════════════════════════════════════

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

INSTALL_DIR="/opt/livekit"

# Optional environment-supplied configuration
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-admin@${DOMAIN:-localhost}}"

echo ""
echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo -e "${CYAN}  HiChat! LiveKit Setup Script (Linux)${NC}"
echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo ""

if [ -n "$DOMAIN" ]; then
    echo -e "${CYAN}  Mode: WSS via Caddy + Let's Encrypt${NC}"
    echo -e "${CYAN}  Domain: ${DOMAIN}${NC}"
    echo -e "${CYAN}  ACME email: ${EMAIL}${NC}"
else
    echo -e "${YELLOW}  Mode: Plain ws:// (Electron-only)${NC}"
    echo -e "${YELLOW}  Tip: rerun with DOMAIN=livekit.yourdomain.com for browser support.${NC}"
fi
echo ""

# ─── Root check ───
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Error: This script must be run as root.${NC}"
    echo "Usage: sudo bash livekit-setup.sh"
    echo "  or:  curl -fsSL <url> | sudo bash"
    exit 1
fi

TOTAL_STEPS=5
[ -n "$DOMAIN" ] && TOTAL_STEPS=6

# ─── 1: Install LiveKit ───
echo -e "${YELLOW}[1/${TOTAL_STEPS}] Installing LiveKit...${NC}"
if command -v livekit-server &> /dev/null; then
    LK_VERSION=$(livekit-server --version 2>/dev/null || echo "installed")
    echo -e "${GREEN}  LiveKit already installed: ${LK_VERSION}${NC}"
else
    echo "  Downloading LiveKit binary..."
    curl -sSL https://get.livekit.io | bash
    echo -e "${GREEN}  LiveKit installed successfully.${NC}"
fi

# ─── 2: Open Firewall Ports ───
# Port 80 + 443 are added when DOMAIN is set so Caddy can serve HTTP→HTTPS
# redirects and Let's Encrypt's ACME http-01 challenge.
echo -e "${YELLOW}[2/${TOTAL_STEPS}] Opening firewall ports...${NC}"
EXTRA_TCP_PORTS=""
[ -n "$DOMAIN" ] && EXTRA_TCP_PORTS="80 443"

if command -v ufw &> /dev/null; then
    ufw allow 7880/tcp   >/dev/null 2>&1
    ufw allow 7881/tcp   >/dev/null 2>&1
    ufw allow 7882/udp   >/dev/null 2>&1
    ufw allow 50000:60000/udp >/dev/null 2>&1
    for p in $EXTRA_TCP_PORTS; do
        ufw allow ${p}/tcp >/dev/null 2>&1
    done
    ufw --force enable    >/dev/null 2>&1
    echo -e "${GREEN}  Ports opened: 7880/tcp, 7881/tcp, 7882/udp, 50000-60000/udp${EXTRA_TCP_PORTS:+, ${EXTRA_TCP_PORTS// /,}/tcp}${NC}"
elif command -v firewall-cmd &> /dev/null; then
    firewall-cmd --permanent --add-port=7880/tcp  >/dev/null 2>&1
    firewall-cmd --permanent --add-port=7881/tcp  >/dev/null 2>&1
    firewall-cmd --permanent --add-port=7882/udp  >/dev/null 2>&1
    firewall-cmd --permanent --add-port=50000-60000/udp >/dev/null 2>&1
    for p in $EXTRA_TCP_PORTS; do
        firewall-cmd --permanent --add-port=${p}/tcp >/dev/null 2>&1
    done
    firewall-cmd --reload >/dev/null 2>&1
    echo -e "${GREEN}  Ports opened (firewalld).${NC}"
else
    echo -e "${YELLOW}  No firewall manager found (ufw/firewalld). Make sure ports 7880, 7881, 7882, 50000-60000${EXTRA_TCP_PORTS:+, ${EXTRA_TCP_PORTS// /,}} are open.${NC}"
fi

# ─── 3: Generate Credentials ───
echo -e "${YELLOW}[3/${TOTAL_STEPS}] Generating credentials...${NC}"
API_KEY="LiveKitKey$(openssl rand -hex 4)"
API_SECRET=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
echo -e "${GREEN}  API Key:    ${API_KEY}${NC}"
echo -e "${GREEN}  API Secret: ${API_SECRET}${NC}"

# ─── 4: Create livekit.yaml ───
echo -e "${YELLOW}[4/${TOTAL_STEPS}] Creating LiveKit config...${NC}"
mkdir -p "$INSTALL_DIR"

cat > "${INSTALL_DIR}/livekit.yaml" << EOF
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
keys:
  ${API_KEY}: ${API_SECRET}
EOF

echo -e "${GREEN}  Config saved to ${INSTALL_DIR}/livekit.yaml${NC}"

# ─── 5: Systemd Service ───
echo -e "${YELLOW}[5/${TOTAL_STEPS}] Setting up LiveKit service...${NC}"
LK_BIN=$(command -v livekit-server 2>/dev/null || echo "/usr/local/bin/livekit-server")

cat > /etc/systemd/system/livekit.service << EOF
[Unit]
Description=LiveKit SFU Server
After=network.target

[Service]
Type=simple
ExecStart=${LK_BIN} --config ${INSTALL_DIR}/livekit.yaml
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable livekit  >/dev/null 2>&1
systemctl restart livekit

sleep 2
if systemctl is-active --quiet livekit; then
    echo -e "${GREEN}  LiveKit service is running on port 7880.${NC}"
else
    echo -e "${RED}  LiveKit failed to start. Run 'journalctl -u livekit -n 20' to inspect.${NC}"
    exit 1
fi

# ─── 6: Caddy reverse proxy with auto-SSL (only when DOMAIN is set) ───
# Why Caddy: zero-config Let's Encrypt + HTTPS + WebSocket upgrade, ~15MB
# binary, single-process, restart-survives renewals. Upgrades wss:// →
# ws://localhost:7880 internally.
if [ -n "$DOMAIN" ]; then
    echo -e "${YELLOW}[6/${TOTAL_STEPS}] Installing Caddy + provisioning Let's Encrypt cert for ${DOMAIN}...${NC}"

    # Install Caddy via official Debian/Ubuntu repo, fall back to RHEL if needed.
    if command -v apt-get &> /dev/null; then
        apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null 2>&1
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
            | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
            > /etc/apt/sources.list.d/caddy-stable.list
        apt-get update -y >/dev/null 2>&1
        apt-get install -y caddy >/dev/null 2>&1
    elif command -v dnf &> /dev/null; then
        dnf install -y 'dnf-command(copr)' >/dev/null 2>&1
        dnf copr enable -y @caddy/caddy >/dev/null 2>&1
        dnf install -y caddy >/dev/null 2>&1
    else
        echo -e "${RED}  Unsupported package manager. Install Caddy manually then add the Caddyfile snippet below to /etc/caddy/Caddyfile.${NC}"
        DOMAIN=""
    fi

    if [ -n "$DOMAIN" ]; then
        # /etc/caddy/Caddyfile — single virtual host that proxies wss:// to LiveKit.
        # `reverse_proxy` handles WebSocket upgrade automatically.
        cat > /etc/caddy/Caddyfile << EOF
{
    email ${EMAIL}
}

${DOMAIN} {
    reverse_proxy localhost:7880
}
EOF

        systemctl enable caddy >/dev/null 2>&1
        systemctl restart caddy
        sleep 3

        if systemctl is-active --quiet caddy; then
            echo -e "${GREEN}  Caddy is running. SSL certificate will be issued on first request to ${DOMAIN}.${NC}"
        else
            echo -e "${RED}  Caddy failed to start. Run 'journalctl -u caddy -n 30' to inspect.${NC}"
            DOMAIN=""
        fi
    fi
fi

# ─── Public IP detection ───
PUBLIC_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || curl -s --max-time 5 https://ifconfig.me 2>/dev/null || echo "YOUR_SERVER_IP")

# ─── Verify external port accessibility ───
echo ""
echo -e "${YELLOW}Verifying external port accessibility...${NC}"

PORTS_VERIFIED=false
if [ "$PUBLIC_IP" != "YOUR_SERVER_IP" ]; then
    HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 "http://${PUBLIC_IP}:7880" 2>/dev/null)
    if [ "$HTTP_CODE" = "200" ]; then
        PORTS_VERIFIED=true
    fi
fi

if [ "$PORTS_VERIFIED" = true ]; then
    echo -e "${GREEN}  Port 7880 is externally accessible!${NC}"
else
    echo -e "${YELLOW}  Could not verify external access from this machine.${NC}"
fi

# ─── Result ───
echo ""
echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}  LiveKit is running!${NC}"
echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo ""
echo -e "  Use these values in HiChat! when adding a self-hosted LiveKit server:"
echo ""

if [ -n "$DOMAIN" ]; then
    echo -e "  ${CYAN}URL:        ${NC}wss://${DOMAIN}"
    echo -e "  ${YELLOW}  (works in web browsers — Caddy handles TLS termination)${NC}"
else
    echo -e "  ${CYAN}URL:        ${NC}ws://${PUBLIC_IP}:7880"
    echo -e "  ${YELLOW}  (Electron desktop only — browsers reject ws:// from HTTPS pages)${NC}"
fi
echo -e "  ${CYAN}API Key:    ${NC}${API_KEY}"
echo -e "  ${CYAN}API Secret: ${NC}${API_SECRET}"

if [ "$PORTS_VERIFIED" = true ]; then
    echo ""
    echo -e "  ${GREEN}Ports are externally accessible. You're all set!${NC}"
else
    echo ""
    echo -e "  ${YELLOW}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "  ${YELLOW}║  IMPORTANT: CLOUD FIREWALL                             ║${NC}"
    echo -e "  ${YELLOW}║                                                        ║${NC}"
    echo -e "  ${YELLOW}║  Could not verify external port access.                ║${NC}"
    echo -e "  ${YELLOW}║  If your VPS provider has a web-based firewall         ║${NC}"
    echo -e "  ${YELLOW}║  (Hetzner, DigitalOcean, AWS Security Groups, etc.),   ║${NC}"
    echo -e "  ${YELLOW}║  make sure these ports are open:                       ║${NC}"
    echo -e "  ${YELLOW}║                                                        ║${NC}"
    echo -e "  ${YELLOW}║    7880  TCP   (signaling)                             ║${NC}"
    echo -e "  ${YELLOW}║    7881  TCP   (TURN relay)                            ║${NC}"
    echo -e "  ${YELLOW}║    7882  UDP   (media)                                 ║${NC}"
    echo -e "  ${YELLOW}║    50000-60000 UDP (ICE candidates)                    ║${NC}"
    [ -n "$DOMAIN" ] && echo -e "  ${YELLOW}║    80, 443 TCP (Caddy + Let's Encrypt)                ║${NC}"
    echo -e "  ${YELLOW}╚══════════════════════════════════════════════════════════╝${NC}"
fi

echo ""
echo -e "  Manage:  systemctl {start|stop|restart|status} livekit"
[ -n "$DOMAIN" ] && echo -e "  Caddy:   systemctl {start|stop|restart|status} caddy"
echo -e "  Logs:    journalctl -u livekit -f"
echo -e "  Config:  ${INSTALL_DIR}/livekit.yaml"
echo ""
echo -e "${CYAN}═══════════════════════════════════════${NC}"
