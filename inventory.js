'use strict';

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
const MAX_PAGES = 20;
// Pagination methods to probe (the widget API varies by site).
const STRATEGIES = ['page', 'pageNum', 'pageNumber', 'start', 'offset', 'topStart'];

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
  if (strategy === 'page') prefs.page = page;
  else if (strategy === 'pageNum') prefs.pageNum = page;
  else if (strategy === 'pageNumber') prefs.pageNumber = page;
  else if (strategy === 'start') prefs.start = offset;
  else if (strategy === 'offset') prefs.offset = offset;
  else if (strategy === 'topStart') { body.start = offset; body.rows = pageSize; }
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
    'Vehicle Id': cap(first(v, ['uuid', 'id', 'vehicleId']) || vin),
    vehicle_type: body,
    'Final Url': link && link.startsWith('http') ? link : (link ? cfg.base + link : ''),
    Button: 'Post',
    firstImage: images[0] || '',
  };
}

const vinOf = (v) => cleanVin(v && (v.vin || v.VIN || v.vinNumber));

// Detect which pagination method the API honors by requesting "page 2" each way
// and seeing which returns DIFFERENT vehicles than page 1.
async function detectStrategy(cfg, firstVin) {
  const tests = await Promise.all(STRATEGIES.map((s) =>
    fetchPage(cfg, { page: 2, strategy: s }).then((r) => ({ s, r })).catch(() => ({ s, r: null }))));
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

  const p1 = await fetchPage(cfg, { page: 1 });
  const total = findTotal(p1);
  const p1v = findVehicles(p1);
  absorb(p1);
  let usedStrategy = 'single-page';

  if (p1v.length >= PAGE_SIZE && (total === 0 || total > PAGE_SIZE)) {
    const { strategy, page2 } = await detectStrategy(cfg, vinOf(p1v[0]));
    if (strategy) {
      usedStrategy = strategy;
      absorb(page2);
      const pages = total > PAGE_SIZE ? Math.min(MAX_PAGES, Math.ceil(total / PAGE_SIZE)) : MAX_PAGES;
      const rest = [];
      for (let p = 3; p <= pages; p++) rest.push(fetchPage(cfg, { page: p, strategy }).catch(() => null));
      for (const r of await Promise.all(rest)) absorb(r);
    } else {
      // No page method worked — try one big request.
      usedStrategy = 'bigPageSize';
      const big = await fetchPage(cfg, { page: 1, pageSize: Math.min(2000, total || 2000), strategy: 'page' }).catch(() => null);
      absorb(big);
    }
  }

  return { count: rows.length, total: total || rows.length, dealer: cfg.key, strategy: usedStrategy, vehicles: rows };
}

async function rawSample(dealerKey, get) {
  const cfg = resolveDealer(dealerKey, get);
  if (!cfg.base || !cfg.siteId) throw new Error(`Dealer "${cfg.key}" isn't set up yet.`);
  const p1 = await fetchPage(cfg, { page: 1 });
  const v1 = findVehicles(p1);
  const { strategy } = await detectStrategy(cfg, vinOf(v1[0]));
  return {
    dealer: cfg.key,
    totalCount: findTotal(p1),
    page1Count: v1.length,
    workingPagination: strategy || 'NONE (need to inspect)',
    firstVehicleMapped: v1[0] ? mapVehicle(v1[0], cfg) : null,
  };
}

module.exports = { loadInventory, rawSample, dealerList, mapVehicle, DEALERS };
