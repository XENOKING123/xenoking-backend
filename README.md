# XENOKING backend — accounts + owner approval

Small self-hosted server that controls **who is allowed to use the XENOKING
Auto Lister extension**. Users sign up with an email + password; they land in a
**pending** state until *you* (the owner) approve them. You can also **block**
or **ban** anyone at any time — a blocked/banned user is kicked on their next
action.

It's plain Node.js + Express + SQLite. No external database, no cloud account
required. Runs fine on a cheap VPS (the same box that hosted your old backend
works), or on a free host like Render/Railway/Fly.

---

## What it does

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /api/signup` | anyone | Create a **pending** account (`email`, `password`, optional `name`). |
| `POST /api/login` | anyone | Returns a login token — **only if approved** (or you, the owner). |
| `GET /api/me` | logged in | Re-checks the account is still approved (used by the extension on open). |
| `GET /api/admin/users` | owner | List every sign-up with status. |
| `POST /api/admin/users/:id/approve` | owner | Approve a pending user. |
| `POST /api/admin/users/:id/block` | owner | Block (deny access, reversible). |
| `POST /api/admin/users/:id/ban` | owner | Ban (deny access). |
| `POST /api/admin/users/:id/delete` | owner | Delete the account. |
| `GET /admin.html` | browser | Optional web owner console (same thing as the in-extension Owner tab). |

Passwords are hashed with bcrypt. Sessions are stateless JWTs. A ban/block takes
effect immediately because every request reloads the live account row.

---

## Setup

```bash
cd backend
npm install
cp .env.example .env
# edit .env — set OWNER_EMAIL, OWNER_PASSWORD, and a long random JWT_SECRET:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # -> paste into JWT_SECRET
npm start
```

The owner account is created/updated from `OWNER_EMAIL` + `OWNER_PASSWORD`
**every time the server boots**, so you change the owner password by editing
`.env` and restarting.

Check it's up:

```bash
curl http://localhost:8080/api/health
```

Then open `http://localhost:8080/admin.html` and log in with your owner email +
password to manage users from the browser (or use the Owner tab inside the
extension — same API).

---

## Deploying so the extension can reach it

The extension talks to this server over **HTTPS**, so put it behind a domain
with TLS. Two common ways:

**A. Your own VPS (recommended — persistent, cheap):**
1. Install Node 18+.
2. Copy this `backend/` folder up, run `npm install --omit=dev`.
3. Keep it running with `pm2 start server.js --name xenoking` (or a systemd unit).
4. Put nginx/Caddy in front for HTTPS on e.g. `https://api.yourdomain.com`.
5. Make sure `DATA_DIR` points somewhere permanent (default `./data`).

**B. Free/managed host (Render, Railway, Fly.io):**
- Set the same env vars in the host's dashboard.
- **Attach a persistent disk** and set `DATA_DIR` to it — otherwise the SQLite
  file (and your whole user list) is wiped on every redeploy.

Whatever URL you land on (e.g. `https://api.yourdomain.com`) is the
**`BACKEND_URL`** you paste into the extension's `config.js` (see the
extension's README).

---

## Notes
- `data/` (the SQLite database) and `.env` are git-ignored — never commit them.
- To restrict which origins may call the API, set `ALLOWED_ORIGINS` in `.env`.
- Rate limiting protects `/signup` and `/login` (40 requests / 15 min / IP).
