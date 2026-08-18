# BloodNet v2 (bnetv2)

A Bengali-language blood donor management platform for Bangladesh, built entirely on Cloudflare's edge stack with no build step and no Node.js runtime dependencies.

## Stack

- **Cloudflare Workers** - single `src/worker.js` entry point, modular handlers under `src/handlers/` and `src/lib/`
- **D1 (SQLite)** - relational data: users, calls, donations, locations, external sources, settings, activity log
- **Workers KV** - ephemeral state: OTP codes, donor call-locks, per-requester rolling rate limits
- **Vanilla HTML/CSS/JS** - single-page app under `public/`, no framework, no bundler
- **Lucide icons** via the `unpkg` CDN script tag
- **ImgBB** for profile picture hosting
- **donor.bd** for the shared cross-platform username/short-link system
- Stateless HMAC-signed JWT sessions (Web Crypto, no jsonwebtoken package)

## Features

- Bengali-first UI (Noto Serif Bengali + Poppins), light theme only, mobile-first and desktop-responsive
- Bookmarkable URLs for every major screen via a small client-side router with server-side SPA fallback
- Unified login for requesters and donors, with granular checkbox-based admin permissions
- Blood-seeking flow with donor call-locking, rate limiting, and an unresponsiveness-aware serving order
- Donor self-service: eligibility toggle/snooze, notes, direct donation entry, mobile/location change
- Claimable usernames (`/username`) synced to the donor.bd central redirect service
- Full admin panel: users (CRUD/CSV import-export/bulk actions), SMS templates + live test-send tool, site API keys, branding/site settings, locations, external sources, activity log, analytics dashboard
- Admin-configurable OTP delivery: live SMS, a test mode that logs OTPs to the Activity Log, or a fixed manual OTP for QA

## Local setup

See `cloudflare-ignore/instructions.html` for step-by-step deployment commands (D1, KV, secrets, and `wrangler deploy`). That file - along with this README - is intentionally excluded from the deployed Worker via `.cloudflareignore`.

## Folder structure

```
├── img/                    reference copies of the placeholder branding images
├── cloudflare-ignore/
│   └── instructions.html   deployment steps + interactive API tester (not deployed)
├── public/                 static frontend (served via Workers Static Assets)
│   ├── index.html
│   ├── css/app.css
│   ├── js/                 api.js, ui.js, views-*.js, app.js (router)
│   └── img/                favicon, logo, social preview
├── src/
│   ├── worker.js           request router / entry point
│   ├── handlers/           auth, seek, donor, profile, calls, admin
│   └── lib/                jwt, util, permissions, settings, sms, donorbd, imgbb, kvstore, activity, authctx
├── schema.sql
└── wrangler.toml
```

## License

MIT License. Copyright (c) rijwanul.com
