# XENOKING Auto Lister — Privacy Policy

_Last updated: 2026_

XENOKING Auto Lister ("the extension", "we") is a Chrome extension that helps
car dealership staff load vehicle inventory and pre-fill Facebook Marketplace
vehicle listings. This policy explains, in full, what data the extension
collects, how it is used, how it is stored, how it is transmitted, and who it
is (and is not) shared with.

## 1. What data we collect

**Account information (required to sign in):**
- Your **email address** and optional **display name**.
- Your **password**, which is transmitted over an encrypted connection and
  stored only as a one-way **bcrypt hash** — never in plain text.

**Usage information (stored to make the tool work):**
- A record of vehicles you have posted (vehicle VIN, title, and price) so the
  tool can mark them as already listed and power an optional posting count.
- Vehicle inventory you load and your tool settings (selected dealership,
  filters, sales-consultant name), stored locally in your browser.

We do **not** collect: your Facebook login or password, your Facebook messages,
your browsing history, your location, your contacts, or any data from web pages
other than the dealership inventory you choose to load and the Facebook listing
form you choose to fill.

## 2. How we use the data

- **Account data** is used solely to authenticate you and to let the tool's
  owner grant, limit, or revoke access.
- **Usage data** is used solely to operate features you invoke — avoiding
  duplicate listings and displaying your own posting activity.

We do **not** use your data for advertising, profiling, or any purpose
unrelated to the single purpose of the extension.

## 3. How data is stored

- **Account data** (email, name, hashed password, access status) is stored on
  the tool's own backend server database.
- **Inventory, settings, and posting history** are stored **locally in your
  browser** using Chrome's `storage` API. This data stays on your device.

## 4. How data is transmitted (security)

All communication between the extension and its backend server occurs over
**HTTPS (TLS)** — modern encrypted transport. Passwords are sent only over this
encrypted channel and are stored only as a bcrypt hash. The extension does
**not** transmit any user data over unencrypted (HTTP) connections, and does
not send images or user data to any third-party server.

## 5. Who we share data with

**We do not sell, rent, or share your personal data with any third party.**
There are no third-party analytics, advertising, or tracking services in the
extension. Your data is used only by you and the tool's owner, through the
tool's own backend. The only external service involved in normal use is
Facebook — and only because you, the user, are pre-filling a Facebook listing
form that you then review and publish yourself.

## 6. Data retention and deletion

- You may ask the tool's owner to delete your account at any time; this removes
  your account data from the backend.
- **Uninstalling the extension** removes all locally stored data (inventory,
  settings, posting history) from your browser.

## 7. Children

The extension is a business tool for dealership staff and is not directed to
children under 13.

## 8. Changes

If this policy changes, the updated version will be posted at this same
location with a new "Last updated" date.

## 9. Contact

For any privacy question or a data-deletion request, contact the extension
publisher through the Chrome Web Store listing.
