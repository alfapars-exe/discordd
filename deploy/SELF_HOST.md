# Self-Hosting LiveKit for HiChat!

LiveKit Cloud's free tier (10,000 min/month) can fill up quickly even for
a small community. Self-hosting on a real VPS is straightforward and
avoids that ceiling.

> **Note:** Hugging Face Spaces cannot host a LiveKit server. They only
> expose a single TCP port and don't allow UDP, while LiveKit needs UDP
> for real-time media. Use a real VPS (Hetzner, DigitalOcean, Vultr, OVH,
> Linode, Fly.io, etc.).

## What you'll need

1. A VPS with a public IPv4. Recommended specs:
   - **Hetzner CX22** — €4.51/mo, 2 vCPU, 4 GB RAM, 20 TB traffic
   - DigitalOcean's $4 Droplet, Vultr's Cloud Compute, OVH's $4 VPS, etc.
   - Ubuntu 22.04 or Debian 12 (the script supports both apt and dnf)
2. **(Recommended) A domain** pointed at the VPS IP. Required if web
   browsers are going to connect — without TLS the browser refuses
   `ws://` connections from the HTTPS HiChat! page.
   - Free options: DuckDNS subdomains (`yourname.duckdns.org`),
     `*.sslip.io`, etc.
   - Cheap options: Namecheap, Porkbun (~$3/year for `.xyz`).

## One-shot install

SSH into your VPS as root (or with `sudo`). Then run **one** of:

### A) Plain ws:// — Electron desktop only

If your community only uses the desktop apps, this is enough. Browsers
will refuse to connect because of mixed-content rules.

```bash
curl -fsSL https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/livekit-setup.sh | sudo bash
```

### B) wss:// with auto-SSL — works everywhere (recommended)

If anyone uses the web client, do this. The script installs Caddy and
provisions a Let's Encrypt certificate automatically.

```bash
curl -fsSL https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/livekit-setup.sh \
  | sudo DOMAIN=livekit.yourdomain.com EMAIL=you@yourdomain.com bash
```

Replace `livekit.yourdomain.com` with whatever you pointed at your VPS.

The `DOMAIN`'s A record must already resolve to the VPS — Let's Encrypt
checks this during cert issuance.

## What the script does

1. Installs the `livekit-server` binary
2. Opens the firewall (`ufw` / `firewalld`):
   - 7880 TCP (signaling)
   - 7881 TCP (TCP fallback)
   - 7882 UDP, 50000-60000 UDP (RTP media)
   - 80 + 443 TCP (only when `DOMAIN` is set, for Caddy)
3. Generates a fresh API Key + Secret
4. Writes `/opt/livekit/livekit.yaml`
5. Starts `livekit.service` via systemd (auto-restart on crash)
6. **(B only)** Installs Caddy, writes `/etc/caddy/Caddyfile`,
   provisions an LE cert, terminates TLS, proxies `wss://DOMAIN/` to
   `ws://localhost:7880`

The script prints the URL + credentials at the end. Copy them.

## Plug it into HiChat!

1. Sign in as the platform admin (alfapars).
2. **Ayarlar → Platform → LiveKit Sunucuları → Yeni Sunucu**
3. Fill in:
   - **URL**: `wss://livekit.yourdomain.com` (option B) OR
     `ws://YOUR_SERVER_IP:7880` (option A — only Electron clients can use)
   - **API Key** + **API Secret** from the script output
   - **Hetzner Server ID** (optional): if you're on Hetzner and you set
     `HETZNER_API_TOKEN` in your HiChat! Space secrets, the admin panel
     will display CPU + bandwidth metrics for this instance.
4. Save. New voice channels will route to this instance per your
   region/load configuration.

## Verifying it works

On the VPS:

```bash
systemctl status livekit
journalctl -u livekit -f
# (option B only)
systemctl status caddy
```

From outside, hit the health endpoint:

```bash
# option A
curl http://YOUR_SERVER_IP:7880/
# option B
curl https://livekit.yourdomain.com/
```

LiveKit returns `OK` when healthy.

## Capacity sizing

A Hetzner CX22 (2 vCPU / 4 GB / Frankfurt) handles:

- **~50 concurrent voice participants** comfortably
- **~10 concurrent screen shares at 1080p30** (CPU bound)
- The 20 TB monthly traffic includes is way beyond what a small
  community will hit

For larger needs, scale up to CX32 / CX42, or run multiple instances
and use HiChat!'s region-based instance selection in the admin panel.

## Costs (rough, 2026)

| Provider | Smallest plan | Region | Notes |
|---|---|---|---|
| Hetzner | CX22 — €4.51/mo | Falkenstein/Helsinki/Nuremberg | Best price/perf, EU data residency |
| DigitalOcean | Basic — $4/mo | NYC/AMS/SGP | Larger global footprint |
| Vultr | Cloud Compute — $5/mo | 30+ regions | More regions, slightly worse perf |
| OVH | VPS Comfort — €5.99/mo | EU + Canada + Australia | Good for FR users |
| Fly.io | Hobby — free tier | 30+ regions | UDP-supported, harder to ops |

Compared to LiveKit Cloud Build plan ($50/mo), self-hosting on a CX22
is ~10× cheaper at the cost of operational responsibility (SSL renewal
is automatic via Caddy, but security updates and monitoring are on you).
