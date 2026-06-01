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

## Troubleshooting

- **502 / Application failed to respond** — Service → Deployments → View logs. Start command must be `npm start`.
- **404 on /** — Ensure `index.html` and `server.js` are in the repo root on GitHub.
- **Agent not registered** — Agent must `POST /register` again after each Railway restart (in-memory store).
