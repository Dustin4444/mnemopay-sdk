# MnemoPay dashboard deployment

This dashboard is the hosted MnemoPay console: Brain, billing, usage, audit,
members, and developer keys.

## Required production env

```bash
MNEMOPAY_CONSOLE_STORE_DRIVER=postgres
MNEMOPAY_CONSOLE_POSTGRES_URL=postgres://...
MNEMOPAY_SESSION_SECRET=...
MNEMOPAY_PUBLIC_URL=https://dashboard.mnemopay.com
NODE_ENV=production
```

`MNEMOPAY_CONSOLE_POSTGRES_URL` can also be supplied as `NEON_URL` or
`DATABASE_URL`.

## Stripe env

```bash
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Optional price id envs. If these are not set, Checkout resolves Stripe Prices by
lookup key:

```bash
STRIPE_PRICE_MNEMOPAY_PRO_MONTHLY=price_...
STRIPE_PRICE_MNEMOPAY_PRO_YEARLY=price_...
STRIPE_PRICE_MNEMOPAY_TEAM_MONTHLY=price_...
STRIPE_PRICE_MNEMOPAY_TEAM_YEARLY=price_...
```

Webhook endpoint:

```text
POST https://dashboard.mnemopay.com/api/v1/billing/stripe/webhook
```

Handled event types:

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

## Resend env

```bash
RESEND_API_KEY=re_...
MNEMOPAY_AUTH_EMAIL_FROM="MnemoPay <login@mnemopay.com>"
```

## Fly deploy

From `dashboard/`:

```bash
fly secrets set \
  MNEMOPAY_CONSOLE_POSTGRES_URL="postgres://..." \
  MNEMOPAY_SESSION_SECRET="..." \
  MNEMOPAY_PUBLIC_URL="https://dashboard.mnemopay.com" \
  STRIPE_SECRET_KEY="sk_live_..." \
  STRIPE_WEBHOOK_SECRET="whsec_..." \
  RESEND_API_KEY="re_..." \
  MNEMOPAY_AUTH_EMAIL_FROM="MnemoPay <login@mnemopay.com>"

fly deploy
```

## Readiness

```bash
curl https://dashboard.mnemopay.com/readyz
curl https://dashboard.mnemopay.com/api/v1/ops/readiness
```

`/readyz` returns `503` when required production config is missing. Recommended
items such as Stripe and Resend may show as incomplete while the service remains
bootable.

## Local production-shaped run

```bash
npm install
MNEMOPAY_CONSOLE_STORE_DRIVER=postgres \
MNEMOPAY_CONSOLE_POSTGRES_URL="postgres://..." \
MNEMOPAY_SESSION_SECRET="dev-secret" \
MNEMOPAY_AUTH_RETURN_CODES=true \
npm start
```

## Verification flow

1. Open `/readyz` and confirm `status: ok`.
2. Request a console sign-in code from the Session tab.
3. Confirm the email sends through Resend, or dev code appears when explicitly enabled.
4. Verify the code and confirm `/api/v1/auth/session` returns `authenticated: true`.
5. Create a Stripe Checkout Session from the Billing tab.
6. Complete checkout in Stripe test/live mode.
7. Confirm the webhook provisions the account plan and writes audit events.
