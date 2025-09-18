# Anchor Operator Researcher (Gemini + Playwright)

A tiny demo that:

1. searches a topic and curates **5 trustworthy sources**
2. launches an **Anchor Browser** session (Playwright over CDP)
3. lets you **watch** and do HITL Google login via Live View
4. drafts a \~1-page paper (Gemini) and types it into **Google Docs**

---

## Prereqs

* Node.js **18.17+** (Node 20.6+/22+ recommended)
* Anchor Browser API key
* Serper.dev API key (for search)
* (Optional) Gemini API key (or Google API key) for the paper draft

---

## Setup

```bash
git clone <your-private-repo-url>
cd anchor-operator-researcher

# env
cp .env.sample .env.local     # fill in keys

# deps
npm install
npx playwright install chromium
```

**`.env.local` (example)**

```dotenv
ANCHOR_API_KEY=anc_sk_your_api_key_here
SERPER_API_KEY=serper_your_key_here

# Gemini (optional)
GEMINI_API_KEY=your_gemini_or_google_api_key_here
GEMINI_TEXT_MODEL=gemini-1.5-flash
USE_GEMINI_TEXT_GEN=true

# Session behavior (optional)
KEEP_SESSION_ON_SUCCESS=false
CLOSE_ON_ERROR=true
```

---

## Run

```bash
# with env-file flag (recommended)
node --env-file=.env.local anchor_operator_researcher.mjs "Impacts of microplastics on marine food webs"

# or via npm script if you added it:
npm run start:anchor
```

When the script starts, it will:

* print a **Session ID** and a **Live View** link
* pause for you to sign into Google (HITL), then continue automatically

---

## Watching the agent (Live View)

Open this URL in your browser (replace with the active session id):

```
https://live.anchorbrowser.io/?sessionId=<SESSION_ID>
```

That’s the easiest way to **watch** the agent in real time while you complete login or supervise actions.

> You can also embed that URL in your own UI (iframe/panel) for demos.

---

## What it does

* **Search & rank** via Serper (trust + recency bias)
* **HITL gate**: navigates to Google login and waits until you’re signed in
* **Draft**: uses Gemini to generate \~1 page (falls back to template if not configured)
* **Type**: opens `docs.new` and types the paper into a Google Doc
* **Session hygiene**: ends session on error; can keep alive on success (see env flags)

---

## Troubleshooting

* **Can’t see Live View**: confirm the `sessionId` is from the current run and that your network allows the Live View domain.
* **Login loop**: finish the Google sign-in inside Live View; after success, the script continues.
* **CDP connect issues**: some corporate proxies block WebSocket/CDP—check firewall rules.

---

## Security

* Do **not** commit `.env.local`.
* Treat Live View URLs as sensitive—they expose an active browser session.

---
