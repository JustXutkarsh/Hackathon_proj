# CountMeIn

Conditional group funding for friends organizing sports and outings.

## Current build

- Responsive vanilla HTML/CSS/JavaScript app in `dist/`, preserving the green/cream design.
- `/`: authenticated shared plans. `/plan/<random UUID>`: permanent invitation, with anonymous preview and authenticated participation.
- Supabase email magic links, restored sessions, sign-out, and editable display names. The invitation path is included in the email redirect, including when the email is opened in another browser.
- Plans and participation live in Postgres. Every contribution and refund is **simulated demo credits**, never real money. Creating a plan does not join the organizer.
- `/local`: the original browser-local demo, including sample people, fake-friend controls, deadline controls, and demo collection. Local data is never uploaded to Supabase.
- Shared funding confirms permanently when the target fills before the deadline. Open contributions remain committed. A missed target or organizer cancellation opens individual, one-time simulated refunds. Funding is not a venue-booking guarantee. There is no shared payout or real-payment flow.
- Solidity escrow source and a local-chain integration test are included. The frontend is not connected to the contract. No contract has been deployed to Monad.

## Running

Use Node 22.9+ and `npm ci`. Configure `.env` using the names in `.env.example`, then run `npm run dev` and open http://127.0.0.1:4173. Use `PORT=4175 npm run dev` if that port is occupied. The build bundles the Supabase browser client with esbuild; this is still a static app, with no framework or application server in production.

`npm run build` checks JavaScript, runs the local model and static-server tests, and generates the ignored `dist/shared.bundle.js`. Without public settings, it builds an explicit unconfigured shared screen and keeps the local demo usable. Never open `index.html` as a file URL.

Configuration accepts `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`). These values are intentionally public and bundled at build time. `.env` is ignored. The build rejects secret keys and legacy JWTs whose role is not `anon`; never supply a service-role key or database password to browser/build configuration.

For contract checks: install `solc@0.8.30 ethers@6.15.0 ganache@7.9.2` locally, then run `node tests/escrow.cjs`. Compilation outputs `artifacts/CountMeIn.json`. Tests deploy only to an ephemeral local EVM.

## Contract behavior

`createPlan(recipient, price, target, deadline, eventAt, detailsHash)` stores immutable funding terms. Participant slots are wallet addresses, not identities. The organizer is not automatically a participant.

Each address can join once with exactly `price` native tokens before the deadline. Filling the exact target makes a plan funded permanently. Any caller may then trigger `collect`, which pays only the immutable recipient. This avoids relying on an organizer transaction to deliver funds. The demo UI exposes collection only to the organizer for simplicity.

An organizer may cancel only while the plan is open. A missed target at the deadline makes it refundable. Each depositor calls `claimRefund(id, to)` to recover their own deposit. Claims are pull-based; no background process sends refunds automatically. Gas is not refunded. State updates precede external transfers and a global reentrancy guard protects joins, payouts, and refunds.

This prototype uses native test tokens, not fiat or stablecoins. It does not verify attendance, humans, venue availability, venue delivery, or booking. Collection is a transfer to a named recipient, not a booking guarantee. If a recipient contract rejects payment, collection reverts and funds remain in escrow; recipient design and recovery policy need review before any production use. The contract has no fees, upgrade authority, admin sweep, or yield.

## Supabase setup

The current hosted database is **Hackathon_pj**, project reference `ednddqfwazggfsdaklwp` (also recorded in `supabase/project-ref.txt`). The initial migration has been applied there.

1. For a new Supabase project, run `supabase/migrations/202610040001_shared_plans.sql` once in its **SQL Editor**. For CLI-managed setup, run `supabase link --project-ref "$(cat supabase/project-ref.txt)"` and `supabase db push`. Do not reapply the migration manually to Hackathon_pj.
2. In **Authentication > Providers**, enable Email and allow sign-ups. Keep the magic-link email template's `{{ .ConfirmationURL }}` link. Configure custom SMTP for delivery to friends outside your Supabase organization; the default mailer has recipient/rate restrictions.
3. In **Authentication > URL Configuration**, set Site URL to `https://hackathonproj-beige.vercel.app`. Add these Redirect URLs: `https://hackathonproj-beige.vercel.app/`, `https://hackathonproj-beige.vercel.app/plan/*`, `http://127.0.0.1:4173/`, and `http://127.0.0.1:4173/plan/*`. Add the exact origin and `/plan/*` pattern for the feature branch's Vercel preview URL too. Keep each configured local origin/port consistent with the URL you open.
4. Leave only the usual `public` schema exposed in the Data API; do **not** expose `countmein_private`. Obtain the Project URL and publishable key from the project's connection/API settings. Set the two public environment variables described above locally and on Vercel, then rebuild.

The client uses Supabase's [browser implicit magic-link flow](https://supabase.com/docs/guides/auth/sessions/implicit-flow), so it does not depend on a verifier saved in the requesting browser. The SDK consumes the callback fragment and persists the session. The app removes callback fragments from the address bar and preserves only the invitation path. A display name is private auth metadata, not an authorization input.

## Database access

`countmein_private.plans` and `participations` have RLS enabled with restrictive deny policies, and no client schema/table grants. Clients cannot list either table. Narrow `SECURITY DEFINER` functions have an empty search path and explicitly restricted execution grants, following [Supabase's function security guidance](https://supabase.com/docs/guides/database/functions).

- `preview_plan(p_token)`: anonymous/authenticated access to one unguessable invitation. Returns terms, aggregate count, and caller-specific ownership/join/refund flags. No emails, user IDs, organizer identity, or participant names are returned.
- `my_plans()`: authenticated users see only plans they created or joined; there is no public directory.
- `create_plan(...)`: owner is always `auth.uid()`; constraints enforce valid terms, and the function enforces a future deadline.
- `act_on_plan(p_token, p_action)`: join/cancel/refund use one common `SELECT ... FOR UPDATE` lock before checking the current clock, capacity, membership, or state. The participation primary key prevents duplicate membership. Only the organizer can cancel an open plan, and refunds update only the caller's own unrefunded participation.

An expired open plan is presented as failed even without a background job; a successful refund persists the failed state. A funded plan never expires. Clients cannot change terms or advance deadlines. A UUID invitation has 122 random bits; possession permits preview and sharing, not authorization to act as someone else. Treat links as private invitations. Referrer headers and indexing are disabled; do not add analytics that capture invitation paths.

The frontend reloads database state after mutations, on focus/visibility return, and every 30 seconds while visible. It never calculates authoritative shared state from local demo records. Pending actions are disabled, and failures show retry/sign-in recovery. An interrupted request may have committed; refresh before trying again. Database uniqueness and refund checks prevent duplicate contributions/refunds on retries.

## Verification

- `npm test`: existing local practice rules and missing-asset/deep-link dev-server regression.
- `npm run test:db`: starts and removes an isolated real PostgreSQL cluster using the dev-only embedded binary. Emulates Supabase's auth roles/`auth.uid()` boundary and applies the actual migration. Checks grants, RLS defense in depth, response privacy, user-derived ownership, invalid terms, duplicate joins, unauthorized cancellation, refund ownership/duplicates, funded persistence, and deadline enforcement after lock waits. Two independent connections are verified to be blocked on the same plan before competing for the final spot; exactly one succeeds. No hosted database credentials are used. Run as a non-root user.
- `npx playwright install chromium`, then `npm run test:browser`: isolated browser sessions test create/copy/join/refresh, direct-link reload, auth redirect/callback/restoration/sign-out, display name, request suppression, errors, and local-mode isolation. These browser tests mock the Supabase HTTP boundary; they do **not** prove hosted Auth, SMTP, PostgREST, or Vercel configuration. `PLAYWRIGHT_CHANNEL=chrome npm run test:browser` uses installed Chrome instead. Screenshots are written to ignored `test-results/`.
- `npm run test:escrow`: existing Solidity checks, after installing the optional dependencies above. Contract source is unchanged and nothing is deployed.
- GitHub Actions runs build/model, real-Postgres, and Chromium checks on pushes and pull requests. Vercel's static build does not need to start a database/browser.

Before accepting the hosted deployment, use two separate browsers/accounts: A creates a plan and copies its URL; B opens it anonymously, signs in from the email, and joins; both refresh and see the same count. Check direct URL refresh, expired email recovery, an unauthorized cancel call, two users competing for the last spot, and one refund each after cancellation/expiry. Also verify anonymous table/directory reads and mutations are denied. These hosted checks require the migration, redirect allowlist, working SMTP and two controlled email accounts; local automated checks do not replace them.

## Deploy to Vercel

Keep production on `main` until this feature branch is reviewed. Push `feature/shared-plans-auth` to get a Vercel Preview deployment; do not merge automatically.

- Root directory: repository root (`.`).
- Framework preset: Other.
- Build command: `npm run build`.
- Output directory: `dist`.
- Node version: 22.x or newer.
- Environment variables: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, set for **Preview** and **Production**. Use the project's public values, never database/admin secrets. Redeploy after changing them.

`vercel.json` supplies the build/output settings, headers, and rewrites for `/plan/:token` and `/local`. Assets have absolute paths so direct invitation refreshes work. Only `dist/` is served; migrations and tests remain private project files. Supabase must be configured separately; hosting does not install SQL or deploy the escrow.

Vercel configuration reference: https://vercel.com/docs/project-configuration/vercel-json
