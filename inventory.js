'use strict';

// Server-side inventory loader. The dealer widget API (ws-inv-data/getInventory)
// checks Origin/Referer, which a browser extension can't set — so we fetch it
// here (server-side, headers set freely), page through it, and map each vehicle
// into the row shape the extension's sanitizeVehiclesData expects (Facebook
// Automotive Catalog columns). Defaults target Corwin; override via settings.

const DEFAULTS = {
  dealerBase: 'https://www.corwinchryslerdodge.com',
  dealerSiteId: 'corwinchryslerdodgecllc',
  dealerPageId: 'corwinchryslerdodgecllc_SITEBUILDER_INVENTORY_SEARCH_RESULTS_AUTO_ALL_V1_1',
  dealerPageAlias: 'INVENTORY_LISTING_DEFAULT_AUTO_ALL',
  dealerListingConfig: 'auto-new,auto-used',
  dealerPageSize: 100,
  dealerPages: 6,
};

function cfgFrom(get) {
  // get(key) -> stored value or null; fall back to defaults.
  const v = (k) => {
    const s = get(k);
    return s === null || s === undefined || s === '' ? DEFAULTS[k] : s;
  };
  return {
    base: String(v('dealerBase')).replace(/\/+$/, ''),
    siteId: v('dealerSiteId'),
    pageId: v('dealerPageId'),
    pageAlias: v('dealerPageAlias'),
    listingConfig: v('dealerListingConfig'),
    pageSize: parseInt(v('dealerPageSize'), 10) || 100,
    pages: parseInt(v('dealerPages'), 10) || 6,
  };
}

function bodyFor(cfg, page) {
  return {
    siteId: cfg.siteId,
    device: 'DESKTOP',
    locale: 'en_US',
    includePricing: true,
    includeMedia: true,
    pageAlias: cfg.pageAlias,
    pageId: cfg.pageId,
    preferences: { pageSize: cfg.pageSize, page, 'listing.config.id': cfg.listingConfig },
    widgetName: 'ws-inv-data',
    windowId: 'inventory-data-bus2',
  };
}

async function fetchPage(cfg, page) {
  const url = `${cfg.base}/api/widget/ws-inv-data/getInventory`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Origin: cfg.base,
      Referer: cfg.base + '/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
    body: JSON.stringify(bodyFor(cfg, page)),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`dealer API page ${page} -> HTTP ${res.status}`);
  return res.json();
}

// ---- defensive extraction helpers -----------------------------------------
const first = (obj, keys) => {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return undefined;
};
// Find the array of vehicles anywhere in the response (array of objects with a vin).
function findVehicles(resp) {
  const seen = new Set();
  const looksLikeVehicle = (o) => o && typeof o === 'object' && (o.vin || o.VIN || o.vinNumber);
  let best = [];
  const walk = (node, depth) => {
    if (!node || depth > 6 || seen.has(node)) return;
    if (typeof node === 'object') seen.add(node);
    if (Array.isArray(node)) {
      if (node.length && node.some(looksLikeVehicle) && node.length > best.length) best = node;
      node.forEach((n) => walk(n, depth + 1));
    } else if (typeof node === 'object') {
      for (const k of Object.keys(node)) walk(node[k], depth + 1);
    }
  };
  // common direct locations first
  const direct = resp && (resp.inventory || (resp.pageInfo && resp.pageInfo.inventory) || (resp.data && resp.data.inventory) || resp.vehicles);
  if (Array.isArray(direct) && direct.some(looksLikeVehicle)) return direct;
  walk(resp, 0);
  return best;
}

function pickPrice(v) {
  // pricing.dPrice[] / dprice[] entries; prefer a sale/internet/asking price.
  const pricing = v.pricing || v.price || {};
  const arr = pricing.dPrice || pricing.dprice || pricing.prices || (Array.isArray(pricing) ? pricing : []);
  const num = (x) => {
    const n = parseInt(String(x).replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  if (Array.isArray(arr) && arr.length) {
    const label = (e) => String(e.typeClass || e.type || e.priceType || e.label || '').toLowerCase();
    const wanted = arr.find((e) => /sale|internet|asking|selling|final|special/.test(label(e)) && num(e.value ?? e.price ?? e.amount));
    const anyNum = arr.map((e) => num(e.value ?? e.price ?? e.amount)).filter(Boolean);
    const val = wanted ? num(wanted.value ?? wanted.price) : (anyNum.length ? Math.min(...anyNum) : 0);
    if (val) return val;
  }
  return num(first(v, ['salePrice', 'internetPrice', 'sellingPrice', 'price', 'askingPrice', 'msrp']));
}

function pickImages(v) {
  let imgs = v.images || v.media || v.photos || v.imageList || [];
  if (!Array.isArray(imgs)) imgs = [];
  const uris = imgs
    .map((im) => (typeof im === 'string' ? im : first(im, ['uri', 'url', 'src', 'href', 'imageUrl'])))
    .filter(Boolean)
    .map((u) => (u.startsWith('//') ? 'https:' + u : u));
  // prefer ACTUAL_PHOTO ordering if provider info exists
  const actual = imgs.filter((im) => im && /ACTUAL/i.test(String(im.provider || im.type || '')))
    .map((im) => first(im, ['uri', 'url', 'src'])).filter(Boolean);
  const ordered = [...new Set([...actual, ...uris])];
  return ordered;
}

const cap = (s) => (s == null ? '' : String(s).trim());

function mapVehicle(v, cfg) {
  const year = cap(first(v, ['year', 'modelYear', 'Year']));
  const make = cap(first(v, ['make', 'makeName', 'Make']));
  const model = cap(first(v, ['model', 'modelName', 'Model']));
  const trim = cap(first(v, ['trim', 'trimName', 'Trim']));
  const vin = cap(first(v, ['vin', 'VIN', 'vinNumber']));
  const images = pickImages(v);
  const priceNum = pickPrice(v);
  const odo = first(v, ['odometer', 'mileage', 'miles']);
  const mileage = typeof odo === 'object' ? cap(first(odo, ['value', 'miles', 'amount'])) : cap(odo);
  const cond = String(first(v, ['condition', 'type', 'inventoryType', 'certified']) || '').toLowerCase();
  const state = /new/.test(cond) ? 'NEW' : 'USED';
  const link = cap(first(v, ['link', 'url', 'vdpUrl', 'detailUrl', 'href']));
  const engine = (() => { const e = first(v, ['engine', 'engineDescription']); return typeof e === 'object' ? cap(first(e, ['name', 'description', 'value'])) : cap(e); })();
  const trans = (() => { const t = first(v, ['transmission', 'trans']); return typeof t === 'object' ? cap(first(t, ['name', 'description', 'value'])) : cap(t); })();

  return {
    Title: cap(first(v, ['title', 'displayName'])) || [year, make, model].filter(Boolean).join(' '),
    Year: year, Make: make, Model: model, Trim: trim, VIN: vin,
    Price: priceNum ? `${priceNum} USD` : '',
    'Mileage Value': mileage.replace(/[^\d]/g, ''),
    'Mileage Unit': 'MI',
    'Image Urls': images.join(';'),
    'Exterior Color': cap(first(v, ['exteriorColor', 'extColor', 'exterior', 'colorExterior'])),
    'Interior Color': cap(first(v, ['interiorColor', 'intColor', 'interior', 'colorInterior'])),
    'Body Style': cap(first(v, ['bodyStyle', 'body', 'bodyType'])),
    Drivetrain: cap(first(v, ['driveLine', 'drivetrain', 'driveType', 'drive'])),
    Transmission: trans,
    engine,
    fuel_type: cap(first(v, ['fuelType', 'fuel'])),
    stock_number: cap(first(v, ['stockNumber', 'stock', 'stockNo'])),
    'State of Vehicle': state,
    'Vehicle Id': cap(first(v, ['uuid', 'id', 'vehicleId', 'listingId'])) || vin,
    vehicle_type: cap(first(v, ['bodyStyle', 'vehicleType'])),
    'Final Url': link && link.startsWith('http') ? link : (link ? cfg.base + link : ''),
    Button: 'Post',
    firstImage: images[0] || '',
  };
}

async function loadInventory(get) {
  const cfg = cfgFrom(get);
  const pages = [];
  for (let p = 1; p <= cfg.pages; p++) pages.push(p);
  const responses = await Promise.all(pages.map((p) => fetchPage(cfg, p).catch(() => null)));
  const rows = [];
  const seenVin = new Set();
  for (const resp of responses) {
    if (!resp) continue;
    for (const v of findVehicles(resp)) {
      const row = mapVehicle(v, cfg);
      if (!row.VIN || seenVin.has(row.VIN)) continue;
      seenVin.add(row.VIN);
      rows.push(row);
    }
  }
  return { count: rows.length, vehicles: rows };
}

async function rawSample(get) {
  const cfg = cfgFrom(get);
  const resp = await fetchPage(cfg, 1);
  const vehicles = findVehicles(resp);
  return { cfg: { base: cfg.base, siteId: cfg.siteId }, found: vehicles.length, firstVehicle: vehicles[0] || null };
}

module.exports = { loadInventory, rawSample, DEFAULTS };
