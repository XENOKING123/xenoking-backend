'use strict';

// ===========================================================================
//  XENOKING backend — SINGLE FILE build (do not edit by hand; run
//  build-single.js). Assembled from db.js + inventory.js + ai.js + server.js.
// ===========================================================================

const store = (function () {
  const module = { exports: {} };
  let exports = module.exports;
// Storage layer. Uses libSQL, which speaks two dialects of the same SQLite:
//  - DATABASE_URL unset      -> a local file (./data/xenoking.db). Good for dev
//                               and for servers with a persistent disk.
//  - DATABASE_URL=libsql://… -> Turso (free cloud SQLite). Use this on hosts
//                               with an ephemeral filesystem (e.g. Render free)
//                               so the user list survives restarts/redeploys.
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
let url = DATABASE_URL;
if (!url) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  url = 'file:' + path.join(dataDir, 'xenoking.db');
}

const db = createClient({
  url,
  authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
});

async function init() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      email        TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password     TEXT NOT NULL,
      name         TEXT DEFAULT '',
      role         TEXT NOT NULL DEFAULT 'user',   -- 'owner' | 'user'
      status       TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'banned' | 'blocked'
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_login   TEXT,
      expires_at   TEXT             -- NULL = unlimited access
    )`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )`);
  // Migrate older databases that predate the expires_at column.
  try { await db.execute('ALTER TABLE users ADD COLUMN expires_at TEXT'); }
  catch (e) { /* column already exists */ }
}

const one = (rs) => (rs.rows.length ? rs.rows[0] : undefined);
const USER_COLS = 'id, email, name, role, status, created_at, updated_at, last_login, expires_at';

module.exports = {
  db,
  init,
  storageLabel: DATABASE_URL ? 'cloud (libsql)' : url,
  getUserByEmail: async (email) =>
    one(await db.execute({ sql: 'SELECT * FROM users WHERE email = ? COLLATE NOCASE', args: [email] })),
  getUserById: async (id) =>
    one(await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] })),
  createUser: async ({ email, password, name, role, status }) =>
    db.execute({
      sql: 'INSERT INTO users (email, password, name, role, status) VALUES (?, ?, ?, ?, ?)',
      args: [email, password, name, role, status],
    }),
  listUsers: async () =>
    (await db.execute(`SELECT ${USER_COLS} FROM users ORDER BY created_at DESC`)).rows,
  // Set status; optionally set expiry too. Pass expiresAt === undefined to
  // leave the expiry column untouched, or null to clear it (unlimited).
  setUserStatus: async (id, status, expiresAt) => {
    if (expiresAt === undefined) {
      return db.execute({ sql: "UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?", args: [status, id] });
    }
    return db.execute({
      sql: "UPDATE users SET status = ?, expires_at = ?, updated_at = datetime('now') WHERE id = ?",
      args: [status, expiresAt, id],
    });
  },
  setExpiry: async (id, expiresAt) =>
    db.execute({ sql: "UPDATE users SET expires_at = ?, updated_at = datetime('now') WHERE id = ?", args: [expiresAt, id] }),
  markLogin: async (id) =>
    db.execute({ sql: "UPDATE users SET last_login = datetime('now'), updated_at = datetime('now') WHERE id = ?", args: [id] }),
  deleteUser: async (id) =>
    db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [id] }),
  getSetting: async (key) => {
    const row = one(await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] }));
    return row ? row.value : null;
  },
  setSetting: async (key, value) =>
    db.execute({
      sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      args: [key, value == null ? '' : String(value)],
    }),
  upsertOwner: async function ({ email, passwordHash, name }) {
    const existing = await this.getUserByEmail(email);
    if (existing) {
      await db.execute({
        sql: "UPDATE users SET password = ?, role = 'owner', status = 'approved', updated_at = datetime('now') WHERE id = ?",
        args: [passwordHash, existing.id],
      });
      return this.getUserById(existing.id);
    }
    const info = await db.execute({
      sql: "INSERT INTO users (email, password, name, role, status) VALUES (?, ?, ?, 'owner', 'approved')",
      args: [email, passwordHash, name || 'Owner'],
    });
    return this.getUserById(Number(info.lastInsertRowid));
  },
};

  return module.exports;
})();

const inventory = (function () {
  const module = { exports: {} };
  let exports = module.exports;
// Server-side inventory loader for Dealer.com "ws-inv-data" widget APIs.
// Fetches inventory (with the Origin/Referer the API requires), auto-detects how
// the API paginates, and maps each vehicle into the Facebook-catalog row shape
// the extension's sanitizeVehiclesData expects.

// ---- Dealership registry ---------------------------------------------------
const DEALERS = {
  'corwin-dodge': {
    label: 'Corwin Chrysler Dodge',
    base: 'https://www.corwinchryslerdodge.com',
    siteId: 'corwinchryslerdodgecllc',
    pageId: 'corwinchryslerdodgecllc_SITEBUILDER_INVENTORY_SEARCH_RESULTS_AUTO_ALL_V1_1',
    pageAlias: 'INVENTORY_LISTING_DEFAULT_AUTO_ALL',
    listingConfig: 'auto-new,auto-used',
  },
  'corwin-honda': { label: 'Corwin Honda', base: '', siteId: '', pageId: '', pageAlias: 'INVENTORY_LISTING_DEFAULT_AUTO_ALL', listingConfig: 'auto-new,auto-used' },
  'corwin-subaru': { label: 'Corwin Subaru', base: '', siteId: '', pageId: '', pageAlias: 'INVENTORY_LISTING_DEFAULT_AUTO_ALL', listingConfig: 'auto-new,auto-used' },
  'corwin-toyota': { label: 'Corwin Toyota', base: '', siteId: '', pageId: '', pageAlias: 'INVENTORY_LISTING_DEFAULT_AUTO_ALL', listingConfig: 'auto-new,auto-used' },
  'corwin-cpw': { label: 'Corwin CPW', base: '', siteId: '', pageId: '', pageAlias: 'INVENTORY_LISTING_DEFAULT_AUTO_ALL', listingConfig: 'auto-new,auto-used' },
};
const DEFAULT_DEALER = 'corwin-dodge';
const PAGE_SIZE = 100;
const MAX_PAGES = 40;
// One big request usually returns the whole lot: the Dealer.com widget honors
// pageSize as a hard cap, so asking for a huge page pulls everything at once.
const BIG_PAGE = 5000;
// Pagination methods to probe if the site DOES cap the page (fallback only).
const STRATEGIES = ['page', 'pageNum', 'pageNumber', 'pageNo', 'currentPage', 'pageIndex', 'start', 'offset', 'from', 'topStart', 'topPage'];

function dealerList() {
  return Object.entries(DEALERS).map(([key, d]) => ({ key, label: d.label, configured: !!(d.base && d.siteId) }));
}

function resolveDealer(dealerKey, get) {
  const key = DEALERS[dealerKey] ? dealerKey : DEFAULT_DEALER;
  const base = DEALERS[key];
  const ov = (k, d) => { const v = get && get(k); return v === null || v === undefined || v === '' ? d : v; };
  return {
    key,
    base: String(ov(`dealer.${key}.base`, base.base)).replace(/\/+$/, ''),
    siteId: ov(`dealer.${key}.siteId`, base.siteId),
    pageId: ov(`dealer.${key}.pageId`, base.pageId),
    pageAlias: ov(`dealer.${key}.pageAlias`, base.pageAlias),
    listingConfig: ov(`dealer.${key}.listingConfig`, base.listingConfig),
  };
}

function applyCondition(cfg, condition) {
  const c = String(condition || '').toLowerCase();
  if (c === 'new') return { ...cfg, listingConfig: 'auto-new' };
  if (c === 'used' || c === 'preowned' || c === 'pre-owned') return { ...cfg, listingConfig: 'auto-used' };
  // Certified are a subset of pre-owned — pull used, then keep only certified.
  if (c === 'certified' || c === 'cpo') return { ...cfg, listingConfig: 'auto-used', certifiedOnly: true };
  return cfg;
}

function bodyFor(cfg, opts) {
  opts = opts || {};
  const page = opts.page || 1;
  const pageSize = opts.pageSize || PAGE_SIZE;
  const strategy = opts.strategy || 'page';
  const offset = (page - 1) * pageSize;
  const prefs = { pageSize, 'listing.config.id': cfg.listingConfig };
  const body = {
    siteId: cfg.siteId, device: 'DESKTOP', locale: 'en_US',
    includePricing: true, includeMedia: true,
    pageAlias: cfg.pageAlias, pageId: cfg.pageId,
    preferences: prefs, widgetName: 'ws-inv-data', windowId: 'inventory-data-bus2',
  };
  switch (strategy) {
    case 'page':        prefs.page = page; break;
    case 'pageNum':     prefs.pageNum = page; break;
    case 'pageNumber':  prefs.pageNumber = page; break;
    case 'pageNo':      prefs.pageNo = page; break;
    case 'currentPage': prefs.currentPage = page; break;
    case 'pageIndex':   prefs.pageIndex = page - 1; break;       // 0-based
    case 'start':       prefs.start = offset; break;
    case 'offset':      prefs.offset = offset; break;
    case 'from':        prefs.from = offset; break;
    case 'topStart':    body.start = offset; body.rows = pageSize; break;
    case 'topPage':     body.page = page; break;
    default:            prefs.page = page;
  }
  return body;
}

async function fetchPage(cfg, opts) {
  const res = await fetch(`${cfg.base}/api/widget/ws-inv-data/getInventory`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Origin: cfg.base,
      Referer: cfg.base + '/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
    body: JSON.stringify(bodyFor(cfg, opts)),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`dealer API -> HTTP ${res.status}`);
  return res.json();
}

// ---- extraction helpers ----------------------------------------------------
const first = (obj, keys) => {
  if (!obj) return undefined;
  for (const k of keys) if (obj[k] != null && obj[k] !== '') return obj[k];
  return undefined;
};
const cap = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());
const digits = (s) => String(s == null ? '' : s).replace(/[^\d]/g, '');
const cleanVin = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase();

function findVehicles(resp) {
  const seen = new Set();
  const looks = (o) => o && typeof o === 'object' && (o.vin || o.VIN || o.vinNumber);
  let best = [];
  const walk = (node, depth) => {
    if (!node || depth > 7 || seen.has(node)) return;
    if (typeof node === 'object') seen.add(node);
    if (Array.isArray(node)) {
      if (node.length && node.some(looks) && node.length > best.length) best = node;
      node.forEach((n) => walk(n, depth + 1));
    } else if (typeof node === 'object') {
      for (const k of Object.keys(node)) walk(node[k], depth + 1);
    }
  };
  const direct = resp && (resp.inventory || (resp.pageInfo && resp.pageInfo.inventory) || (resp.data && resp.data.inventory) || resp.vehicles);
  if (Array.isArray(direct) && direct.some(looks)) return direct;
  walk(resp, 0);
  return best;
}

function findTotal(resp) {
  const paths = [
    resp && resp.pageInfo && resp.pageInfo.totalCount,
    resp && resp.pageInfo && resp.pageInfo.total,
    resp && resp.totalCount, resp && resp.total, resp && resp.hitCount,
  ];
  for (const p of paths) { const n = parseInt(p, 10); if (Number.isFinite(n) && n > 0) return n; }
  return 0;
}

// Build a name->value map from the vehicle's attribute arrays (this is where
// mileage, colors, drivetrain, transmission, engine actually live).
function attrMap(v) {
  const m = {};
  const add = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const a of arr) {
      if (a && a.name && (m[a.name] == null || m[a.name] === '')) {
        const val = a.value;
        if (val != null && String(val).trim() !== '') m[a.name] = val;
      }
    }
  };
  add(v.attributes);           // richest values (e.g. engine "5.3L V-8 cyl")
  add(v.highlightedAttributes);
  add(v.trackingAttributes);   // clean numeric odometer
  return m;
}

function pickPrice(v) {
  const pricing = v.pricing || v.price || {};
  const arr = pricing.dPrice || pricing.dprice || pricing.prices || (Array.isArray(pricing) ? pricing : []);
  const num = (x) => { const n = parseInt(String(x).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) && n > 0 ? n : 0; };
  if (Array.isArray(arr) && arr.length) {
    const label = (e) => String(e.typeClass || e.type || e.priceType || e.label || '').toLowerCase();
    const wanted = arr.find((e) => /internet|sale|selling|final|special|now|asking/.test(label(e)) && num(e.value ?? e.price));
    if (wanted) { const n = num(wanted.value ?? wanted.price); if (n) return n; }
    const nums = arr.map((e) => num(e.value ?? e.price)).filter(Boolean);
    if (nums.length) return Math.min(...nums);
  }
  const tp = v.trackingPricing || {};
  return num(first(tp, ['internetPrice', 'salePrice', 'askingPrice']))
    || num(first(v, ['salePrice', 'internetPrice', 'sellingPrice', 'price', 'askingPrice', 'msrp']));
}

function pickImages(v) {
  let imgs = v.images || v.media || v.photos || v.imageList || [];
  if (imgs && !Array.isArray(imgs) && Array.isArray(imgs.images)) imgs = imgs.images;
  if (!Array.isArray(imgs)) imgs = [];
  const uri = (im) => (typeof im === 'string' ? im : first(im, ['uri', 'url', 'src', 'href', 'imageUrl', 'largeUrl']));
  const norm = (u) => (u && u.startsWith('//') ? 'https:' + u : u);
  const all = imgs.map(uri).filter(Boolean).map(norm);
  const actual = imgs.filter((im) => im && /ACTUAL/i.test(String(im.provider || im.type || ''))).map(uri).filter(Boolean).map(norm);
  return [...new Set([...actual, ...all])];
}

function mapVehicle(v, cfg) {
  const A = attrMap(v);
  const year = cap(first(v, ['year', 'modelYear']));
  const make = cap(first(v, ['make', 'makeName']));
  const model = cap(first(v, ['model', 'modelName']));
  const trim = cap(first(v, ['trim', 'trimName']));
  const vin = cleanVin(first(v, ['vin', 'VIN', 'vinNumber']) || A.vin);
  const images = pickImages(v);
  const priceNum = pickPrice(v);
  const mileage = digits(A.odometer || A.mileage || A.miles || first(v, ['odometer', 'mileage']));
  const cond = String(first(v, ['condition', 'type', 'inventoryType']) || (v.certified ? 'certified' : '')).toLowerCase();
  const state = /new/.test(cond) && !/used/.test(cond) ? 'NEW' : 'USED';
  const link = cap(first(v, ['link', 'url', 'vdpUrl', 'detailUrl']));
  const body = cap(first(v, ['bodyStyle', 'body', 'bodyType']));
  const titleFromParts = [year, make, model, trim].filter(Boolean).join(' ');

  return {
    Title: titleFromParts || (Array.isArray(v.title) ? v.title.join(' ') : cap(v.title)),
    Year: year, Make: make, Model: model, Trim: trim, VIN: vin,
    Price: priceNum ? `${priceNum} USD` : '',
    'Mileage Value': mileage,
    'Mileage Unit': 'MI',
    'Image Urls': images.join(';'),
    'Exterior Color': cap(A.exteriorColor || first(v, ['exteriorColor', 'extColor'])),
    'Interior Color': cap(A.interiorColor || first(v, ['interiorColor', 'intColor'])),
    'Body Style': body,
    Drivetrain: cap(A.driveLine || A.drivetrain || first(v, ['driveLine', 'drivetrain'])),
    Transmission: cap(A.transmission || first(v, ['transmission'])),
    engine: cap(A.engine || first(v, ['engine'])),
    fuel_type: cap(first(v, ['fuelType', 'fuel']) || A.normalFuelType || A.fuelType),
    stock_number: cap(first(v, ['stockNumber', 'stock']) || A.stockNumber),
    'State of Vehicle': state,
    certified: !!v.certified || /certified|cpo/.test(cond),
    'Vehicle Id': cap(first(v, ['uuid', 'id', 'vehicleId']) || vin),
    vehicle_type: body,
    'Final Url': link && link.startsWith('http') ? link : (link ? cfg.base + link : ''),
    Button: 'Post',
    firstImage: images[0] || '',
  };
}

const vinOf = (v) => cleanVin(v && (v.vin || v.VIN || v.vinNumber));

// Detect which pagination method the API honors by requesting "page 2" each way
// (at the given page size) and seeing which returns DIFFERENT vehicles than
// page 1. Returns the first method whose first VIN differs from page 1's.
async function detectStrategy(cfg, firstVin, pageSize) {
  const tests = await Promise.all(STRATEGIES.map((s) =>
    fetchPage(cfg, { page: 2, pageSize, strategy: s }).then((r) => ({ s, r })).catch(() => ({ s, r: null }))));
  for (const { s, r } of tests) {
    const vs = r ? findVehicles(r) : [];
    if (vs.length && vinOf(vs[0]) && vinOf(vs[0]) !== firstVin) return { strategy: s, page2: r };
  }
  return { strategy: null, page2: null };
}

async function loadInventory(dealerKey, get, condition) {
  const cfg = applyCondition(resolveDealer(dealerKey, get), condition);
  if (!cfg.base || !cfg.siteId) throw new Error(`Dealer "${cfg.key}" isn't set up yet.`);

  const rows = [];
  const seen = new Set();
  const absorb = (resp) => {
    if (!resp) return 0;
    let n = 0;
    for (const v of findVehicles(resp)) {
      const row = mapVehicle(v, cfg);
      if (!row.VIN || seen.has(row.VIN)) continue;
      seen.add(row.VIN); rows.push(row); n++;
    }
    return n;
  };

  // --- Primary path: one big page. The widget caps results at pageSize, so a
  //     huge pageSize returns the entire lot in a single request.
  const p1 = await fetchPage(cfg, { page: 1, pageSize: BIG_PAGE });
  const total = findTotal(p1);
  const p1v = findVehicles(p1);
  absorb(p1);

  // Single exit point: apply the certified sub-filter and shape the result.
  const finish = (strategy) => {
    const out = cfg.certifiedOnly ? rows.filter((r) => r.certified) : rows;
    return { count: out.length, total: total || out.length, dealer: cfg.key, strategy, vehicles: out };
  };

  if (total && rows.length >= total) return finish('big-page');

  // --- Fallback: the site capped the page. Whatever came back IS the cap; page
  //     through using the pagination method the API actually honors.
  const cap = p1v.length || PAGE_SIZE;
  if (total > rows.length && cap > 0) {
    const { strategy, page2 } = await detectStrategy(cfg, vinOf(p1v[0]), cap);
    if (strategy) {
      absorb(page2);
      const pages = total ? Math.ceil(total / cap) : MAX_PAGES;
      const rest = [];
      for (let p = 3; p <= Math.min(pages, MAX_PAGES); p++) {
        rest.push(fetchPage(cfg, { page: p, pageSize: cap, strategy }).catch(() => null));
      }
      for (const r of await Promise.all(rest)) absorb(r);
      return finish(strategy);
    }
  }

  return finish('single-page');
}

// Public diagnostic: probe the real API and report exactly how it behaves, so a
// single hit on /api/debug/inventory-sample tells us what works.
async function rawSample(dealerKey, get) {
  const cfg = resolveDealer(dealerKey, get);
  if (!cfg.base || !cfg.siteId) throw new Error(`Dealer "${cfg.key}" isn't set up yet.`);

  const small = await fetchPage(cfg, { page: 1, pageSize: PAGE_SIZE });
  const total = findTotal(small);
  const v1 = findVehicles(small);

  // Does one big request return everything?
  const big = await fetchPage(cfg, { page: 1, pageSize: BIG_PAGE }).catch(() => null);
  const bigCount = big ? findVehicles(big).length : 0;
  const bigPageWorks = !!(total && bigCount >= total);

  // If not, which pagination method actually changes the results?
  let workingPagination = 'big-page';
  if (!bigPageWorks) {
    const { strategy } = await detectStrategy(cfg, vinOf(v1[0]), v1.length || PAGE_SIZE);
    workingPagination = strategy || 'NONE (need to inspect)';
  }

  return {
    dealer: cfg.key,
    totalCount: total,
    page1Count: v1.length,
    bigPageCount: bigCount,
    bigPageWorks,
    workingPagination,
    firstVehicleMapped: v1[0] ? mapVehicle(v1[0], cfg) : null,
  };
}

module.exports = { loadInventory, rawSample, dealerList, mapVehicle, DEALERS };

  return module.exports;
})();

const ai = (function () {
  const module = { exports: {} };
  let exports = module.exports;
// AI description generator. Uses OpenAI or Google Gemini, whichever key the
// owner set (OPENAI_API_KEY or GEMINI_API_KEY). If neither is set, callers get
// a 501 and the extension falls back to its built-in clean template.

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

const enabled = () => !!(OPENAI_KEY || GEMINI_KEY);

function buildPrompt(vehicle, instructions) {
  const v = vehicle || {};
  const facts = [
    ['Year', v.Year], ['Make', v.Make], ['Model', v.Model], ['Trim', v.Trim],
    ['Price', v.Price], ['Mileage', v['Mileage Value'] || v.MileageValue],
    ['Exterior', v['Exterior Color'] || v.ExteriorColor], ['Interior', v['Interior Color'] || v.InteriorColor],
    ['Drivetrain', v.Drivetrain], ['Transmission', v.Transmission], ['Engine', v.engine],
    ['Fuel', v.fuel_type], ['VIN', v.VIN], ['Stock #', v.stock_number],
  ].filter(([, val]) => val != null && String(val).trim() !== '')
    .map(([k, val]) => `${k}: ${val}`).join('\n');

  const style = (instructions && instructions.trim())
    ? `The seller's style instructions (follow these closely):\n"${instructions.trim()}"`
    : 'Keep it clean, friendly, and easy to read.';

  return `You write short Facebook Marketplace car listings that sound human, not robotic.

${style}

Rules:
- Sound natural and inviting, never corporate or spammy.
- Use a few tasteful emojis (not every line).
- ALWAYS include the price, mileage, and drivetrain if provided.
- Mention 2-3 appealing things about the car in plain language.
- Keep it to about 4-6 short lines. End with a simple call to action.
- Do not invent facts that aren't in the data. No markdown headings.

VEHICLE DATA:
${facts}

Write the listing description now.`;
}

async function viaOpenAI(prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: 320,
    }),
    signal: AbortSignal.timeout(25000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error && data.error.message || 'OpenAI error');
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
}

async function viaGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.8, maxOutputTokens: 320 } }),
    signal: AbortSignal.timeout(25000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error && data.error.message || 'Gemini error');
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  return (parts && parts.map((p) => p.text).join('') || '').trim();
}

async function describe(vehicle, instructions) {
  if (!enabled()) { const e = new Error('AI not configured'); e.code = 'ai_disabled'; throw e; }
  const prompt = buildPrompt(vehicle, instructions);
  const text = OPENAI_KEY ? await viaOpenAI(prompt) : await viaGemini(prompt);
  if (!text) throw new Error('empty AI response');
  return text;
}

module.exports = { describe, enabled };

  return module.exports;
})();

// ---------------------------------------------------------------------------
//  server
// ---------------------------------------------------------------------------
try { require('dotenv').config(); } catch (e) { /* no .env in prod */ }
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

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

app.post('/api/admin/settings', auth, ownerOnly, ah(async (req, res) => {
  if (typeof req.body.dataApiKey === 'string') await store.setSetting('dataApiKey', req.body.dataApiKey.trim());
  if (typeof req.body.dataApiBase === 'string') await store.setSetting('dataApiBase', req.body.dataApiBase.trim());
  // Per-dealer overrides: keys like "dealer.corwin-honda.siteId".
  for (const k of Object.keys(req.body || {})) {
    if (/^dealer\.[a-z0-9-]+\.[a-zA-Z]+$/.test(k) && typeof req.body[k] === 'string') {
      await store.setSetting(k, String(req.body[k]).trim());
    }
  }
  res.json({ ok: true, settings: await readConfig() });
}));

// Load the override settings for one dealer as a sync getter.
async function dealerGetter(dealerKey) {
  const fields = ['base', 'siteId', 'pageId', 'pageAlias', 'listingConfig'];
  const map = {};
  await Promise.all(fields.map(async (f) => {
    const k = `dealer.${dealerKey}.${f}`;
    map[k] = await store.getSetting(k);
  }));
  return (k) => (k in map ? map[k] : null);
}

// The dropdown of dealerships the extension shows.
app.get('/api/dealers', auth, requireApproved, (_req, res) => {
  res.json({ ok: true, dealers: inventory.dealerList() });
});

// Approved users pull a dealer's whole inventory (server fetches it so the
// Origin/Referer the dealer API requires are set correctly).
app.get('/api/inventory', auth, requireApproved, ah(async (req, res) => {
  const dealerKey = String(req.query.dealer || 'corwin-dodge');
  const condition = String(req.query.condition || 'all');
  try {
    const data = await inventory.loadInventory(dealerKey, await dealerGetter(dealerKey), condition);
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(502).json({ error: 'inventory_failed', message: e.message });
  }
}));

// Public debug: raw first vehicle so the exact dealer field names can be mapped.
// (Dealer inventory is public data; safe to expose. Remove later if you like.)
app.get('/api/debug/inventory-sample', ah(async (req, res) => {
  const dealerKey = String(req.query.dealer || 'corwin-dodge');
  try {
    res.json({ ok: true, ...(await inventory.rawSample(dealerKey, await dealerGetter(dealerKey))) });
  } catch (e) {
    res.status(502).json({ error: 'inventory_failed', message: e.message });
  }
}));

// AI listing description (uses OWNER's OpenAI/Gemini key; falls back to template).
app.post('/api/ai/describe', auth, requireApproved, ah(async (req, res) => {
  try {
    const text = await ai.describe(req.body && req.body.vehicle, req.body && req.body.instructions);
    res.json({ ok: true, text });
  } catch (e) {
    const code = e.code === 'ai_disabled' ? 501 : 502;
    res.status(code).json({ error: e.code || 'ai_failed', message: e.message });
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
