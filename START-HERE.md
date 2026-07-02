# XENOKING backend — full lot + fast loading (final)

What this build does:
- Pages your dealer API with `pageStart` (the parameter the server itself
  names in every response), PLUS every method your other AI's system uses
  (preferences.page as text, inventoryParameters) — 24 methods probed in a
  RACE, first one that works wins instantly.
- Remembers the winning method, so after the first load every "Load Vehicles"
  goes straight to fetching pages: about 3 round trips for the whole lot.
- All ~589 cars, deduped by VIN, with prices, miles, photos.

## Deploy
1. GitHub → xenoking-backend repo → Add file → Upload files → drop in
   `server.js` (replace) → Commit. Render deploys itself (~2 min).
2. Check https://xenoking-backend.onrender.com/api/debug/inventory-sample
   → `workingPagination` should NOT say "NONE" anymore.
3. Tool → Load Vehicles → ~589.

## Why the first click of the day feels slow
Render's free plan puts the server to sleep after ~15 min idle; the first
request wakes it (30–60s). That's the hosting plan, not the tool — every
click after that is fast. (Opening the side panel already wakes it up in
the background, so by the time you log in and click Load it's usually warm.)
