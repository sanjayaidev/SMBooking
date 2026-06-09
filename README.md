# AutoSend — Bulk Message & Trigger Dashboard
### GoWA v7.8 · Vercel Serverless

---

## File Structure

```
/
├── index.html          ← The full dashboard UI
├── vercel.json         ← Vercel config (cron + routes)
├── api/
│   ├── gowa.js         ← Proxy to your GoWA v7.8 server (avoids CORS)
│   └── scheduler.js    ← Campaign storage + trigger engine + webhook receiver
└── README.md
```

---

## Setup

### 1. Deploy to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel --prod
```

### 2. Set Environment Variables in Vercel Dashboard

| Variable | Value | Required |
|---|---|---|
| `GOWA_URL` | Your GoWA server URL e.g. `http://your-server:3000` | ✅ |
| `GOWA_AUTH` | base64 of `user:pass` if using basic auth, blank if open | optional |
| `KV_REST_API_URL` | Vercel KV REST URL (from Vercel KV dashboard) | recommended |
| `KV_REST_API_TOKEN` | Vercel KV token | recommended |

> Without KV, the scheduler uses in-memory storage (resets on cold start). For production, add Vercel KV.

### 3. Add Vercel KV Storage (for persistent campaigns & triggers)

1. In Vercel dashboard → Storage → Create → KV
2. Connect to your project
3. Environment variables are auto-added

### 4. Configure GoWA Webhook (for keyword triggers)

In your GoWA server startup, add:
```bash
./whatsapp rest --webhook="https://YOUR-VERCEL-APP.vercel.app/api/scheduler?action=webhook"
```

Or via Docker:
```yaml
command:
  - rest
  - --webhook=https://YOUR-VERCEL-APP.vercel.app/api/scheduler?action=webhook
```

---

## Features

### 📤 Bulk Message
- **Step 1 — Contacts**: Paste CSV or upload `.csv`/`.xlsx`. Columns: `Name, Phone, Message`
- **Step 2 — Message**: Template with `{name}` personalisation, OR per-contact messages from sheet. Supports image/video/file attachments via URL.
- **Step 3 — Schedule**: Send immediately or pick a date/time (Vercel cron fires every minute)
- **Step 4 — Review & Launch**: Summary before send

### ⚡ Trigger Rules
- **Keyword triggers**: Incoming WhatsApp messages matching keywords get auto-replies
  - Match modes: `contains`, `exact`, `starts with`
- **Webhook triggers**: External services (Shopify, Typeform, Zapier) POST to your webhook URL and fire replies
- Enable/disable rules with toggle switch
- Built-in test simulator

---

## GoWA v7.8 Endpoints Used

| Feature | Method | Endpoint |
|---|---|---|
| Status check | GET | `/app/status` |
| Send text | POST | `/send/message` |
| Send image | POST | `/send/image` |
| Send video | POST | `/send/video` |
| Send audio | POST | `/send/audio` |
| Send file | POST | `/send/file` |

All calls route through `/api/gowa?path=...` to avoid CORS.

---

## Cron Schedule

`vercel.json` schedules `/api/scheduler?action=runDue` every minute. This:
1. Checks all campaigns with `status=scheduled` and `sendAt <= now`
2. Sends messages with random delay (10–30s between each)
3. Updates campaign status to `done`

> Requires Vercel Pro for cron jobs. On free tier, campaigns run only when manually triggered via "Run Now".

---

## Safety Limits

- Default: ≤ 200/day, ≤ 100/hour, 30–90s gap (configurable in Settings)
- This uses an **unofficial WhatsApp API** — account bans are possible
- Recommended: use a secondary phone number for bulk sending
