# Deploying Stillblade

This guide puts Stillblade on the internet so other people can play it. It assumes no hosting experience. Read it once end to end before starting.

## First friends test: your steps in order

Nothing here is assumed. Each step points to the part below that explains it. Only you can do these: they involve accounts, money or your DNS.

Planned names (change them if you change your mind):

| What | Address |
|---|---|
| Players open (client, Cloudflare Pages) | `https://stillblade.orcavalley.com` |
| Game server (VPS behind Caddy) | `stillblade-server.orcavalley.com` |
| `VITE_SERVER_URL` (client build setting) | `wss://stillblade-server.orcavalley.com` |
| `SB_DOMAIN` (server `deploy/.env`) | `stillblade-server.orcavalley.com` |
| `SB_ALLOWED_ORIGINS` (server `deploy/.env`) | `https://stillblade.orcavalley.com` |

1. **Get the latest code onto GitHub's `main` branch** (merge and push). The VPS builds the server from it and Cloudflare Pages builds the client from it.
2. **Rent a small Ubuntu VPS** (1 GB RAM is enough; any provider) and note its public IPv4 address (B1, B2). Make an SSH key first if you have none.
3. **In Cloudflare DNS for `orcavalley.com`, add an `A` record**: name `stillblade-server`, value the VPS IP, and set the proxy status to **DNS only** (grey cloud, not orange). Wait until `nslookup stillblade-server.orcavalley.com` prints the VPS IP (B6). See "Cloudflare proxying" under Part B for why grey.
4. **Log in, create your user, switch on the firewall, install Docker** (B3, B4, B5).
5. **Clone the repository on the VPS and fill in `deploy/.env`** (B7, B8) with the `SB_DOMAIN` and `SB_ALLOWED_ORIGINS` from the table.
6. **Start the server**: `docker compose up -d --build` in the `deploy` folder (B9). Open `https://stillblade-server.orcavalley.com/health`; you should see `{"ok":true,...}`. `docker compose logs game` must say `maps greybox, warehouse (default warehouse)`.
7. **Create the client on Cloudflare Pages** (Part A): connect the GitHub repository, build command `npm run build:client`, output folder `dist/client`, variables `VITE_SERVER_URL` and `NODE_VERSION`, then add the custom domain `stillblade.orcavalley.com`.
8. **Play**: open `https://stillblade.orcavalley.com`, choose a map and room code, and send friends a link such as `https://stillblade.orcavalley.com/?map=warehouse&room=ABCD`. Maps: `greybox` (shown as "Test Map 1") and `warehouse`.

If something fails, see Troubleshooting at the bottom.

## The two pieces

Stillblade is two separate programs, and they are hosted in different places:

| Piece | What it is | Where it goes | Rough cost |
|---|---|---|---|
| **Client** | The web page players open: HTML, JavaScript, the map model. It is just static files. | Cloudflare Pages (GitHub Pages also works) | Free |
| **Game server** | A Node.js program that runs every match. Players' browsers keep a live WebSocket connection open to it. | One small Linux VPS (virtual private server) | About $5 per month |

Prices change, so check the provider's current pricing page before you buy anything. Small VPS plans from the common providers are typically in the $4 to $7 per month range for 1 CPU and 1 GB of RAM, which is plenty for this server to start with.

### Why the server needs a name (a domain), not just an IP address

Cloudflare Pages (and GitHub Pages) serves the client over **HTTPS**. Browsers refuse to let an HTTPS page open an unencrypted `ws://` connection, so the game server must be reachable over encrypted **`wss://`**. Encryption needs a certificate, and the free, automatic way to get one (Let's Encrypt, which Caddy in this setup handles for you) is built around **host names** like `stillblade-server.orcavalley.com`. Let's Encrypt has started offering certificates for bare IP addresses, but they are short-lived and this setup does not use them; a name is the well-trodden path.

Your options for a name:

- **Buy a domain** (recommended). A `.com` is usually somewhere around $10 to $15 per year; some endings are cheaper, some much more expensive, and renewal prices are often higher than the first year. Check current prices at a registrar. You then use a subdomain of it, for example `play.yourgame.com`, for the server. Most reliable, and you control it.
- **A free dynamic-DNS subdomain** (for example DuckDNS gives you `something.duckdns.org`). Free, and generally works with Let's Encrypt. Trade-offs: you depend on a free third-party service staying up, and the name looks less trustworthy to players.
- **An IP-in-the-name service** such as `sslip.io` (a name like `203-0-113-7.sslip.io` automatically points to `203.0.113.7`). Free and needs no sign-up. Trade-offs: the name changes if your server's IP changes, and certificate rate limits are shared with every other user of the service, so issuance can occasionally fail.
- **Your VPS provider's hostname.** Some providers give each server a public host name. If yours does, and that name resolves to your server's IP, it can work too. Not every provider offers one, so check.

The planned server name is **`stillblade-server.orcavalley.com`**; if you use a different one, replace it everywhere below.

### The order you will do things in

1. Part B first, steps 1 to 6: rent the VPS and point your name at it (DNS can take a while to spread, so start early).
2. Finish Part B: start the server and check `https://stillblade-server.orcavalley.com/health`.
3. Part A: publish the client, telling it the server is at `wss://stillblade-server.orcavalley.com`.
4. Part C: play a test match.

You can do Part A first if you prefer, but the game will not connect until the server is up.

## Part A: client on Cloudflare Pages (free)

The client is static files. Cloudflare Pages builds them from the GitHub repository and serves them. Nothing in the repository needs changing: the build uses relative asset paths (`base: './'` in `vite.config.ts`), so it works at the site root (the plan here) and equally under a sub-path such as `/stillblade/`.

### A1. Create the Pages project

1. In the Cloudflare dashboard open **Workers & Pages > Create > Pages > Connect to Git** and pick the `stillblade` repository (this asks you to authorize Cloudflare on GitHub).
2. Production branch: `main`.
3. Build settings:
   - **Build command:** `npm run build:client`
   - **Build output directory:** `dist/client`
   - **Root directory:** leave empty (the repository root).
4. **Environment variables** (Production): `VITE_SERVER_URL` = `wss://stillblade-server.orcavalley.com` (starts with `wss://`, no trailing slash) and `NODE_VERSION` = `22`. `VITE_SERVER_URL` is baked into the JavaScript at build time, so changing it later needs a new build.
5. Save and deploy, and wait for the build to turn green.

### A2. Use your own address

In the project open **Custom domains > Set up a custom domain** and enter `stillblade.orcavalley.com`. Because `orcavalley.com` is already on Cloudflare, it adds the DNS record for you. This record is for the *client* and is meant to be proxied; only the game server's record must be DNS only.

The page's **origin** (what the game server checks, Part B step B8) is `https://stillblade.orcavalley.com`: scheme and host only, lowercase, no path. Cloudflare also gives the project a `<project>.pages.dev` address; browsers opening that address are refused by the server unless you also list it in `SB_ALLOWED_ORIGINS` (comma-separated).

Cloudflare Pages rebuilds on every push to `main`. If you only changed the server, no client rebuild is needed.

### Alternative: GitHub Pages

The repository also has `.github/workflows/deploy-client.yml`, which builds the client and publishes it to GitHub Pages when you press a button.

1. **Settings > Pages > Build and deployment > Source**: choose **GitHub Actions**.
2. **Settings > Secrets and variables > Actions > Variables > New repository variable**: `SERVER_URL` = `wss://stillblade-server.orcavalley.com`. The workflow stops with a clear error if it is missing or does not start with `wss://`.
3. **Actions** tab > **Deploy client to GitHub Pages** > **Run workflow** on `main`.

The game is then at `https://pakdragoon.github.io/stillblade/` (a sub-path; this works because of the relative `base`), and the origin to allow on the server is `https://pakdragoon.github.io`. Re-run the workflow whenever the client or the server address changes.

---

## Part B: game server on a VPS (about $5 per month)

### B1. Choose a region

Pick a data-centre region close to where most of your players are. Latency (ping) matters a lot in a shooter: every 1,000 km adds very roughly 10 ms or more. There is only one server in this setup, so players far from it will have a worse experience.

### B2. Create the VPS

Any mainstream provider works. When creating the server:

- **Image / OS:** Ubuntu LTS (the newest "LTS" version offered).
- **Size:** the smallest plan with 1 GB of RAM is enough to start.
- **Region:** from B1.
- **Authentication:** choose **SSH key**, not password. If you do not have a key yet, create one on your own computer (this works in Windows PowerShell, macOS and Linux), press Enter to accept the defaults, and set a passphrase when asked:

```bash
ssh-keygen -t ed25519
```

Then paste the contents of the **public** key (the file ending in `.pub`, usually `~/.ssh/id_ed25519.pub`) into the provider's SSH key box. Never share the file without `.pub`.

- If the provider offers a **cloud firewall**, create one allowing inbound TCP 22, 80 and 443 and UDP 443 only, and attach it to the server. This is a second layer on top of the firewall in B4.

When the server is ready, note its **public IPv4 address**. Below it is shown as `203.0.113.7`.

### B3. Log in and create your own user

Log in as root (the first time you will be asked to confirm the server's fingerprint; type `yes`):

```bash
ssh root@203.0.113.7
```

Create a normal user (replace `stillblade` with any name you like) and give it admin rights:

```bash
adduser stillblade
```

```bash
usermod -aG sudo stillblade
```

Copy your SSH key to the new user so you can log in as it:

```bash
rsync --archive --chown=stillblade:stillblade ~/.ssh /home/stillblade
```

Open a **second** terminal on your own computer and check that this works before going further:

```bash
ssh stillblade@203.0.113.7
```

From now on, use this user, not root.

### B4. Basic hardening

Turn off password logins and root logins over SSH (keys only). This writes a small settings file and restarts SSH:

```bash
printf 'PasswordAuthentication no\nPermitRootLogin no\n' | sudo tee /etc/ssh/sshd_config.d/99-stillblade.conf
```

```bash
sudo systemctl restart ssh
```

Keep your current session open and test a new login from another terminal (`ssh stillblade@203.0.113.7`) before closing anything.

Turn on the firewall, allowing only SSH (22), HTTP (80, needed for the certificate) and HTTPS (443):

```bash
sudo ufw allow OpenSSH
```

```bash
sudo ufw allow 80/tcp
```

```bash
sudo ufw allow 443
```

```bash
sudo ufw enable
```

```bash
sudo ufw status
```

Good to know: Docker manages its own firewall rules, and ports that a container publishes are reachable even if `ufw` does not list them. In this setup only Caddy publishes ports (80 and 443, which you want open anyway); the game server's port 8080 is deliberately not published, so it is only reachable through Caddy. The provider's cloud firewall from B2 covers this gap as well.

Turn on automatic security updates (often already on with Ubuntu; these commands make sure):

```bash
sudo apt update
```

```bash
sudo apt install -y unattended-upgrades
```

```bash
sudo dpkg-reconfigure -plow unattended-upgrades
```

Answer **Yes**. Occasionally an update needs a reboot; when you log in and see "System restart required", run `sudo reboot`. The game comes back on its own afterwards.

### B5. Install Docker

Docker runs the game server and Caddy in containers so you do not have to install Node.js or configure a web server by hand. Docker's official install script:

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
```

```bash
sudo sh get-docker.sh
```

Let your user run Docker without `sudo` (note: this group is effectively admin-level access):

```bash
sudo usermod -aG docker $USER
```

Log out and back in so that takes effect, then check:

```bash
docker compose version
```

### B6. Point your domain at the server

At your domain registrar (or DNS provider), add a DNS record:

- **Type:** `A`
- **Name / host:** `stillblade-server` (for `stillblade-server.orcavalley.com`). In Cloudflare DNS set **Proxy status: DNS only** (grey cloud).
- **Value / points to:** your VPS IP, `203.0.113.7`
- **TTL:** the default, or 300 seconds

For a free dynamic-DNS name, set its IP to your VPS IP on that service's website instead. For an `sslip.io`-style name there is nothing to do.

DNS changes can take from a minute to a few hours to spread. Check from your own computer; it should print your VPS IP:

```bash
nslookup stillblade-server.orcavalley.com
```

Do not continue to B9 until this shows the right IP, otherwise the certificate request fails (Caddy retries, but Let's Encrypt limits how often you can fail).

### B7. Get the code onto the server

```bash
sudo apt install -y git
```

```bash
git clone https://github.com/PakDragoon/stillblade.git
```

```bash
cd stillblade/deploy
```

(If the repository is private, cloning over HTTPS will ask for credentials; the simplest fix is a read-only "deploy key" added under the repository's **Settings > Deploy keys**, then cloning with the `git@github.com:...` address.)

### B8. Fill in the settings file

Copy the example and edit it:

```bash
cp .env.example .env
```

```bash
nano .env
```

Set:

- `SB_DOMAIN` to your server name, for example `stillblade-server.orcavalley.com` (no `https://`).
- `SB_ALLOWED_ORIGINS` to the origin of the page players open: `https://stillblade.orcavalley.com`. Several origins can be listed separated by commas (for example if you also use GitHub Pages: `https://stillblade.orcavalley.com,https://pakdragoon.github.io`). Connections from any other page are refused.

Save with Ctrl+O, Enter, then exit with Ctrl+X. This file is ignored by git and stays on the server.

### B9. Start everything

This builds the game server image and starts it plus Caddy in the background. The first build takes a few minutes on a small VPS:

```bash
docker compose up -d --build
```

Check that both containers are running (the game server shows `healthy` after about half a minute):

```bash
docker compose ps
```

### B10. Check the health endpoint

From your own computer (or just open the address in a browser):

```bash
curl https://stillblade-server.orcavalley.com/health
```

You should see something like `{"ok":true,"rooms":0,"players":0}`. If you get a certificate error right after starting, wait a minute: Caddy needs a moment to get the certificate the first time.

### Cloudflare proxying: why the server record must be "DNS only"

In Cloudflare DNS each record has a proxy status. For `stillblade-server` it must be **DNS only** (grey cloud). With the orange cloud, players would reach Cloudflare's servers instead of yours, and this setup is not built for that:

- **The certificate.** Caddy gets its Let's Encrypt certificate by proving it controls the name, which assumes the name points straight at the VPS. Behind the proxy, Cloudflare's own certificate is what players see, and Cloudflare must also be told to trust the one on your server.
- **Player addresses.** The server limits connections per player IP, using the `X-Forwarded-For` header Caddy sees (`SB_TRUST_PROXY=1`). Behind Cloudflare that would be Cloudflare's address for everyone, so players would block each other after a few connections.

If you later want it proxied (for example for DDoS protection), these would have to change: set the Cloudflare SSL/TLS mode to **Full (strict)** and give Caddy a certificate Cloudflare accepts (a Cloudflare Origin Certificate, or Let's Encrypt via the DNS challenge, which needs a Caddy build with the Cloudflare DNS plugin); make the per-IP limit use the `CF-Connecting-IP` header instead of `X-Forwarded-For` (a small change in `server/src/main.ts`, plus only accepting traffic from Cloudflare's address ranges); and re-test WebSockets through the proxy. None of this is done or tested here.

### Everyday tasks

All of these are run on the server from the `stillblade/deploy` folder.

View the game server's log (Ctrl+C stops watching; the server keeps running):

```bash
docker compose logs -f game
```

View Caddy's log (certificate problems show up here):

```bash
docker compose logs -f caddy
```

Update to the newest version from GitHub (players in a match are disconnected for a few seconds):

```bash
git pull
```

```bash
docker compose up -d --build
```

If the update changed the client too, also re-run the client: Cloudflare Pages rebuilds by itself on every push to `main`; with GitHub Pages, re-run the workflow (Part A).

Restart the game server only:

```bash
docker compose restart game
```

Stop everything:

```bash
docker compose down
```

The containers are set to `restart: unless-stopped`, so they start again automatically after a crash or a server reboot, unless you stopped them yourself with `docker compose down` or `stop`.

Clean up old images after a few updates, to save disk space:

```bash
docker image prune -f
```

---

## Part C: check it works end to end

1. Open `https://stillblade.orcavalley.com` in a browser.
2. Join a match on each map (use the Map menu, or add `?map=greybox` / `?map=warehouse` to the address). Open the same page in a second browser or on another device and join the same room code; you should see each other. The map is chosen by whoever creates the room; later joiners get that room's map.
3. If it does not connect, open the browser's developer tools (F12), look at the **Console** and the **Network** tab (filter by "WS"), and use the troubleshooting list below.
4. On the server, `docker compose logs -f game` should show lines like `player 1 joined`.

## Troubleshooting

**Console says "Mixed Content" or mentions `ws://`.** The client was built pointing at a `ws://` address, or without any address (it then guesses `wss://<page host>:8080`, which is wrong). Set `VITE_SERVER_URL` to `wss://stillblade-server.orcavalley.com` in Cloudflare Pages (or the `SERVER_URL` variable for GitHub Pages) and trigger a new build.

**The WebSocket opens and immediately closes; the server log or the Network tab shows "Origin not allowed" (close code 1008).** `SB_ALLOWED_ORIGINS` in `deploy/.env` does not exactly match the page origin. It must be scheme plus host only, lowercase, no path and no trailing slash: `https://stillblade.orcavalley.com`, not `https://stillblade.orcavalley.com/` or `.../stillblade/`. After editing `.env`, apply it with `docker compose up -d`.

**`nslookup` shows no address or an old address.** DNS has not spread yet, or the A record is wrong. Double-check the record at your registrar, then wait. Until it is right, Caddy cannot get a certificate.

**`curl https://stillblade-server.orcavalley.com/health` times out, or "connection refused".** A firewall is blocking ports 80/443: check `sudo ufw status` on the server and the provider's cloud firewall. Check that both containers are running with `docker compose ps`.

**Certificate errors ("not secure", "certificate not valid") that last more than a few minutes.** Look at `docker compose logs caddy`. Common causes: DNS does not point at this server yet; port 80 or 443 is blocked (Let's Encrypt must reach port 80 or 443 to verify you own the name); `SB_DOMAIN` has a typo or includes `https://`. Fix the cause and run `docker compose restart caddy`. If you have failed many times in a row, Let's Encrypt may make you wait (up to about an hour) before trying again.

**The health check works but the game says it cannot reach the server.** Check the `SERVER_URL` variable has no typo and no trailing path, (`VITE_SERVER_URL` on Cloudflare Pages, or the `SERVER_URL` variable for GitHub Pages), and that the client was rebuilt after you set it. Hard-refresh the page (Ctrl+F5) to bypass the browser cache.

**`docker compose up` complains that `SB_DOMAIN` or `SB_ALLOWED_ORIGINS` is not set.** You are not in the `deploy` folder, or `deploy/.env` does not exist or misspells the names. Compare with `.env.example`.

**`docker compose logs game` shows `Cannot use import statement outside a module`.** You are running an old image. Update the code (`git pull`) and rebuild with `docker compose up -d --build`.

**The server runs out of memory during `--build`.** Very small VPS plans can struggle with `npm ci` during the build. Add a swap file (search "Ubuntu add swap file") or pick a plan with more RAM.

## What this setup does not do yet

- **One region.** All players connect to one server in one place; players far away will have high ping.
- **One server process.** All rooms run in a single Node.js process on one machine. If it is busy or down, the game is down. There is no automatic failover.
- **No matchmaking across servers.** Rooms exist only on this one server; there is no lobby service spreading players over several machines.
- **No accounts.** Players are anonymous; names are not reserved and there is no login, ban list or persistent stats.
- **No DDoS protection** beyond whatever your VPS provider includes by default. The server has basic per-IP connection limits, but a determined flood can still take it offline.
- **No automatic deployments.** Updating the server is a manual `git pull` plus `docker compose up -d --build`; updating the client is a manual workflow run.
- **No backups needed, and none set up.** The server keeps no saved data except Caddy's certificates, which it can re-issue.
