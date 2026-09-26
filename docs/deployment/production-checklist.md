# Sotoayam Production Checklist

Use this checklist with [VPS production deployment](vps-production.md). Never paste secret values into tickets, logs, or command output.

## Pre-deploy

- [ ] DNS A/AAAA record points to the Linux VPS and propagation is complete.
- [ ] Dedicated non-root deploy account and `sotoayam` service account exist.
- [ ] Firewall exposes only SSH, HTTP, and HTTPS; port 3000 is not public.
- [ ] Customer Supabase project/database and protected service-role credential are ready.
- [ ] Dedicated Telegram bot token and username are ready; no other poller uses the token.
- [ ] `shared/.env` uses `HOST=127.0.0.1`, `TRUST_PROXY=true`, and `SESSION_COOKIE_SECURE=true` with mode `0640`.
- [ ] A verified backup and recovery plan exists before upgrading an existing installation.

## Deploy

- [ ] Build a versioned archive from a clean committed Git checkpoint with `scripts/deploy/package-release.ps1`; confirm no `.partial.*` artifact remains.
- [ ] Bootstrap the VPS once; install the protected runtime environment with `install-env.sh`.
- [ ] Provide deploy-only Supabase project ref, access token, and database password outside `shared/.env`.
- [ ] Run `deploy-release.sh`; require dependency install, build artifact validation, and all migrations to succeed.
- [ ] Confirm the systemd service is enabled and active under the non-root account.
- [ ] Install the Nginx config, validate with `nginx -t`, and enable a valid HTTPS certificate.
- [ ] Confirm Node listens only on `127.0.0.1:3000`.

## First run

- [ ] Open `https://<domain>/setup` and create the first OWNER; do not use SQL/manual database surgery.
- [ ] Restart once after fresh setup, then confirm `/setup` redirects to the login page.
- [ ] Sign in, review business settings, and confirm the business actor.
- [ ] Pair the customer Telegram identity through the authenticated dashboard.
- [ ] Review all seven notification preferences and send one controlled test notification.
- [ ] Enable polling/schedulers only on the single process designated to own them.

## Acceptance

- [ ] `GET /health` returns HTTP 200 for liveness.
- [ ] `GET /ready` returns HTTP 200 with `status=READY`.
- [ ] Login, task creation, task status flow, and logout work over HTTPS.
- [ ] Exactly one Telegram test delivery is observed.
- [ ] `npm run backup:create` produces archive plus manifest and `npm run backup:verify` passes.
- [ ] `journalctl -u sotoayam.service` contains no secret values or repeated crash loop.
- [ ] Record the active Git SHA/release directory and the previous compatible release for application rollback.
