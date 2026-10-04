# CountMeIn

Conditional group funding for friends organizing sports and outings.

## Current build

- Responsive, browser-local practice app in `dist/`.
- Create a plan, join once, fill the target, collect demo funds, cancel, and claim a refund.
- Copy a text invitation; this is not a shared or live payment link.
- Every balance is explicitly a demo credit. No authentication, wallet connection, RPC integration, payment gateway, or real shared records are implemented in this UI.
- Solidity escrow source and a local-chain integration test are included. The frontend is not connected to the contract. No contract has been deployed to Monad.

## Running

Serve `dist/` with any static HTTP server. Do not open `index.html` as a file URL because it uses ES modules.

`npm test` checks the practice model. `npm run check` checks JavaScript syntax.

For contract checks: install `solc@0.8.30 ethers@6.15.0 ganache@7.9.2` locally, then run `node tests/escrow.cjs`. Compilation outputs `artifacts/CountMeIn.json`. Tests deploy only to an ephemeral local EVM.

## Contract behavior

`createPlan(recipient, price, target, deadline, eventAt, detailsHash)` stores immutable funding terms. Participant slots are wallet addresses, not identities. The organizer is not automatically a participant.

Each address can join once with exactly `price` native tokens before the deadline. Filling the exact target makes a plan funded permanently. Any caller may then trigger `collect`, which pays only the immutable recipient. This avoids relying on an organizer transaction to deliver funds. The demo UI exposes collection only to the organizer for simplicity.

An organizer may cancel only while the plan is open. A missed target at the deadline makes it refundable. Each depositor calls `claimRefund(id, to)` to recover their own deposit. Claims are pull-based; no background process sends refunds automatically. Gas is not refunded. State updates precede external transfers and a global reentrancy guard protects joins, payouts, and refunds.

This prototype uses native test tokens, not fiat or stablecoins. It does not verify attendance, humans, venue availability, venue delivery, or booking. Collection is a transfer to a named recipient, not a booking guarantee. If a recipient contract rejects payment, collection reverts and funds remain in escrow; recipient design and recovery policy need review before any production use. The contract has no fees, upgrade authority, admin sweep, or yield.

## Next implementation phase

1. Verify current Monad testnet configuration from official documentation.
2. Deploy the compiled escrow from a user-controlled funded testnet account. Never put a private key in frontend code.
3. Connect real wallet transactions and use contract reads/events as the source of truth. Keep the practice mode separate.
4. Store plan metadata behind stable invitation URLs, bound to the onchain details hash; support multiple browsers.
5. Add embedded sign-in and sponsored transactions after selecting a provider and configuring credentials.
6. Test with five friends: create a turf plan, join from different devices, and demonstrate a real testnet refund.
7. Conduct security review and resolve cancellation/dispute/recipient recovery policies before handling real value.

A card/UPI gateway is a separate payment path and has not been integrated. Five-user testing, contract deployment, a public repository, and videos remain required for a hackathon submission.

## Deploy to Vercel

Import `JustXutkarsh/Hackathon_proj` into Vercel and deploy the `main` branch.

- Root directory: repository root (`.`).
- Framework preset: Other.
- Build command: `npm run build` (checks syntax and runs the six app-rule tests).
- Output directory: `dist` (committed static app files).
- Environment variables: none required for this practice version.

The root `vercel.json` supplies the framework, build, and output settings. Only `dist/` is served; contracts, tests, and development documentation stay outside the public app. Vercel hosting does not deploy the escrow to Monad or enable shared data. Visitors still use independent browser-local practice balances.

Vercel configuration reference: https://vercel.com/docs/project-configuration/vercel-json
