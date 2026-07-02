'use strict';

// Server-side inventory loader. The dealer widget API (ws-inv-data/getInventory)
// checks Origin/Referer, which a browser extension can't set — so we fetch it
// here, page through it, and map each vehicle into the Facebook-catalog row
// shape the extension's sanitizeVehiclesData expects.

// ---- Dealership registry ---------------------------------------------------
// Each entry configures one Corwin store. Only "corwin-dodge" is confirmed;
// fill the others in when we have their siteId/pageId (see README).
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
const MAX_PAGES = 15; // safety cap

function dealerList() {
  return Object.entries(DEALERS).map(([key, d]) => ({ key, label: d.label, configured: !!(d.base && d.siteId) }));
}

// Merge a dealer's built-in config with any owner overrides from settings.
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

function bodyFor(cfg, page) {
  return {
    siteId: cfg.siteId,
    device: 'DESKTOP',
    locale: 'en_US',
    includePricing: true,
    includeMedia: true,
    pageAlias: cfg.pageAlias,
    pageId: cfg.pageId,
    preferences: { pageSize: PAGE_SIZE, page, 'listing.config.id': cfg.listingConfig },
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

// ---- defensive extraction --------------------------------------------------
const first = (obj, keys) => {
  if (!obj) return undefined;
  for (const k of keys) if (obj[k] != null && obj[k] !== '') return obj[k];
  return undefined;
};
const cap = (s) => (s == null ? '' : String(s).trim());
const digits = (s) => cap(s).replace(/[^\d]/g, '');

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
    resp && resp.trackingData && resp.trackingData.totalCount,
  ];
  for (const p of paths) { const n = parseInt(p, 10); if (Number.isFinite(n) && n > 0) return n; }
  return 0;
}

function pickPrice(v) {
  const pricing = v.pricing || v.price || {};
  const arr = pricing.dPrice || pricing.dprice || pricing.prices || (Array.isArray(pricing) ? pricing : []);
  const num = (x) => { const n = parseInt(String(x).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) && n > 0 ? n : 0; };
  if (Array.isArray(arr) && arr.length) {
    const label = (e) => String(e.typeClass || e.type || e.priceType || e.label || e.priceLabel || '').toLowerCase();
    const wanted = arr.find((e) => /sale|internet|asking|selling|final|special|now/.test(label(e)) && num(e.value ?? e.price ?? e.amount ?? e.formattedValue));
    const anyNum = arr.map((e) => num(e.value ?? e.price ?? e.amount ?? e.formattedValue)).filter(Boolean);
    const val = wanted ? num(wanted.value ?? wanted.price ?? wanted.amount ?? wanted.formattedValue) : (anyNum.length ? Math.min(...anyNum) : 0);
    if (val) return val;
  }
  return num(first(v, ['salePrice', 'internetPrice', 'sellingPrice', 'price', 'askingPrice', 'finalPrice', 'bestPrice', 'msrp', 'retailPrice']));
}

function pickImages(v) {
  let imgs = v.images || v.media || v.photos || v.imageList || v.mediaGallery || [];
  if (imgs && !Array.isArray(imgs) && Array.isArray(imgs.images)) imgs = imgs.images;
  if (!Array.isArray(imgs)) imgs = [];
  const uri = (im) => (typeof im === 'string' ? im : first(im, ['uri', 'url', 'src', 'href', 'imageUrl', 'largeUrl', 'mediumUrl']));
  const all = imgs.map(uri).filter(Boolean).map((u) => (u.startsWith('//') ? 'https:' + u : u));
  const actual = imgs.filter((im) => im && /ACTUAL/i.test(String(im.provider || im.type || im.source || ''))).map(uri).filter(Boolean).map((u) => (u.startsWith('//') ? 'https:' + u : u));
  return [...new Set([...actual, ...all])];
}
function flat(v, keys, sub = ['name', 'description', 'value', 'label', 'display']) {
  const x = first(v, keys);
  return typeof x === 'object' ? cap(first(x, sub)) : cap(x);
}
function pickMileage(v) {
  const odo = first(v, ['odometer', 'mileage', 'miles', 'odometerValue', 'mileageValue', 'formattedOdometer', 'odometerFormatted']);
  if (odo == null) return '';
  if (typeof odo === 'object') return digits(first(odo, ['value', 'miles', 'amount', 'display', 'formatted']));
  return digits(odo);
}

function mapVehicle(v, cfg) {
  const year = cap(first(v, ['year', 'modelYear', 'yearId', 'Year']));
  const make = cap(first(v, ['make', 'makeName', 'brand', 'division', 'makeCode', 'Make']));
  const model = cap(first(v, ['model', 'modelName', 'modelCode', 'Model']));
  const trim = cap(first(v, ['trim', 'trimName', 'trimCode', 'Trim']));
  const vin = cap(first(v, ['vin', 'VIN', 'vinNumber']));
  const images = pickImages(v);
  const priceNum = pickPrice(v);
  const cond = String(first(v, ['condition', 'type', 'inventoryType', 'newOrUsed', 'classType']) || (v.certified ? 'certified' : '') || (v.isNew ? 'new' : '')).toLowerCase();
  const state = /new/.test(cond) && !/used/.test(cond) ? 'NEW' : 'USED';
  const link = cap(first(v, ['link', 'url', 'vdpUrl', 'detailUrl', 'href', 'vehicleUrl']));
  const body = cap(first(v, ['bodyStyle', 'body', 'bodyType', 'style', 'segment', 'category', 'chromeBodyType', 'vehicleType']));

  return {
    Title: cap(first(v, ['title', 'displayName'])) || [year, make, model].filter(Boolean).join(' '),
    Year: year, Make: make, Model: model, Trim: trim, VIN: vin,
    Price: priceNum ? `${priceNum} USD` : '',
    'Mileage Value': pickMileage(v),
    'Mileage Unit': 'MI',
    'Image Urls': images.join(';'),
    'Exterior Color': cap(first(v, ['exteriorColor', 'extColor', 'exterior', 'colorExterior', 'colourExterior', 'exteriorColorGeneric'])),
    'Interior Color': cap(first(v, ['interiorColor', 'intColor', 'interior', 'colorInterior', 'colourInterior'])),
    'Body Style': body,
    Drivetrain: flat(v, ['driveLine', 'drivetrain', 'driveType', 'drive', 'driveTrain']),
    Transmission: flat(v, ['transmission', 'trans']),
    engine: flat(v, ['engine', 'engineDescription']),
    fuel_type: cap(first(v, ['fuelType', 'fuel', 'fuelTypeName'])),
    stock_number: cap(first(v, ['stockNumber', 'stock', 'stockNo', 'stockId'])),
    'State of Vehicle': state,
    'Vehicle Id': cap(first(v, ['uuid', 'id', 'vehicleId', 'listingId', 'inventoryId'])) || vin,
    vehicle_type: body,
    'Final Url': link && link.startsWith('http') ? link : (link ? cfg.base + link : ''),
    Button: 'Post',
    firstImage: images[0] || '',
  };
}

// condition: 'new' | 'used' | anything else = all (new + used)
function applyCondition(cfg, condition) {
  const c = String(condition || '').toLowerCase();
  if (c === 'new') return { ...cfg, listingConfig: 'auto-new' };
  if (c === 'used' || c === 'preowned' || c === 'pre-owned') return { ...cfg, listingConfig: 'auto-used' };
  return cfg;
}

async function loadInventory(dealerKey, get, condition) {
  const cfg = applyCondition(resolveDealer(dealerKey, get), condition);
  if (!cfg.base || !cfg.siteId) throw new Error(`Dealer "${cfg.key}" isn't set up yet.`);

  const rows = [];
  const seenVin = new Set();
  const absorb = (resp) => {
    let added = 0;
    if (!resp) return 0;
    for (const v of findVehicles(resp)) {
      const row = mapVehicle(v, cfg);
      if (!row.VIN || seenVin.has(row.VIN)) continue;
      seenVin.add(row.VIN);
      rows.push(row);
      added++;
    }
    return added;
  };

  // Page 1 tells us how big the lot is.
  const p1 = await fetchPage(cfg, 1);
  const total = findTotal(p1);
  const firstCount = absorb(p1);

  if (firstCount >= PAGE_SIZE) {
    // A full first page => there are more. Don't trust a total that looks like a
    // per-page number; fetch generously (capped) and let dedup sort it out.
    const wanted = total > PAGE_SIZE ? Math.ceil(total / PAGE_SIZE) : MAX_PAGES;
    const pages = Math.min(MAX_PAGES, Math.max(wanted, 8));
    const rest = [];
    for (let p = 2; p <= pages; p++) rest.push(fetchPage(cfg, p).catch(() => null));
    for (const resp of await Promise.all(rest)) absorb(resp);
  }

  return { count: rows.length, total: total || rows.length, dealer: cfg.key, vehicles: rows };
}

// Debug: return the raw first vehicle + response keys so field names can be
// verified against a real dealer response.
async function rawSample(dealerKey, get) {
  const cfg = resolveDealer(dealerKey, get);
  if (!cfg.base || !cfg.siteId) throw new Error(`Dealer "${cfg.key}" isn't set up yet.`);
  // Probe pages 1 and 2 to prove pagination works.
  const [r1, r2] = await Promise.all([fetchPage(cfg, 1), fetchPage(cfg, 2).catch(() => null)]);
  const v1 = findVehicles(r1);
  const v2 = r2 ? findVehicles(r2) : [];
  const vin = (v) => v && (v.vin || v.VIN || v.vinNumber);
  const paginationWorks = v2.length > 0 && vin(v2[0]) && vin(v2[0]) !== vin(v1[0]);
  return {
    dealer: cfg.key,
    responseTopKeys: r1 && typeof r1 === 'object' ? Object.keys(r1) : [],
    totalCount: findTotal(r1),
    page1Count: v1.length,
    page2Count: v2.length,
    paginationWorks,
    diagnosis: paginationWorks
      ? 'Pagination OK — all pages will load.'
      : (v2.length === 0 ? 'Page 2 returned nothing (single page or page param ignored).'
        : 'Page 2 returned the SAME cars as page 1 — the page parameter is being ignored; need the exact request.'),
    firstVehicleRaw: v1[0] || null,
    firstVehicleMapped: v1[0] ? mapVehicle(v1[0], cfg) : null,
  };
}

module.exports = { loadInventory, rawSample, dealerList, DEALERS };
