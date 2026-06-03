# Railway setup (redirectorhook)

You already deployed from GitHub. Finish these steps in the Railway dashboard.

## Step 1 — Get your public URL (required)

1. Open [railway.app](https://railway.app) → project **awake-upliftment**
2. Click the **redirectorhook** card (GitHub icon, green **Online**)
3. Open the **Settings** tab (gear on the left sidebar, or top tabs inside the service)
4. Scroll to **Networking** → **Public Networking**
5. Click **Generate Domain**
6. Copy the URL shown (example: `https://redirectorhook-production-xxxx.up.railway.app`)

## Step 2 — Test in browser

Replace `YOUR-URL` with the domain from step 1:

| Test | URL |
|------|-----|
| Landing page | `https://YOUR-URL/` |
| Health API | `https://YOUR-URL/api` |
| PhoneLink dial | `https://YOUR-URL/?number=+919876543210` |
| CallBridge route | `https://YOUR-URL/?agent=rahul&number=+919876543210` |

`/api` should return JSON like: `{"status":"CallBridge running","agents":0}`

## Step 3 — Android app

Point registration to:

```
POST https://YOUR-URL/register
```

Body:

```json
{ "agentId": "rahul", "ntfyTopic": "your-ntfy-topic" }
```

## Step 4 — Google Sheets

```excel
=HYPERLINK("https://YOUR-URL/?agent=rahul&number="&B2, "Call")
```

## Step 5 — Optional: custom domain

Settings → Networking → **Custom Domain** → add your own domain and follow DNS instructions.

## Redeploy after code changes

```powershell
cd "c:\Users\HP\Downloads\Click To Call\Redictorhook"
git add .
git commit -m "Update"
git push origin main
```

Railway redeploys automatically on push to `main`.

## Fix 429 quota — self-hosted ntfy on Railway (step by step)

Public **ntfy.sh** blocks you after the daily message quota (`429 limit reached`).  
You need a **second Railway service** running your own ntfy, then point CallBridge at it.

---

### Part A — Deploy ntfy (new service)

#### Option 1 — Docker image (fastest, no Git folder needed)

1. Open [railway.app](https://railway.app) → your project (e.g. **awake-upliftment**).
2. Click **+ New** → **Service** → **Docker Image**.
3. Image name: `binwiederhier/ntfy:latest`
4. Click the new service (name it **ntfy**).
5. **Settings** → **Networking** → **Generate Domain**  
   Copy the URL, e.g. `https://ntfy-production-xxxx.up.railway.app`  
   This is your **NTFY domain** (no trailing slash).

6. **Variables** tab — add:

| Variable | Value |
|----------|--------|
| `NTFY_LISTEN_HTTP` | `:$PORT` |
| `NTFY_BEHIND_PROXY` | `true` |
| `NTFY_BASE_URL` | `https://ntfy-production-xxxx.up.railway.app` (your domain from step 5) |
| `NTFY_CACHE_FILE` | `/data/cache.db` |

Railway sets `PORT` automatically — `NTFY_LISTEN_HTTP=:$PORT` makes ntfy listen on the correct port.

7. **Settings** → **Volumes** → **Add volume** → mount path `/data` (keeps ntfy cache across restarts).
8. Wait until deploy status is **Online** (green).
9. Test in browser: open your ntfy domain — you should see the ntfy web UI.

#### Option 2 — From GitHub (`Redictorhook/ntfy/` folder)

1. Push this repo so `Redictorhook/ntfy/Dockerfile` is on GitHub.
2. **+ New** → **GitHub Repo** → same repo as CallBridge.
3. Click the new service → **Settings** → **Root Directory** = `ntfy` (if repo root is `Redictorhook`, use `ntfy` inside that folder).
4. Follow steps 5–9 from Option 1 (domain + variables + volume).

---

### Part B — Point CallBridge at your ntfy

1. Click your existing **redirectorhook** service (CallBridge).
2. Open **Variables**.
3. Add or edit:

| Variable | Value |
|----------|--------|
| `NTFY_BASE_URL` | `https://ntfy-production-xxxx.up.railway.app` (same as ntfy service, **no** trailing `/`) |

4. Railway redeploys automatically (or click **Deploy**).
5. Verify: open `https://YOUR-REDIRECTORHOOK-URL/api`  
   JSON should include `"ntfyBaseUrl":"https://ntfy-production-xxxx.up.railway.app"` (not `https://ntfy.sh`).

**Also:** push latest `server.js` to GitHub first if you have not since the quota fix.

---

### Part C — Every agent RE-REGISTER (Android)

Each phone must learn the new ntfy server URL once.

1. Open **CallBridge** app on the agent phone.
2. On the main screen, tap the red button **↻ RE-REGISTER (reset device)**.
3. Confirm when asked.
4. Enter **Agent name** again (same name as before, e.g. `rahul`).
5. Tap **Register & enable auto-dial**.
6. Wait for “ready” / connected status.
7. Repeat for **all 11 team phones**.

**Sync only (without full reset):** tap **Sync with server** if shown — works only if the app already has the latest build with `ntfy_base_url` support. After quota fix, **RE-REGISTER** is safer.

---

### Part D — Quick test

1. Open a call link: `https://YOUR-REDIRECTORHOOK-URL/?agent=AGENTNAME&number=9876543210`
2. You should **not** see `ntfy responded with 429`.
3. Agent phone should receive the call notification and dial.

---

### Optional CallBridge caps (usually leave OFF)

| Variable | Default | Purpose |
|----------|---------|---------|
| `ENABLE_CALL_LIMITS` | off | Set `true` only if you want server-side caps |
| `MAX_CALLS_PER_SECOND` | 20 | Burst limit |
| `MAX_CALLS_PER_DAY` | 25000 | Daily limit |

## Troubleshooting

- **502 / Application failed to respond** — Service → Deployments → View logs. Start command must be `npm start`.
- **404 on /** — Ensure `index.html` and `server.js` are in the repo root on GitHub.
- **Agent not registered** — Railway restarted and wiped the registry. Have the agent **open the CallBridge app** once (it re-syncs automatically). Or check `https://YOUR-URL/agents` — list should show their name after they open the app.
- **Agents lost after every deploy** — Add a Railway **Volume** mounted at `/data`, then set variable `DATA_DIR=/data` on the service so `agents.json` survives redeploys.

## Encryption (phone numbers hidden on the wire)

Each agent gets a unique **AES-256 key** at registration. The server **encrypts only** — it never decrypts. Only the CallBridge app on that agent's phone can read the number.

| Layer | What an attacker sees |
|-------|------------------------|
| ntfy message | `enc:v1:...` (gibberish) |
| Encrypted sheet link (`?e=`) | No plain number in URL |
| Plain sheet link (`?number=`) | Number visible in URL — server still encrypts before ntfy |

### Railway variables for encrypted sheet links

| Variable | Example | Purpose |
|----------|---------|---------|
| `SHEET_API_KEY` | long random string | Protects `/encrypt` endpoint |
| `PUBLIC_URL` | `https://redirectorhook-production.up.railway.app` | Correct links from `/encrypt` |

### Google Sheets — encrypted link (recommended)

1. Add `SHEET_API_KEY` in Railway
2. Copy `google-apps-script.gs` into **Extensions → Apps Script**
3. Set your API key in the script
4. Sheet formula:

```excel
=HYPERLINK(CALLBRIDGE_LINK("rahul", B2), "📞 Call")
```

### Re-register after deploy

After updating encryption, every agent must **open CallBridge once** (or tap Re-register) to receive their `agentSecret`.
