# CountMeIn

Conditional group funding for friends organizing sports and outings. **Monad testnet - test tokens have no monetary value.** Mainnet/real-value payments are disabled. This release is not independently audited or production-ready.

## Release

- Existing vanilla HTML/CSS/JavaScript stack and responsive green/cream design; Vercel serves `build/` with small Node API functions.
- Supabase email magic links, session restoration, private display names, sign-out and invitation preservation across devices.
- Server-verified SIWE wallet challenges bound to account, domain, URI, chain, nonce and five-minute expiry. Consumption is atomic and replay-protected. Injected EIP-1193 externally owned wallets work; embedded wallets, contract-wallet login and sponsored gas are not implemented.
- Immutable drafts, exact integer test MON amounts, financial review, actual onchain publication/deposits/collection/cancellation/refunds. Creation does not join the organizer. Invitations become shareable only after verified publication.
- Private receipts and business-state filters, gas estimates, rejected/reverted prompts, durable pending-hash tracking, replacement verification and outage recovery.
- Finalized-event synchronization with idempotent records, retryable backfills, persistent checkpoints and fail-closed consistency checks.

**No demo controls, sample participants, simulated credits or `/local` route are served.** Historical source/model tests and database rows remain preserved, never converted into actual funding. Migration 003 retires the browser-writable legacy RPCs and hides version-1 plans instead of deleting data.

## Funding Rules

Immutable terms: 2-50 wallet slots, one exact positive contribution per wallet, fixed recipient, future funding deadline before event time. Financial amounts use integer wei/`BigInt`, never floats. Wallets do not prove unique humans or attendance.

Deposits remain committed while open; no change-of-mind withdrawal. Filling all slots strictly before the block-timestamp deadline permanently funds the plan. At the exact deadline, underfilled plans reject deposits and permit individual refunds. Funded plans remain funded later. Only the onchain organizer can cancel an open plan; full funding prevents organizer cancellation or unilateral refunds.

Anyone can trigger `collect(id)`, which pays only the immutable recipient. The UI offers collection to organizer/recipient; it is **not automatic**. After payout the contract cannot recover funds. Funding does not guarantee booking, attendance or delivery. Post-funding cancellation, disputes and voluntary repayment are outside the contract rules.

Only the depositing wallet can call `claimRefund(id,to)`. Failed transfers preserve claim rights; each deposit refunds once. Network fees are separate and not refunded. No platform fees, yield, upgrade authority, admin sweep or participant loops.

**Recipient failure:** failed collection leaves funding intact. Only the immutable recipient may invoke `collectTo(id,to)` to redirect its own entitlement to a nonzero address. Organizers/administrators cannot redirect it. A recipient contract must have a controlled way to invoke this method; one with no such capability can still trap its own payout. Recipient operability and this policy need independent review before mainnet. Tests cover failed transfers, authorization, reentrancy and double withdrawal.

## Trust And Privacy

Monad determines payments and refund rights. Supabase stores accounts, offchain descriptions, invitation tokens, verified wallet links and receipt caches, never private keys or custodial funds.

Backend authentication calls Supabase `getUser`; client-supplied account IDs are ignored. Only `service_role` can execute `release_admin`. All private tables have restrictive RLS and denied client grants. UUID previews expose published terms and aggregate counts, not emails, account IDs or participant lists. There is no public directory. Blockchain wallets/terms/transactions are public even if the invitation is unlisted.

The canonical v2 hash commits chain ID, invitation token, title, activity, location, escrow, organizer, recipient, integer contribution, target, deadline and event time. Description stays offchain and is SQL-frozen with the terms. Commitments are unique **per organizer**, preventing duplicate publication without letting another wallet reserve its commitment. Avoid sensitive personal information and analytics that capture invitation URLs.

The verifier checks chain 10143, exact runtime bytecode, canonical finalized receipt, contract emitter, plan ID, sender, calldata, amount and expected event. A supplied hash is only a lookup hint. Receipts are idempotent by chain/contract/hash/log index. Backfill also supports direct contract interactions and nested contract-wallet events. Reverted transactions never become deposits.

Reads consistently use `finalized`, never silently fall back to `latest`. [Monad documentation](https://docs.monad.xyz/developer-essentials/summary) distinguishes two-block consensus finality from the later Verified execution stage. This escrow/cache release uses finalized executed state, not speculative Voted state; it does not settle offchain financial obligations. Additional Verified-stage handling must be reviewed for future real-value/offchain settlement. RPC gas estimates include 20% gas-limit headroom; Monad charges the gas limit, not only gas used.

## Development

Node 22.9+, `npm ci`, ignored `.env` configured from `.env.example`, then `npm run dev` at http://127.0.0.1:4173 (or `PORT=4175 npm run dev`). Match `APP_ORIGIN` to the exact local origin. Missing server/contract configuration fails safely, never simulates deposits.

`npm run build` bundles assets, checks artifact reproducibility and runs unit/API/static-server tests. `npm run artifact` generates ABI, bytecode, runtime, settings and Solidity Standard JSON `input` in `artifacts/CountMeIn.json`. Solidity **0.8.30**, optimizer 200, Paris EVM and direct dependency versions are pinned. Use the lockfile with `npm ci`.

## Supabase Setup

Active project: **Hackathon_pj**, reference **ednddqfwazggfsdaklwp**. The backend rejects another project URL. After the user applied the guarded repair on October 5, live catalog checks confirmed the 003/004 function bodies match the release, including exact RPC argument names. `release_admin(text,jsonb)` and the request limiter allow only `service_role`; legacy mutation RPCs deny browser roles. All nine private tables retain RLS and denied browser grants, and the immutable-terms trigger is installed. The existing plan row remains present. Do not replay 001/002 or rerun the repair as a troubleshooting shortcut. Hosted two-account authentication and SMTP remain unverified.

1. Inspect installation in this project's SQL Editor:
   ```sql
   select to_regprocedure('public.create_chain_plan(text,text,text,text,integer,timestamptz,timestamptz,text,text,text)') as migration_002,
          to_regprocedure('public.release_admin(text,jsonb)') as migration_003;
   ```
2. **The inspected project has already applied `supabase/repairs/20261005_verified_release.sql`; all eight postflight checks passed.** The repair is generated with `npm run prepare:db-repair` from canonical migrations 003/004, validates 002 prerequisites, leaves existing rows unchanged, skips already installed release objects, stops on partial/incompatible installation, and reloads the Data API schema. A real PostgreSQL test applies it twice and verifies old rows and financial fields survive unchanged. New installations apply 001, 002, 003, 004 in order instead. Reconcile CLI history before `supabase db push` if SQL was applied manually.
3. Expose only the usual `public` Data API schema, never `countmein_private`. Set the project URL/publishable key and a **server-only** service-role key.
4. Authentication > Providers: enable Email/signup, keep `{{ .ConfirmationURL }}` in the email template and configure custom SMTP for friends outside the default mailer's restrictions.
5. Authentication > URL Configuration: Site URL `https://hackathonproj-beige.vercel.app`. Production and local root/invitation redirects were verified present. **Preview redirects are missing**: add `https://countmein-git-codex-monad-tes-d7e588-utkarshs-projects-c808d1c6.vercel.app/` and `https://countmein-git-codex-monad-tes-d7e588-utkarshs-projects-c808d1c6.vercel.app/plan/*`. Keep the production/local entries. Do not allow arbitrary preview hosts or change the Site URL merely for testing.

The implicit magic-link flow works without the initiating browser's PKCE verifier. The SDK persists sessions; the app removes callback fragments. Display names are private metadata, not authorization.

## Contract Deployment

**Public deployment independently verified by read-only RPC:** chain 10143, escrow `0x63e748D0b64DF798885348b0d036cA2E07A51059`, deployment block **68409889**, [successful deployment receipt](https://testnet.monadvision.com/tx/0xdba030ac46d56fa86a2e9c843a88daf74169305f7c919e8f83ed02b8b4f8cc10). Runtime exactly matches the pinned artifact; code is absent in the previous block and present in the creation block. The public manifest is `deployments/monad-testnet.json`. **No public deposit/payout/refund acceptance scenarios have been run.** Source verification is not yet confirmed. Never fund local fixture mnemonics publicly.

1. Obtain test MON for a dedicated testnet wallet from the [official faucet](https://faucet.monad.xyz). [Official testnet settings](https://docs.monad.xyz/developer-essentials/testnet): chain 10143, RPC `https://testnet-rpc.monad.xyz`, explorer `https://testnet.monadscan.com`.
2. Set `MONAD_DEPLOYER_PRIVATE_KEY` privately in a managed/local environment, run `npm run deploy:monad:testnet`, then unset it. Never paste a seed/private key into chat or add it to Vercel. A user-controlled wallet can alternatively deploy the exact artifact bytecode without constructor arguments.
3. The script saves `deployments/monad-testnet.json` immediately after submission, then verifies finality, canonical receipt and runtime. After interruption use `npm run deploy:monad:testnet -- --resume`; no signing key is required. Never delete a pending record and blindly deploy again. Its public manifest includes chain, address, transaction, block, compiler/settings, runtime hash and ABI.
4. Verify source on Monadscan with the artifact's `input` as Solidity Standard JSON: compiler `v0.8.30+commit.73712a01`, optimizer 200, Paris, no constructor arguments. Record the explorer verification result/URL. Source verification is not claimed without explorer confirmation.
5. Set the new public escrow address and deployment block in local/Vercel configuration. Old deployment bytecode is intentionally rejected.

## Vercel Setup

Root `.`, framework Other, Node 22.x+, build `npm run build`, output **`build`**, not `dist`. The config packages Node APIs, sets 60-second function limits, privacy headers and invitation rewrites.

PR #3 was already merged externally on October 5. New fixes remain on `codex/monad-testnet-release`; no further merge is performed automatically. Following the database repair, production and preview `/api/release` both return 200 and verify the deployed contract and database checkpoint. Anonymous draft submissions return 401; anonymous direct privileged/private RPC calls return 42501. The stable release preview reports its correct `APP_ORIGIN`. However, the production alias `https://hackathonproj-beige.vercel.app` currently reports `https://countmein-ejsveiagx-utkarshs-projects-c808d1c6.vercel.app` as its origin: correct the Production `APP_ORIGIN` and redeploy before testing writes on that alias. The Vercel output setting is `build`; use the configured stable branch alias for preview login and writes, not random deployment URLs.

Set these per Preview/Production environment and redeploy:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://ednddqfwazggfsdaklwp.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | This project's public client key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase credential |
| `APP_ORIGIN` | Exact HTTPS preview/production origin, no trailing slash/path |
| `MONAD_TESTNET_ESCROW_ADDRESS` | New verified deployment address |
| `MONAD_TESTNET_DEPLOYMENT_BLOCK` | Deployment receipt block number |
| `CRON_SECRET` | Random secret, at least 32 characters |
| `MONAD_TESTNET_RPC_URL` | Optional HTTPS RPC supporting finalized/history/logs |
| `MONAD_TESTNET_EXPLORER_URL` | Optional trusted HTTPS explorer; default Monadscan |

Public variables are bundled at build time; server secrets/signing keys are not. GET `/api/release` checks deployed runtime, actual creation block and database checkpoint; a 200 is **not** security or end-to-end acceptance. Readiness failures appear in the creation dialog and Retry checks configuration again. Unfinished details may be retained explicitly in this account's browser tab, never counted as a shared/onchain plan. Shared saving still requires verified wallet ownership. POST requires exact Origin and a verified session, except anonymous refresh of published invitations. Migration 004 provides atomic, durable per-account request limits (60/minute; anonymous refresh 30/minute per observed IP), in addition to challenge cooldown/replay protection. Platform edge limits are still needed against distributed abuse. Logs contain operation/error codes, not request bodies, credentials or private account details.

## Reconciliation And Recovery

No permanent background process is assumed on Vercel. GET `/api/reconcile` requires `Authorization: Bearer <CRON_SECRET>`, processes up to four 1000-block pages and returns `processed/checkpoint/finalized/lag_blocks`. Checkpoints advance only after verified records commit. Retries/restarts replay safely. Monitor growing lag and failures.

- The production **daily fallback** is registered/enabled in Vercel; successful execution remains unverified. This is not timely indexing, and preview cron jobs do not run. Preview currently requires Vercel Authentication; a normal anonymous invitation is blocked by that outer layer until an approved public release or sharing arrangement exists.
- `.github/workflows/reconcile.yml` polls every five minutes with retries. Configure repository variable `COUNTMEIN_APP_ORIGIN` and secret `COUNTMEIN_CRON_SECRET` matching Vercel. Scheduled workflows run from the **default branch only**, not merely a pushed feature branch. Until reviewed/merged, invoke the authenticated endpoint manually or configure an external scheduler. A suitable Vercel plan can schedule five-minute polling instead. GitHub scheduling is best-effort, not an SLA.
- `npm run reconcile -- --backfill` runs up to 100 batches with private server configuration for initial catch-up; repeat until lag is near zero.
- Invitation views refresh after mutations, on return and every 30 visible seconds. Direct chain reads protect preparation despite index lag. Dashboard/history are caches; open the invitation or backfill when a direct-chain transaction is missing. History is limited to the latest 200 private records; contribution/refund summaries use that window, not an all-time financial statement.
- A changed checkpoint halts indexing and invalidates cached receipts/publication. Back up and independently review chain/runtime/receipts. Only afterward set `CHAIN_REVIEW_REASON` (20-500 characters) and run `npm run reconcile -- --rebuild-reviewed --backfill`. This replays verified events without deleting data; absent canonical receipts stay invalidated. Missing/changed immutable creation references need incident investigation, never silent reassignment.
- Closing a prompt/browser does not cancel or confirm a transaction. **Check transaction** supports original/replacement hashes. Same wallet/nonce and verified original intent are required. If no RPC ever exposed the original before evicting it, automatic replacement attribution is unavailable: inspect wallet/explorer/nonce before resubmitting. Published escrow can recover through organizer-scoped metadata even after browser-storage or database failure.

**Direct contract rights when the frontend is unavailable:** use the recorded ABI/address on chain 10143 through a trusted wallet/explorer. Read `plans(id)`, `stateOf(id)`, `deposits(id,yourWallet)`. The depositing wallet calls `claimRefund(id,addressYouControl)` when Refunding; anyone can trigger `collect(id)` when Funded. Only the immutable recipient can call `collectTo(id,addressItControls)`. Contract wallets must invoke through their controller. Supabase/server availability never changes those rights.

## Verification

| Command | Verified Locally |
| --- | --- |
| `npm run build` / `npm test` | Original model, API authentication/origin/privacy, SIWE domain/nonce/expiry/replay, artifact and invite/missing-asset routes |
| `npm run test:db` | Real isolated PostgreSQL, actual migrations; auth roles emulated. Grants/RLS, ownership/privacy, concurrent capacity regressions, immutable drafts, wallet linking, receipt idempotency, replacement recovery, backfill and halt/rebuild |
| `npm run test:escrow` | Existing local Solidity financial-rule checks |
| `npm run test:chain` | Actual local EVM, wrong amounts/chain/runtime, metadata tampering, nonfinal/noncanonical receipts and simultaneous final-slot transactions |
| `npm run test:security` | Actual local EVM, rejected/reentrant transfers, preserved claims, recipient-only redirection, double withdrawal, plan isolation, exact deadline and organizer-scoped commitment uniqueness |
| `npm run test:browser` | Playwright with real local PostgreSQL/EVM; Auth HTTP and injected wallet transport mocked. Publish/outage recovery, two-account deposits/payout, cancel/refund, pending reload, wallet/network changes, rejected prompts and reverts |

Install Chromium with `npx playwright install chromium`, or `PLAYWRIGHT_CHANNEL=chrome npm run test:browser`. Screenshots are ignored under `test-results/`. CI runs all suites. Historical demo browser tests remain preserved but are superseded because their routes no longer exist.

**Hosted progress:** one user signed in, verified wallet ownership and saved a draft; the signed-in preview and persistent draft terms/commitment were inspected independently. Publication was cancelled after wallet security alerts; this is not payment acceptance. **Still not verified:** public Monad funded/collected and cancelled/expired/refunded scenarios; hosted two-email login, SMTP and session restoration; actual wallet extension/replacement behavior; successful scheduled reconciliation; source verification; five-friend trial. Local EVM transfers are actual local transactions, **not public testnet acceptance evidence**. Production origin settings and user-controlled wallet/email actions remain prerequisites, along with investigation of the preview domain's malicious classification.

Production dependency audit reports no known advisories. Dev-only Ganache dependencies have advisories and a native-module warning on newer Node; the tested JS fallback is not shipped to the app. Local tests are not a security audit.

### Wallet Warning Investigation (October 5)

Publication is paused after MetaMask displayed **Malicious site**, **High site fee**, and **Limited address signals**. The domain classification's cause remains unknown: code matching and dependency checks do not establish that it is a false positive. Do not acknowledge/override that warning, disable alerts, or change domains to evade it. Use [MetaMask's official manual-review process](https://support.metamask.io/configure/wallet/security-alerts), selecting Continue without wallet, and provide the exact flagged origin, chain 10143, warning screenshots, repository and escrow explorer links. Review any report payload before submitting; never include keys, seed phrases, session tokens or wallet state logs. No support report has been submitted by the agent.

Read-only evidence: release preview deployment `dpl_FzCmfk3VVFXSJPu9orGraxfh352U` was READY from `b7f07f3d74b1c047f2da2933e4d6fb241d2d184b`, with its expected branch, build command/output and APP_ORIGIN. The served application bundle exactly matched the local reproducible build (SHA-256 `8e389b5964becfafd09cb6860069ba74e93c5a396495568c27e4e02c7530bc0f`), targeting Hackathon_pj and the recorded escrow. Vercel also injects its own feedback-toolbar script; the application bundle comparison does not audit that provider script or browser extensions. Pinned production dependencies have zero known npm advisories, not a complete supply-chain/security audit.

Public RPC independently confirmed chain 10143, successful deployment at block 68409889, exact creation bytecode and runtime, and canonical deployment block. The saved hosted draft's financial terms and commitment match the encoded `createPlan(address,uint96,uint16,uint64,uint64,bytes32)` payload, which simulated successfully via `eth_call`. Publication sends **zero MON value**; its 0.01 MON contribution is a term, not a deposit. The draft remains unpublished with no stored creation hash. The cancelled MetaMask payload itself was not captured: screenshots alone cannot prove its full destination, calldata or exact gas fields. Explorer source verification and public funding/refund scenarios remain unconfirmed.

Old preparation supplied a 20% gas-limit buffer and ethers' generic `2 * baseFee + priorityFee` cap. The earlier UI maximum 0.048922998 MON corresponds to 242193 gas at 202 gwei. At 102 gwei the same limit costs 0.024703686 MON, close to the wallet's rounded 0.0246; this is a reconstruction, not an exact reconciliation without the wallet fields. Fresh RPC at 15:42 UTC returned 202832 estimated gas, 100 gwei base fee and 102 gwei gas price, giving 0.024826596 MON with the old limit. Storage-heavy publication can cost more than one small contribution; there is no platform fee in this method.

The frontend now leaves gas price/priority/max fee to the wallet and uses an integer-rounded 7.5% gas-limit starting margin from [Monad's wallet guidance](https://docs.monad.xyz/developer-essentials/wallet-developers). The fresh example becomes 218045 gas / 0.02224059 MON at that RPC price. This is an estimate, not a maximum or promise that MetaMask's warning clears. [Monad bills the full gas limit](https://docs.monad.xyz/developer-essentials/gas-pricing); never fall back to a large limit after simulation fails. Review displays destination, value, gas calculation, commitment and calldata; only the separate approval button requests a transaction. Keep publication paused until the malicious-domain classification is investigated and the actual wallet payload can be compared without overriding security alerts.

## Mainnet Blockers

Future real-value flow: sign in, access wallet, obtain supported Monad asset, publish immutable terms, authorize escrow deposits, verify chain receipts, collect full funding or exercise depositor-controlled refunds. Monitoring/support cannot override ownership. Crypto-to-bank conversion requires a separate off-ramp, not included automatically.

Before mainnet: final cancellation/dispute policy; independent contract security review and findings resolved; recipient recovery/operability review; payment-asset/token-specific review if adopting a stablecoin; reliable RPC/indexing/monitoring/recovery procedures; secure deployment/key handling; real-wallet/hosted-auth/support and incident testing; applicable business/legal review; explicit mainnet deployment and operating-cost approval. Real-value activity remains disabled.
