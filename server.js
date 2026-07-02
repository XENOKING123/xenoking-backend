'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const store = require('./db');
const inventory = require('./inventory');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || '';
const JWT_TTL = process.env.JWT_TTL || '7d';
const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';
const OWNER_NAME = process.env.OWNER_NAME || 'Owner';

if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('FATAL: set JWT_SECRET (>=16 chars) in the environment. See .env.example');
  process.exit(1);
}
if (!OWNER_EMAIL || !OWNER_PASSWORD) {
  console.error('FATAL: set OWNER_EMAIL and OWNER_PASSWORD in the environment. See .env.example');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

// The extension calls this API from a chrome-extension:// origin (which changes
// per install). Auth is via a bearer token in the body/header, not cookies, so
// a permissive CORS policy is safe here. Restrict with ALLOWED_ORIGINS if set.
const allowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowed.length ? allowed : true,
  credentials: false,
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false });

// Precomputed hash used only to equalize login timing for unknown emails.
const DUMMY_HASH = bcrypt.hashSync('xenoking-timing-equalizer', 10);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 86400000;

// Parse a SQLite "YYYY-MM-DD HH:MM:SS" UTC timestamp to epoch ms.
function parseUTC(ts) { return Date.parse(String(ts).replace(' ', 'T') + 'Z'); }
// Format epoch ms back into the same SQLite string.
function fmtUTC(ms) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19); }

function expiryInfo(u) {
  if (!u.expires_at) return { expires_at: null, days_left: null, expired: false };
  const ms = parseUTC(u.expires_at) - Date.now();
  return { expires_at: u.expires_at, days_left: Math.ceil(ms / DAY_MS), expired: ms <= 0 };
}
// Active = owner, or an approved user whose access hasn't expired.
function isActive(u) {
  return u.role === 'owner' || (u.status === 'approved' && !expiryInfo(u).expired);
}

const publicUser = (u) => {
  const e = expiryInfo(u);
  return {
    id: u.id, email: u.email, name: u.name || '', role: u.role,
    status: u.status, created_at: u.created_at, last_login: u.last_login || null,
    expires_at: e.expires_at, days_left: e.days_left, expired: e.expired,
  };
};

function sign(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_TTL });
}

// Express 4 doesn't route async rejections to the error handler — wrap them.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Auth middleware — resolves the caller from a Bearer token and reloads the
// live user row so a mid-session ban/block takes effect immediately.
const auth = ah(async (req, res, next) => {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
  const user = await store.getUserById(payload.sub);
  if (!user) return res.status(401).json({ error: 'unknown_user' });
  req.user = user;
  next();
});

function ownerOnly(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'owner_only' });
  next();
}

// Centralized access gate: the owner is always allowed; everyone else must be
// approved. Apply to any route that hands out capability so a future route
// can't accidentally be reachable by a pending/banned/blocked account.
function requireApproved(req, res, next) {
  if (!isActive(req.user)) {
    const expired = req.user.status === 'approved' && expiryInfo(req.user).expired;
    return res.status(403).json({ error: expired ? 'expired' : req.user.status, message: 'Access is not active.' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'xenoking', time: new Date().toISOString() }));

// Sign up -> creates a PENDING account the owner must approve.
app.post('/api/signup', authLimiter, ah(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });
  if (password.length < 8) return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 8 characters.' });
  if (await store.getUserByEmail(email)) return res.status(409).json({ error: 'email_taken', message: 'That email is already registered.' });
  await store.createUser({ email, password: bcrypt.hashSync(password, 10), name, role: 'user', status: 'pending' });
  res.status(201).json({ ok: true, status: 'pending', message: 'Account created. Waiting for the owner to approve you.' });
}));

// Log in -> returns a token only for approved users (or the owner).
app.post('/api/login', authLimiter, ah(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = await store.getUserByEmail(email);
  // Always run a bcrypt compare (dummy hash when the email is unknown) so
  // response time doesn't reveal whether an email is registered.
  const ok = bcrypt.compareSync(password, user ? user.password : DUMMY_HASH);
  if (!user || !ok) {
    return res.status(401).json({ error: 'bad_credentials', message: 'Wrong email or password.' });
  }
  if (user.role !== 'owner') {
    if (user.status === 'pending') return res.status(403).json({ error: 'pending', message: 'Your account is waiting for owner approval.' });
    if (user.status === 'banned') return res.status(403).json({ error: 'banned', message: 'Your account has been banned.' });
    if (user.status === 'blocked') return res.status(403).json({ error: 'blocked', message: 'Your account has been blocked.' });
    if (user.status !== 'approved') return res.status(403).json({ error: 'not_approved', message: 'Your account is not approved.' });
    if (expiryInfo(user).expired) return res.status(403).json({ error: 'expired', message: 'Your access has expired. Ask the owner to renew it.' });
  }
  await store.markLogin(user.id);
  res.json({ ok: true, token: sign(user), user: publicUser(user) });
}));

// Who am I / re-validate session (the gate calls this on every open).
app.get('/api/me', auth, requireApproved, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user) });
});

// ---- Shared tool config (data key handed to approved users) ----
// The owner sets the inventory/AI data key ONCE here, and every approved user's
// extension pulls it automatically — so end users never type an "API key".
const DEFAULT_DATA_BASE = process.env.DEFAULT_DATA_BASE || 'https://sag.gemquery.com';
const readConfig = async () => ({
  dataApiKey: (await store.getSetting('dataApiKey')) || '',
  dataApiBase: (await store.getSetting('dataApiBase')) || DEFAULT_DATA_BASE,
});

app.get('/api/config', auth, requireApproved, ah(async (_req, res) => {
  res.json({ ok: true, config: await readConfig() });
}));

app.get('/api/admin/settings', auth, ownerOnly, ah(async (_req, res) => {
  res.json({ ok: true, settings: await readConfig() });
}));

const DEALER_KEYS = ['dealerBase', 'dealerSiteId', 'dealerPageId', 'dealerPageAlias', 'dealerListingConfig', 'dealerPageSize', 'dealerPages'];

app.post('/api/admin/settings', auth, ownerOnly, ah(async (req, res) => {
  if (typeof req.body.dataApiKey === 'string') await store.setSetting('dataApiKey', req.body.dataApiKey.trim());
  if (typeof req.body.dataApiBase === 'string') await store.setSetting('dataApiBase', req.body.dataApiBase.trim());
  for (const k of DEALER_KEYS) {
    if (typeof req.body[k] === 'string') await store.setSetting(k, String(req.body[k]).trim());
  }
  res.json({ ok: true, settings: await readConfig() });
}));

// Load a sync snapshot of the dealer settings for the inventory module.
async function dealerGetter() {
  const map = {};
  await Promise.all(DEALER_KEYS.map(async (k) => { map[k] = await store.getSetting(k); }));
  return (k) => (k in map ? map[k] : null);
}

// Approved users pull the dealer's whole inventory (server fetches it so the
// Origin/Referer the dealer API requires are set correctly).
app.get('/api/inventory', auth, requireApproved, ah(async (_req, res) => {
  try {
    const data = await inventory.loadInventory(await dealerGetter());
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(502).json({ error: 'inventory_failed', message: e.message });
  }
}));

// Owner debug: see the raw first vehicle so field mapping can be verified.
app.get('/api/admin/inventory/raw', auth, ownerOnly, ah(async (_req, res) => {
  try {
    res.json({ ok: true, ...(await inventory.rawSample(await dealerGetter())) });
  } catch (e) {
    res.status(502).json({ error: 'inventory_failed', message: e.message });
  }
}));

// ---- Owner-only admin API ----
app.get('/api/admin/users', auth, ownerOnly, ah(async (_req, res) => {
  res.json({ ok: true, users: (await store.listUsers()).map(publicUser) });
}));

const ACTIONS = {
  approve: 'approved',
  ban: 'banned',
  block: 'blocked',
  unblock: 'approved',
  pending: 'pending',
};

app.post('/api/admin/users/:id/:action', auth, ownerOnly, ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad_id' });
  const action = req.params.action;
  const target = await store.getUserById(id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (target.role === 'owner') return res.status(400).json({ error: 'cannot_modify_owner' });

  if (action === 'delete') {
    await store.deleteUser(id);
    return res.json({ ok: true, deleted: id });
  }

  // "days" (from the owner's duration picker): a positive number sets an expiry
  // that many days out; 0 / empty means unlimited access.
  const days = Number(req.body && req.body.days);
  const hasDays = Number.isFinite(days) && days > 0;
  const expiresAt = hasDays ? fmtUTC(Date.now() + days * DAY_MS) : null;

  // "extend" renews access from now without changing status (for someone who
  // ran out or whose window you want to move) — approves them if needed.
  if (action === 'extend') {
    await store.setUserStatus(id, 'approved', expiresAt);
    return res.json({ ok: true, user: publicUser(await store.getUserById(id)) });
  }

  // hasOwnProperty guard so inherited keys (toString, __proto__, …) can't slip
  // past the unknown_action check.
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
    return res.status(400).json({ error: 'unknown_action' });
  }
  // Approving carries the chosen duration; other actions clear any expiry.
  await store.setUserStatus(id, ACTIONS[action], action === 'approve' ? expiresAt : null);
  res.json({ ok: true, user: publicUser(await store.getUserById(id)) });
}));

// Standalone web owner dashboard (optional convenience — same API as the
// in-extension Owner tab).
app.use('/', express.static(path.join(__dirname, 'public')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

// ---------------------------------------------------------------------------
// Boot: create tables, seed/refresh the owner account from env, then listen.
// ---------------------------------------------------------------------------
(async () => {
  try {
    await store.init();
    const ownerHash = bcrypt.hashSync(OWNER_PASSWORD, 10);
    const owner = await store.upsertOwner({ email: OWNER_EMAIL, passwordHash: ownerHash, name: OWNER_NAME });
    console.log(`[xenoking] storage: ${store.storageLabel}`);
    console.log(`[xenoking] owner account ready: ${owner.email} (id ${owner.id})`);
    if (process.argv.includes('--seed-only')) {
      console.log('[xenoking] seed complete, exiting.');
      process.exit(0);
    }
    app.listen(PORT, () => console.log(`[xenoking] backend listening on :${PORT}`));
  } catch (e) {
    console.error('FATAL: could not start —', e.message || e);
    process.exit(1);
  }
})();
