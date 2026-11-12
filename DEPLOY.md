# Deploying Stillblade

This guide puts Stillblade on the internet so other people can play it. It assumes no hosting experience. Read it once end to end before starting.

## The two pieces

Stillblade is two separate programs, and they are hosted in different places:

| Piece | What it is | Where it goes | Rough cost |
|---|---|---|---|
| **Client** | The web page players open: HTML, JavaScript, the map model. It is just static files. | GitHub Pages (or Cloudflare Pages) | Free |
| **Game server** | A Node.js program that runs every match. Players' browsers keep a live WebSocket connection open to it. | One small Linux VPS (virtual private server) | About $5 per month |

Prices change, so check the provider's current pricing page before you buy anything. Small VPS plans from the common providers are typically in the $4 to $7 per month range for 1 CPU and 1 GB of RAM, which is plenty for this server to start with.

### Why the server needs a name (a domain), not just an IP address

GitHub Pages serves the client over **HTTPS**. Browsers refuse to let an HTTPS page open an unencrypted `ws://` connection, so the game server must be reachable over encrypted **`wss://`**. Encryption needs a certificate, and the free, automatic way to get one (Let's Encrypt, which Caddy in this setup handles for you) is built around **host names** like `play.example.com`. Let's Encrypt has started offering certificates for bare IP addresses, but they are short-lived and this setup does not use them; a name is the well-trodden path.

Your options for a name:

- **Buy a domain** (recommended). A `.com` is usually somewhere around $10 to $15 per year; some endings are cheaper, some much more expensive, and renewal prices are often higher than the first year. Check current prices at a registrar. You then use a subdomain of it, for example `play.yourgame.com`, for the server. Most reliable, and you control it.
- **A free dynamic-DNS subdomain** (for example DuckDNS gives you `something.duckdns.org`). Free, and generally works with Let's Encrypt. Trade-offs: you depend on a free third-party service staying up, and the name looks less trustworthy to players.
- **An IP-in-the-name service** such as `sslip.io` (a name like `203-0-113-7.sslip.io` automatically points to `203.0.113.7`). Free and needs no sign-up. Trade-offs: the name changes if your server's IP changes, and certificate rate limits are shared with every other user of the service, so issuance can occasionally fail.
- **Your VPS provider's hostname.** Some providers give each server a public host name. If yours does, and that name resolves to your server's IP, it can work too. Not every provider offers one, so check.

Everything below calls your server's name **`play.example.com`**. Replace it with your real one everywhere.

### The order you will do things in

1. Part B first, steps 1 to 6: rent the VPS and point your name at it (DNS can take a while to spread, so start early).
2. Finish Part B: start the server and check `https://play.example.com/health`.
3. Part A: publish the client, telling it the server is at `wss://play.example.com`.
4. Part C: play a test match.

You can do Part A first if you prefer, but the game will not connect until the server is up.

---

## Part A: client on GitHub Pages (free)

The repository already contains a workflow, `.github/workflows/deploy-client.yml`, that builds the client and publishes it. It only runs when you press a button, so nothing is published by accident.

### A1. Turn on GitHub Pages

1. Open the repository on GitHub.
2. Go to **Settings > Pages**.
3. Under **Build and deployment > Source**, choose **GitHub Actions**.

### A2. Tell the build where the game server is

1. Go to **Settings > Secrets and variables > Actions**.
2. Open the **Variables** tab (not Secrets: the server address is not secret, and it ends up inside the public JavaScript anyway).
3. Click **New repository variable**.
4. Name: `SERVER_URL`. Value: `wss://play.example.com` (your server's name, starting with `wss://`, no trailing slash).

The workflow stops with a clear error if this variable is missing or does not start with `wss://`.

### A3. Run the workflow

1. Go to the **Actions** tab.
2. Choose **Deploy client to GitHub Pages** in the left list.
3. Click **Run workflow**, keep the branch as `main`, and confirm.
4. Wait for both jobs (build, deploy) to turn green. The deploy job shows the page link.

The game will be at:

```text
https://<your-github-username>.github.io/<repository-name>/
```

For this repository that is `https://pakdragoon.github.io/stillblade/`. Note that the **origin** of that page, which the server needs to know about in Part B, is just `https://pakdragoon.github.io` (scheme and host, no path, lowercase).

Whenever you change the client or the server address, run the workflow again.

### Alternative: Cloudflare Pages

If you prefer Cloudflare Pages (also free), create a Pages project connected to the GitHub repository and use:

- **Build command:** `npm run build:client`
- **Build output directory:** `dist/client`
- **Environment variables:** `VITE_SERVER_URL` = `wss://play.example.com`, and `NODE_VERSION` = `22`

Your page origin will then be something like `https://<project-name>.pages.dev`; use that in `SB_ALLOWED_ORIGINS` (Part B, step 9). Note that Cloudflare Pages normally rebuilds on every push, unlike the manual GitHub workflow.

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
- **Name / host:** `play` (for `play.example.com`; use `@` if you want the bare domain)
- **Value / points to:** your VPS IP, `203.0.113.7`
- **TTL:** the default, or 300 seconds

For a free dynamic-DNS name, set its IP to your VPS IP on that service's website instead. For an `sslip.io`-style name there is nothing to do.

DNS changes can take from a minute to a few hours to spread. Check from your own computer; it should print your VPS IP:

```bash
nslookup play.example.com
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

- `SB_DOMAIN` to your server name, for example `play.example.com` (no `https://`).
- `SB_ALLOWED_ORIGINS` to the origin of the page players open, for example `https://pakdragoon.github.io`. Several origins can be listed separated by commas, for example `https://pakdragoon.github.io,https://stillblade.pages.dev`. Connections from any other page are refused.

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
curl https://play.example.com/health
```

You should see something like `{"ok":true,"rooms":0,"players":0}`. If you get a certificate error right after starting, wait a minute: Caddy needs a moment to get the certificate the first time.

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

If the update changed the client too, also re-run the GitHub Pages workflow (Part A3).

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

1. Open `https://<your-github-username>.github.io/<repository-name>/` in a browser.
2. Join a match. Open the same page in a second browser or on another device and join the same room; you should see each other.
3. If it does not connect, open the browser's developer tools (F12), look at the **Console** and the **Network** tab (filter by "WS"), and use the troubleshooting list below.
4. On the server, `docker compose logs -f game` should show lines like `player 1 joined`.

## Troubleshooting

**Console says "Mixed Content" or mentions `ws://`.** The page is HTTPS but the client was built pointing at a `ws://` address, or without any address (it then guesses `wss://<page host>:8080`, which is wrong for GitHub Pages). Set the `SERVER_URL` repository variable to `wss://play.example.com` and re-run the Pages workflow. For Cloudflare Pages, check `VITE_SERVER_URL` and trigger a new build.

**The WebSocket opens and immediately closes; the server log or the Network tab shows "Origin not allowed" (close code 1008).** `SB_ALLOWED_ORIGINS` in `deploy/.env` does not exactly match the page origin. It must be scheme plus host only, lowercase, no path and no trailing slash: `https://pakdragoon.github.io`, not `https://pakdragoon.github.io/stillblade/`. After editing `.env`, apply it with `docker compose up -d`.

**`nslookup` shows no address or an old address.** DNS has not spread yet, or the A record is wrong. Double-check the record at your registrar, then wait. Until it is right, Caddy cannot get a certificate.

**`curl https://play.example.com/health` times out, or "connection refused".** A firewall is blocking ports 80/443: check `sudo ufw status` on the server and the provider's cloud firewall. Check that both containers are running with `docker compose ps`.

**Certificate errors ("not secure", "certificate not valid") that last more than a few minutes.** Look at `docker compose logs caddy`. Common causes: DNS does not point at this server yet; port 80 or 443 is blocked (Let's Encrypt must reach port 80 or 443 to verify you own the name); `SB_DOMAIN` has a typo or includes `https://`. Fix the cause and run `docker compose restart caddy`. If you have failed many times in a row, Let's Encrypt may make you wait (up to about an hour) before trying again.

**The health check works but the game says it cannot reach the server.** Check the `SERVER_URL` variable has no typo and no trailing path, and that the Pages workflow was re-run after you set it. Hard-refresh the page (Ctrl+F5) to bypass the browser cache.

**`docker compose up` complains that `SB_DOMAIN` or `SB_ALLOWED_ORIGINS` is not set.** You are not in the `deploy` folder, or `deploy/.env` does not exist or misspells the names. Compare with `.env.example`.

**The server runs out of memory during `--build`.** Very small VPS plans can struggle with `npm ci` during the build. Add a swap file (search "Ubuntu add swap file") or pick a plan with more RAM.

## What this setup does not do yet

- **One region.** All players connect to one server in one place; players far away will have high ping.
- **One server process.** All rooms run in a single Node.js process on one machine. If it is busy or down, the game is down. There is no automatic failover.
- **No matchmaking across servers.** Rooms exist only on this one server; there is no lobby service spreading players over several machines.
- **No accounts.** Players are anonymous; names are not reserved and there is no login, ban list or persistent stats.
- **No DDoS protection** beyond whatever your VPS provider includes by default. The server has basic per-IP connection limits, but a determined flood can still take it offline.
- **No automatic deployments.** Updating the server is a manual `git pull` plus `docker compose up -d --build`; updating the client is a manual workflow run.
- **No backups needed, and none set up.** The server keeps no saved data except Caddy's certificates, which it can re-issue.
