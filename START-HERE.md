# XENOKING — Update: Car/van fix + all-588 pagination

Two separate fixes. The **extension** one is the important one you asked for.

---

## 1) Extension — fixes the Make problem (do this now)

Facebook renamed the vehicle type from "Car/Truck" to **"Car/van"**, which is
why the tool kept landing on "Other" and the Make box stayed empty. The tool
now picks **Car/van** (and still works if Facebook shows the old name), so the
Make dropdown appears and gets selected automatically like before.

1. Chrome → `chrome://extensions`
2. **Remove** XENOKING, then **Load unpacked** → pick the new `xenoking-extension` folder.
3. Post a car — vehicle type should land on **Car/van** and Make should fill itself.

Nothing else in the extension changed. Same login, same everything.

---

## 2) Backend — gets you all 588 cars (one file swap, whenever you want)

Your debug link showed Corwin caps every request at 100 and ignores all the
normal "page 2" parameters. This build adds the paging channel the dealer
website itself uses (searchParameters), plus a full probe report.

1. GitHub repo → **Add file → Upload files** → drop in `server.js` from the
   `xenoking-backend` folder (replace). Commit. Render auto-deploys.
2. **Don't open/edit the file, don't accept Copilot suggestions.**
3. After deploy, open:
   `https://xenoking-backend.onrender.com/api/debug/inventory-sample`
   - `workingPagination` should now say **spStart** (or another name — anything
     but "NONE").
   - Then hit **Load Vehicles** in the tool: Total Vehicles should be ~588.
4. If it STILL says NONE, copy me the new `probes` list from that page — it now
   shows exactly what the dealer API answered for every method, so I can nail
   it in one look.
