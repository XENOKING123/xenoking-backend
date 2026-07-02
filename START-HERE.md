# XENOKING — Final Update (read this first)

This fixes the two big problems and adds everything you asked for:
**all 588 cars now load** (new + used), **prices show again**, plus a store
dropdown, New/Used/Certified filter, working search, clean descriptions, and
**bulk posting**.

There are **two parts**. Do Part 1 first — the "only 100 cars / price not
available" problem lives in the **backend**, so it won't go away until you
redeploy it.

---

## Part 1 — Update the backend (fixes 588 cars + prices)

Your current server on Render is running old code. Replace it with the 3 files
in **`xenoking-backend/`**:

- `server.js`   ← the whole backend in ONE file (can't get scrambled)
- `package.json`
- `render.yaml`

### If you deploy from GitHub (what you've been doing)
1. Open your GitHub repo → **Add file → Upload files**.
2. Drag in `server.js` and `package.json` from the `xenoking-backend` folder,
   replacing the old ones. (Upload `render.yaml` too if it's not there.)
3. Commit. Render will **auto-deploy** in a couple minutes.
4. **Do NOT open the files to "edit" them, and do not accept any Copilot / AI
   suggestion** — that's what scrambled them last time. Just upload and commit.

### Check it worked
Open this link in your browser after it finishes deploying:

```
https://xenoking-backend.onrender.com/api/debug/inventory-sample
```

You want to see:
- `"totalCount": 588` (or however many you have)
- `"bigPageWorks": true`
- `"firstVehicleMapped": { ... "Price": "29294 USD" ... }`  ← price is filled in

If `bigPageWorks` is `false`, tell me the value of `workingPagination` from that
page and I'll lock it in — but it should be `true`.

---

## Part 2 — Update the extension

Use the **`xenoking-extension/`** folder.

1. Chrome → `chrome://extensions` → turn on **Developer mode** (top right).
2. If XENOKING is already there, click **Remove** (this only clears the app, not
   your online accounts — those live on the backend).
3. Click **Load unpacked** → pick the `xenoking-extension` folder.
4. Open the side panel and log in.

---

## What's new in the tool

- **Store dropdown** — Corwin Chrysler Dodge is live. Honda / Subaru / Toyota /
  CPW show "coming soon" until you send me their inventory API details.
- **Show: All / New / Used / Certified** — pick before you hit Load Vehicles.
- **Search** actually filters now (type make, model, trim, VIN, price…).
- **Load Vehicles** pulls the **whole lot** (all 588), with photos + prices.
- **Bulk posting** — every car has a checkbox. Use **Select All** or tick the
  ones you want, then **Post Selected**. It posts them one after another and
  shows progress; **Stop** halts it. The **Delay** box (seconds) is the gap
  between each listing — give yourself enough time to review/publish each one
  before the next opens.
- **Descriptions** are clean with emojis, price, mileage, drivetrain, engine and
  colors. Anything you type in the description box gets included.
- **Category** now defaults to **Car/Truck** (no more posting as "Other").

---

## Owner controls (accounts)

Same as before: sign-ups land as **pending**; approve / ban / block / set an
access duration from the **Owner** tab. Only approved users can load or post.
