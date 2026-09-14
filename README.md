# DiversiFi Integration Guide

This guide covers three integration paths for third-party platforms:

- **On-chain pricing** (Sections 1–8): Read real-time NAV and dToken prices directly from the Solana blockchain — no API key required.
- **Deposits & withdrawals** (Sections 9–14): Execute deposits and withdrawals on behalf of a single authenticated wallet via the DiversiFi API.
- **Platform integration** (Sections 15–19): Manage deposits, withdrawals, and refunds for multiple end users from a single API key — designed for platforms that want to embed DiversiFi without exposing credentials to users.

---

## On-Chain Pricing Overview

A dToken (e.g., dBLUE) represents a programmable, self-custodial basket of underlying assets on Solana. There are two ways to obtain the real-time NAV / price of a dToken:

**A. Read NAV directly from a Switchboard on-chain oracle account (Section 8).** Once a basket has a published NAV feed, this is a single `getAccountInfo` call with no constituent math. No basket has a published feed at the moment (Section 8.2), so use B for now.

**B. Calculate NAV yourself from on-chain state (Sections 1–7).** Lower-level path: derive vault accounts, fetch balances, multiply by your own price source, divide by supply. Use this if you need per-constituent breakdowns, if a basket doesn't yet have a published oracle feed, or if you want full control over the pricing source.

The manual-calculation flow (Sections 1–7) is laid out first because it's universally applicable to every dToken; the oracle-account flow (Section 8) is presented after it as the quick path for baskets with a published feed.

To calculate NAV manually, integrator platforms need to:
1. Identify if a single token is a DiversiFi dToken (via PDA derivation).
2. Or, retrieve a list of all active dTokens directly from the network.
3. Parse the active basket constituents (mints).
4. Derive the underlying Vault Token Accounts (ATAs).
5. Fetch balance snapshots for all underlying vault token accounts.
6. Calculate NAV and price using the balances, live constituent prices, and the dToken's total supply.

---

## 1. How to Determine if a Token is a dToken (Deriving the Index PDA)

Currently, all DiversiFi indexes are managed by the DiversiFi smart contract. You can verify if a token is a dToken by checking if an **Index Account PDA** exists for that token mint under the DiversiFi Program ID.

**DiversiFi Program ID:** `3vyr9DRfMZb2KvUQdnps7YG3PY38XdguLBQaJ2DFkSxk`

Before checking if the token is valid, you must derive its corresponding Index Address. The Index Account is a Program Derived Address (PDA) deterministically calculated using the constant string `"index"` and the dToken's mint address.

**Seeds:**
- `Buffer.from("index")`
- `dTokenMint.toBuffer()`

```typescript
const [indexPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("index"), dTokenMint.toBuffer()],
    new PublicKey("3vyr9DRfMZb2KvUQdnps7YG3PY38XdguLBQaJ2DFkSxk")
);
```

Once derived, checking validity is a matter of verifying that the account exists. If the `Connection.getAccountInfo(indexPda)` JSON-RPC call returns non-null data, the token is a valid DiversiFi dToken.

---

## 2. Getting a List of All Active dTokens on the Network

If you don't have a specific token to check, and instead want to pull a fresh list of **all currently deployed dTokens** from on-chain, you can query the Solana RPC. 

Because the `token_mint` address (the dToken mint) is consistently located at byte offset 33 of the Index struct layout, you can use the `dataSlice` RPC parameter to fetch *only* the 32-byte dToken mint addresses from every Index account on the network. This makes the query extremely fast and avoids downloading heavy account data when it's not needed.

```typescript
const DIVERSIFI_PROGRAM_ID = new PublicKey("3vyr9DRfMZb2KvUQdnps7YG3PY38XdguLBQaJ2DFkSxk");
const INDEX_ACCOUNT_SIZE = 246;

const accounts = await connection.getProgramAccounts(DIVERSIFI_PROGRAM_ID, {
    dataSlice: {
        offset: 33, // Start pulling exactly at the tokenMint pubkey
        length: 32  // Only pull the 32 byte pubkey and nothing else
    },
    filters: [
        { dataSize: INDEX_ACCOUNT_SIZE } // Ensure it is an Index Account
    ]
});

// Convert the raw 32 bytes directly into an array of base-58 strings
const dTokenMints = accounts.map(acc => {
    return new PublicKey(acc.account.data).toBase58();
});

console.log(`Found ${dTokenMints.length} valid dTokens.`);
```

---

## 3. Parsing the Account/Data Structure for the Basket

The Index Account uses a **1-byte custom discriminator** (`[1]`) rather than the standard Anchor 8-byte discriminator. This is why the `dataSlice` offset in Section 2 is 33 (1 + 32), not 40.
The Account struct layout is:

```rust
pub struct Index {
    pub manager: Pubkey,
    pub token_mint: Pubkey,
    pub minimum_deposit: u64,
    pub fee: u16,
    pub bump: [u8; 1],
    pub mints: [OracleMint; 5], // A fixed array of 5 possible constituent tokens
}

pub struct OracleMint {
    pub mint: Pubkey,
    pub target: u16, // Weighting in basis points
}
```

Since the `mints` array is fixed at `5`, you must filter out any empty slots by checking if the mint address equals `PublicKey.default` (`11111111111111111111111111111111`).

### Fetching using raw Borsh
Since the protocol IDL is subject to change, the recommended approach is to decode the account directly using `@coral-xyz/borsh`:

```typescript
import * as borsh from "@coral-xyz/borsh";

const INDEX_ACCOUNT_LAYOUT = borsh.struct([
    borsh.u8("discriminator"),
    borsh.publicKey("manager"),
    borsh.publicKey("tokenMint"),
    borsh.u64("minimumDeposit"),
    borsh.u16("fee"),
    borsh.array(borsh.u8(), 1, "bump"),
    borsh.array(
        borsh.struct([borsh.publicKey("mint"), borsh.u16("target")]),
        5,
        "mints"
    )
]);

const indexAccountInfo = await connection.getAccountInfo(indexPda);
const decodedIndex = INDEX_ACCOUNT_LAYOUT.decode(indexAccountInfo.data);

// Filter out empty slots
const activeMints = decodedIndex.mints.filter(
    (m: any) => !m.mint.equals(PublicKey.default)
);
```

---

## 4. Getting the List of Tokens in the Basket and Deriving PDAs

The underlying tokens composing the basket are stored in Associated Token Accounts (ATAs) owned by the `Index` PDA. Note that some underlying tokens might be standard `Token` program tokens, while others might use the `Token2022` program.

To get the vault addresses, derive the ATA for each valid `mint` from the `activeMints` array, with the `indexPda` acting as the wallet owner.

```typescript
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

// For each constituent mint from the activeMints array (Section 3):
for (const oracleMint of activeMints) {
    const mintInfo = await connection.getAccountInfo(oracleMint.mint);
    const isToken2022 = mintInfo!.owner.equals(TOKEN_2022_PROGRAM_ID);
    const tokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

    const vaultPubkey = getAssociatedTokenAddressSync(
        oracleMint.mint, // The underlying token mint
        indexPda,        // The Index PDA acts as the owner
        true,            // allowOwnerOffCurve = true (since owner is a PDA)
        tokenProgramId
    );
}
```

---

## 5. Fetching Balances using On-Chain Simulation

While you *can* fetch multiple ATAs separately using `getMultipleAccountsInfo`, DiversiFi provides an atomic on-chain instruction (`get_vault_balances`) that returns all vault balances synchronously in one lightweight call. This avoids inconsistencies caused by RPC slot lag.

**Note:** This instruction is read-only and is intended to be executed via `simulateTransaction`.

### The `get_vault_balances` Instruction
**Discriminator:** `[138, 38, 110, 31, 116, 102, 223, 172]`

**Accounts Required:**
1. `index` (The Index PDA - read-only)
2. `token_mint` (The dToken Mint - read-only)
3. `remainingAccounts` (The list of vault ATAs derived in Step 4 - read-only)

**Borsh Return Schema:**
```typescript
const vaultBalancesSchema = borsh.struct([
    borsh.vec(borsh.u64(), "tokenBalances"),
    borsh.vec(borsh.publicKey(), "mints"),
    borsh.u64("indexSupply"),
    borsh.i64("timestamp"),
    borsh.u64("slot"),
]);
```

By simulating the transaction, the program will return the decoded state atomically via the transaction return data.

See `price_derivation.ts`, function `fetchVaultBalancesWithInstruction()`, for a complete working implementation.

---

## 6. Calculating the NAV and Price

Once you have the vault token balances, their decimals, and the dToken index supply, calculating the NAV requires fetching live oracle prices (e.g., from Pyth or Switchboard) for each constituent.

**Step A. Total USD Value of the Basket (NAV)**
```text
Total Vault NAV = Sum( (Vault Balance / 10^Token Decimals) * Live Oracle Price of Token )
```

**Step B. Real-Time dToken Price**
```text
dToken True Price = Total Vault NAV / ( dToken Supply / 10^dToken Decimals )
```

---

## 7. Example TypeScript Implementation

See the provided `price_derivation.ts` script in this repository for a complete end-to-end working example using the `@solana/web3.js` and `@coral-xyz/anchor` libraries.

---

## 8. Reading NAV from a Switchboard On-Chain Oracle Account

> **No basket currently has a published NAV feed.** The four feeds this section used to list (dBONK, dYIELD, dBIG4 and dBOOMER) were retired and have not been refreshed for months, so their accounts hold stale values. Do not read them. DiversiFi is moving to one feed per basket whose address stays the same when the basket's composition changes, and will list each feed in Section 8.2 once it is live. Until then, compute NAV from on-chain state (Sections 1-7).

A canonical OracleQuote account keeps its last value until someone refreshes it. Whatever feed you read, check how old the value is before you use it (Section 8.3).

For a basket with a published feed, the read is one `getAccountInfo` call on a single account: no constituent math, no off-chain price source and no SDK. If you need a value produced for your own transaction, see Section 8.4.

### 8.1 Mechanics

The on-chain account is a "canonical OracleQuote". Its address is deterministic from `(queue_pubkey, feed_id)`, so once you know a basket's `feed_id` you can derive the account address client-side.

Account data layout:

```
[8 bytes "SBOracle"][32 bytes queue][u16 LE quote length][quote bytes][zero padding]

quote bytes, per feed:  [32 bytes feedHash][16 bytes value, LE u128][1 byte minSamples]
quote bytes end with:   [8 bytes recent_slot, LE u64][1 byte version][4 bytes "SBOD"]
```

`value` is fixed-point with 18 decimal places: divide by `1e18` for USD per dToken. `recent_slot` is the slot at which the oracle produced the quote. Compare it with the current slot before you trust `value`.

### 8.2 Constants and published feeds

| Item | Value |
|---|---|
| Switchboard On-Demand mainnet program | exposed as `ON_DEMAND_MAINNET_PID` from `@switchboard-xyz/on-demand` |
| Mainnet queue | `A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w` |
| Switchboard quote program | `orac1eFjzWL5R3RbbdMV68K9H6TaCVVcL6LjvQQWAbz` |

Published NAV feeds: **none at the moment.** Each basket's `feedId`, canonical quote account and refresh cadence will be listed here as its feed goes live.

> **The program's `["oracle", index]` account is not a NAV feed.** It holds the constituent prices DiversiFi's backend writes before deposits and withdrawals. The program stores those quotes without checking their signers against the Switchboard oracle set, so DiversiFi's admin key is their only guarantee. Do not use that account as a price source, and do not treat it as an oracle-verified quote.

### 8.3 Read pattern with a staleness check (TypeScript, no Switchboard SDK required)

```typescript
import { Connection, PublicKey } from "@solana/web3.js";

const QUEUE = new PublicKey("A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w");
const QUOTE_PROGRAM_ID = new PublicKey("orac1eFjzWL5R3RbbdMV68K9H6TaCVVcL6LjvQQWAbz");
const FEED_ID = "0x..."; // from Section 8.2
const MAX_AGE_SLOTS = 4_500n; // about 30 minutes

// Derive the canonical quote account address.
// Seeds: queue.toBytes() ++ feedHash bytes (32 bytes per feedId).
const feedHashBytes = Buffer.from(FEED_ID.replace(/^0x/, ""), "hex");
const [quoteAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from(QUEUE.toBytes()), feedHashBytes],
    QUOTE_PROGRAM_ID
);

// Read the account together with the slot it was observed at.
const { context, value: account } = await connection.getAccountInfoAndContext(quoteAccount, "confirmed");
if (!account?.data) {
    throw new Error("Quote account not bootstrapped: this basket has no published feed");
}
const data = account.data;

// 1. Reject a stale quote before reading its value (offsets from the layout in Section 8.1).
const quoteEnd = 42 + data.readUInt16LE(40);
if (data.subarray(quoteEnd - 4, quoteEnd).toString() !== "SBOD") {
    throw new Error("Malformed quote account");
}
const recentSlot = data.readBigUInt64LE(quoteEnd - 13);
const ageSlots = BigInt(context.slot) - recentSlot;
if (ageSlots > MAX_AGE_SLOTS) {
    throw new Error(`NAV quote is ${ageSlots} slots old; refusing to use it`);
}

// 2. The value follows the feedHash.
const idx = data.indexOf(feedHashBytes);
if (idx === -1 || idx + 48 > quoteEnd) throw new Error("feedId not found in account data");

let value = 0n;
for (let j = 0; j < 16; j++) {
    value |= BigInt(data[idx + 32 + j]) << (BigInt(j) * 8n);
}
const navUsd = Number(value) / 1e18;
```

Pick `MAX_AGE_SLOTS` for your use case. A slot is roughly 400 ms, so 150 slots is about one minute and 4,500 slots about thirty minutes. For anything that moves money, prefer the atomic crank in Section 8.4.

The same pattern works in Rust, Python, or any client that can fetch a Solana account. The Switchboard SDK exposes the address derivation as `OracleQuote.getCanonicalPubkey(queue, [feedId])` if you prefer to add the dependency.

### 8.4 Atomic-crank pattern (for trade execution)

A passive read returns whatever value the account last held, and nothing guarantees how recently that was. If you need a value produced for this moment, such as quoting a swap, routing through a dToken or valuing collateral, add a crank to your own transaction. The quote account is updated atomically with the rest of your transaction:

```typescript
import { CrossbarClient } from "@switchboard-xyz/common";
import { Queue, AnchorUtils, ON_DEMAND_MAINNET_PID } from "@switchboard-xyz/on-demand";

const program = await AnchorUtils.loadProgramFromConnection(
    connection,
    undefined as any,
    ON_DEMAND_MAINNET_PID
);
const queue = await Queue.loadDefault(program);
const crossbar = new CrossbarClient("https://crossbar.switchboard.xyz");

// Two instructions: Ed25519 verification + canonical-account update.
const updateIxs = await queue.fetchManagedUpdateIxs(
    crossbar,
    [FEED_ID],
    { payer: payerPubkey }
);

// Prepend to your own tx.
const tx = new Transaction()
    .add(...updateIxs)
    .add(yourOwnInstruction);
```

After this transaction confirms, the quote account holds the value the oracle just signed, and your instruction consumed exactly that value.

Cost and footprint per atomic crank:

| Metric | Value | Notes |
|---|---|---|
| Tx fee added | 10,000 lamports | Standard 5,000-lamport base x 2 (signature + Ed25519 precompile) |
| Compute units added | ~628 | Ed25519 runs as a native precompile and doesn't count |
| Tx bytes added | ~330 | Ed25519 ix data + quote-program ix data |
| Latency added | ~2-5 s | Switchboard gateway round trip during `fetchManagedUpdateIxs` |

The CU footprint is negligible. Transaction bytes can matter if you're already near the 1,232-byte limit; use a v0 transaction with lookup tables in that case.

### 8.5 Freshness

| Mode | What you get |
|---|---|
| Passive read (Section 8.3) | A value as old as its `recent_slot`. Enforce your own limit on every read. |
| Atomic crank (Section 8.4) | A value the oracle produced for your transaction |

### 8.6 When to use which

| Your use case | Recommendation |
|---|---|
| Dashboards, indexers, analytics | Section 8.3: passive read with a staleness limit that suits the display |
| AMM, orderbook, routing, collateral or arbitrage where stale NAV is exploitable | Section 8.4: atomic crank in your transaction |
| Per-constituent breakdowns, or no published feed for the basket | Sections 1-7: compute NAV from on-chain state |

### 8.7 Error handling

* **Account missing** (`value === null`): the canonical account has not been bootstrapped. The basket has no published feed yet; compute NAV from on-chain state (Sections 1-7).
* **Quote older than your limit**: do not use the value. Crank it (Section 8.4) or compute NAV from on-chain state.
* **feedId not found in the account data**: the `feedId` does not match the account. Check it against Section 8.2.
* **`fetchManagedUpdateIxs` throws**: the Switchboard gateway is transiently unavailable, the feed is misconfigured, or the oracles cannot execute the job. Retry once. If it persists, compute NAV from on-chain state and contact DiversiFi.

### 8.8 Example TypeScript implementation

See `oracle_nav_read.ts` in this repository for a runnable example of both the passive read (Section 8.3) and the atomic crank (Section 8.4). It rejects stale quotes by default:

```bash
FEED_ID=0x... npx tsx oracle_nav_read.ts
npx tsx oracle_nav_read.test.ts   # staleness guard tests
```

The passive read works with the base dependencies of this repo. The atomic-crank demo additionally requires the Switchboard SDK packages. Install them only if you need that path:

```bash
pnpm add @switchboard-xyz/on-demand @switchboard-xyz/common
```

---

## 9. Authentication

All deposit and withdrawal operations go through the DiversiFi API. You will need an API key to interact with these endpoints.

Contact the DiversiFi team to obtain an API key. Keys are prefixed with `dfi_` and must be sent as a Bearer token on every request:

```
Authorization: Bearer dfi_your_api_key_here
```

**Rate limit:** 120 requests per minute per API key.

**Required permission scope:** `position_management` (for deposits, withdrawals, and refunds). Read-only endpoints require only `read_only`.

---

## 10. Deposit Flow

Depositing USDC into a basket is a two-step process:

1. **Get an unsigned transaction** from the API — the server builds and returns a base64-encoded Solana transaction.
2. **Sign and submit it** with the user's wallet, then **confirm** it with the API.

### Step 1 — Get the unsigned deposit transaction

```
GET /v1/positions/open/tx
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `basket_address` | string | Yes | The basket address / Index PDA (base58) |
| `amount` | number | Yes | USDC amount to deposit (human-readable, e.g. `100.5`) |

**Response:**
```json
{
  "success": true,
  "data": {
    "unsignedTxs": ["<base64-encoded transaction>"]
  }
}
```

`unsignedTxs` is an array. Sign and submit each transaction in order.

**Error responses:**

| `message` | Cause |
|-----------|-------|
| `"Basket not found"` | Invalid `basket_address` |
| `"Minimum deposit for <BasketName> is X USDC."` | Amount below the per-basket minimum |
| `"Basket operations are currently paused"` | Basket temporarily disabled |

### Step 2 — Sign, submit, and confirm

After signing and submitting the transaction to the Solana network, pass the resulting signature back to the API:

```
GET /v1/positions/open/confirm
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `basket_address` | string | Yes | Same basket address used in step 1 |
| `signature` | string | Yes | The Solana transaction signature |

**Response:**
```json
{
  "success": true,
  "message": "Transaction executed.",
  "data": { "executedAt": "2025-03-24T12:34:56.789Z" }
}
```

Once confirmed, the DiversiFi backend automatically executes the Jupiter swaps and mints LP tokens to the user's wallet.

---

## 11. Withdrawal Flow

Withdrawing converts LP tokens back to USDC. Same two-step pattern as deposits.

### Step 1 — Get the unsigned withdrawal transaction

```
GET /v1/positions/close/tx
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `basket_address` | string | Yes | The basket address / Index PDA (base58) |
| `amount` | number | Yes | LP token amount to withdraw (human-readable) |

**Response:** Same shape as the deposit response — `unsignedTxs` array.

### Step 2 — Sign, submit, and confirm

```
GET /v1/positions/close/confirm
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `basket_address` | string | Yes | |
| `signature` | string | Yes | The Solana transaction signature |

After confirmation, the backend swaps each constituent token back to USDC. Fees are deducted at this stage. USDC lands in the user's wallet automatically.

---

## 12. Cancelling Pending Operations

If a deposit or withdrawal is stuck, users can cancel and reclaim their locked tokens.

### Check refund eligibility

```
GET /v1/positions/refund/check
```

| Parameter | Type | Required |
|-----------|------|----------|
| `basket_address` | string | Yes |

**Response:**
```json
{
  "success": true,
  "data": {
    "canRefund": true,
    "refundType": "deposit",
    "deposit": { "hasPending": true, "hasBalance": true, "balance": 100.5, "canRefund": true },
    "withdrawal": { "hasPending": false, "hasBalance": false, "balance": 0, "canRefund": false }
  }
}
```

`refundType` is `"deposit"`, `"withdrawal"`, or `null`.

> **Note:** `refund/check` returns `"withdrawal"` (with -al) but `refund/tx` accepts `"withdraw"` (without). Normalize before passing: `refundType === "withdrawal" ? "withdraw" : refundType`.

### Get the unsigned refund transaction

```
GET /v1/positions/refund/tx
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `basket_address` | string | Yes | |
| `refund_type` | string | Yes | `"deposit"` or `"withdraw"` |

**Response:**
```json
{
  "success": true,
  "data": {
    "unsignedTx": "<base64-encoded transaction>",
    "transactionType": "deposit"
  }
}
```

### Sign, submit, and confirm the refund

```
GET /v1/positions/refund/confirm
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `basket_address` | string | Yes | |
| `refund_signature` | string | Yes | The refund transaction signature |

Only the unprocessed portion of a deposit/withdrawal is refunded. If the backend partially executed swaps before the cancel, those cannot be reversed.

---

## 13. Reading Positions and History

These endpoints require only `read_only` permission.

### User positions

```
GET /v1/positions/
```

Returns all open and closed positions for the authenticated wallet, including current value, ROI, PnL, and refund eligibility.

### Portfolio summary

```
GET /v1/portfolio
```

Returns an aggregate summary across all positions: total invested, total current value, total ROI.

### Transaction history

```
GET /v1/positions/transactions
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `basket_id` | string | No | Filter by basket |
| `limit` | number | No | Max results (default 50, max 200) |

Each transaction includes its type (`Deposit`, `Withdrawal`, `Refund`), status (`completed`, `processing`, `partially_completed`, `failed`, `refunded`, `pending`), amounts, timestamps, and the individual swap signatures.

---

## 14. Example TypeScript Implementation

See `deposit_withdraw_example.ts` for a complete working example of the deposit and withdrawal flows using the API.

---

## 15. Platform Integration Overview

The platform integration API (`/v1/integrations/`) is designed for third-party platforms that want to embed DiversiFi deposits and withdrawals for their own end users without requiring each user to authenticate directly with DiversiFi.

**Key difference from Sections 9–14:** The standard `/v1/positions/` endpoints act on behalf of the authenticated wallet. The `/v1/integrations/` endpoints let your platform specify any `user_wallet` address, so a single API key can serve many users.

### How it works

1. Your platform holds one API key with the `integrations` permission.
2. When a user wants to deposit or withdraw, your backend calls the relevant `/v1/integrations/` endpoint, passing the user's wallet address as `user_wallet`. The response includes an unsigned transaction and a `confirmToken`.
3. Your frontend presents the transaction to the user for signing (e.g., via their wallet adapter — Phantom, Backpack, etc.).
4. The user signs and submits the transaction to the Solana network.
5. Your backend calls `POST /v1/integrations/confirm` with the transaction signature and the `confirmToken` — this links the on-chain transaction to your API key and returns the `transactionGroupId`.
6. Your platform polls the transaction status using the `transactionGroupId` returned by the confirm call.

### Authentication

API key with `integrations` permission, sent as a Bearer token:

```
Authorization: Bearer dfi_your_api_key_here
```

**Rate limit:** 60 requests per minute (independent of the standard 120 req/min limit).

> Contact the DiversiFi team to request an API key with `integrations` permission.

---

## 16. Platform Deposit Flow

### Get the unsigned deposit transaction

```
GET /v1/integrations/deposit/tx
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `basket_address` | string | Yes | The basket address / Index PDA (base58) |
| `amount` | number | Yes | USDC amount to deposit (human-readable, e.g. `100.5`) |
| `user_wallet` | string | Yes | The end user's Solana wallet address (base58) |

**Response:**
```json
{
  "success": true,
  "data": {
    "unsignedTxs": ["<base64-encoded transaction>"],
    "confirmToken": "<one-time token, valid 30 minutes>"
  }
}
```

Store the `confirmToken` — you will need it in the next step.

**Error responses:**

| `message` | Cause |
|-----------|-------|
| `"Invalid basket_address"` | Malformed address |
| `"Invalid user_wallet"` | Malformed address |
| `"Basket not found"` | Unknown or inactive basket |
| `"Basket operations are currently paused"` | Basket temporarily disabled |
| `"Minimum deposit for this basket is X USDC"` | Amount below the per-basket minimum |

### Sign and submit

Decode the base64 transaction, present it to the user for signing via their wallet, then submit it to the Solana network:

```typescript
const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTxs[0], 'base64'));
tx.sign([userKeypair]); // or wallet adapter
const signature = await connection.sendRawTransaction(tx.serialize());
await connection.confirmTransaction(signature, 'confirmed');
```

### Confirm

After the transaction is on-chain, call:

```
POST /v1/integrations/confirm
Content-Type: application/json

{
  "signature": "<base58 transaction signature>",
  "confirmToken": "<token from the deposit/tx response>"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "transactionGroupId": "a3f8c2d1e5b4f097"
  }
}
```

The `transactionGroupId` is a 16-character hex ID you use to poll status (Section 19). It is also deterministic — computed as `sha256(signature).slice(0, 16)` — so you can derive it locally, but the confirm response is the canonical source.

> **Why is the confirm step required?** It links the on-chain transaction to your API key so that only your key can retrieve it via `/transaction/:id`. Without it, the transaction processes normally but will not be visible through the integrations API.

---

## 17. Platform Withdrawal Flow

### Get the unsigned withdrawal transaction

```
GET /v1/integrations/withdraw/tx
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `basket_address` | string | Yes | The basket address / Index PDA (base58) |
| `amount` | number | Yes | LP token amount to withdraw (human-readable) |
| `user_wallet` | string | Yes | The end user's Solana wallet address (base58) |

**Response:** Same shape as the deposit response — `unsignedTxs` array and a `confirmToken`.

The user signs and submits the transaction. Then call `POST /v1/integrations/confirm` with the signature and `confirmToken`, exactly as in Section 16. The confirm response returns the `transactionGroupId` for polling.

---

## 18. Platform Refund Flow

If a deposit or withdrawal is stuck — for example, if a swap failed and tokens are locked in the user's on-chain escrow account — the platform can initiate a refund on behalf of the user.

### Check refund eligibility

```
GET /v1/integrations/refund/check
```

| Parameter | Type | Required |
|-----------|------|----------|
| `basket_address` | string | Yes |
| `user_wallet` | string | Yes |

**Response:**
```json
{
  "success": true,
  "data": {
    "canRefund": true,
    "refundType": "deposit",
    "deposit": {
      "hasBalance": true,
      "balance": 100.5,
      "canRefund": true
    },
    "withdrawal": {
      "hasBalance": false,
      "balance": 0,
      "canRefund": false
    }
  }
}
```

`refundType` is `"deposit"`, `"withdraw"`, or `null`. Use this value directly as the `refund_type` parameter in the next call.

### Get the unsigned refund transaction

```
GET /v1/integrations/refund/tx
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `basket_address` | string | Yes | |
| `user_wallet` | string | Yes | |
| `refund_type` | string | Yes | `"deposit"` or `"withdraw"` |

**Response:**
```json
{
  "success": true,
  "data": {
    "unsignedTx": "<base64-encoded transaction>",
    "transactionType": "deposit"
  }
}
```

Note: unlike the deposit/withdrawal endpoints, `unsignedTx` here is a single string, not an array.

The user signs and submits the refund transaction. No confirm step is required for refunds — the `transactionGroupId` can be derived locally as `sha256(signature).slice(0, 16)`.

---

## 19. Tracking Transaction Status

```
GET /v1/integrations/transaction/:transactionGroupId
```

Use the `transactionGroupId` returned by `POST /confirm` (Sections 16–17) or derived locally from a refund signature (Section 18) to poll status. You can only look up transactions that were confirmed with your own API key.

**States:**

| `state` | Meaning |
|---------|---------|
| `initialized` | On-chain escrow confirmed. Queued for execution. |
| `executing` | Jupiter swaps are in progress. |
| `completed` | All swaps finished. dTokens minted (deposit) or USDC returned (withdrawal). |
| `partially_completed` | Some swaps succeeded, some failed. A partial refund may be available. |
| `refunded` | The transaction was cancelled and tokens returned to the user. |
| `failed` | Terminal failure. |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "transactionGroupId": "a3f8c2d1e5b4f097",
    "transactionType": "deposit",
    "state": "completed",
    "walletAddress": "<user wallet>",
    "basketAddress": "<basket address>",
    "initializeSignature": "<on-chain signature of the initialize tx>",
    "totalAmount": "100500000",
    "usedAmount": "100500000",
    "remainingAmount": "0",
    "totalTokenAmount": "0",
    "totalUsdcAmount": "100500000",
    "lpTokenPriceSnapshot": "1050000",
    "finalIndexTokenBalance": "95714285",
    "hasRefund": false,
    "refundTransactionId": null,
    "refundedAmount": null,
    "refundSignature": null,
    "depositPDA": "<deposit escrow address>",
    "withdrawalPDA": null,
    "swaps": [
      {
        "signature": "...",
        "tokenInMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "amountIn": "50250000",
        "tokenOutMint": "So11111111111111111111111111111111111111112",
        "amountOut": "187543210",
        "confirmedAt": "2025-03-24T12:34:58.000Z",
        "slot": 312847562,
        "lpTokensMinted": "47857142"
      }
    ],
    "failedSwaps": [],
    "initializedAt": "2025-03-24T12:34:56.789Z",
    "executedAt": "2025-03-24T12:35:01.123Z",
    "completedAt": "2025-03-24T12:35:04.456Z",
    "refundedAt": null
  }
}
```

**Note:** All token amounts are in atomic units (smallest denomination). Divide by `10^decimals` to get human-readable values. USDC uses 6 decimals; dToken decimals can be read from the mint account (byte offset 44, as shown in Section 4 for the manual calculation path).

**Error responses:**

| Status | Cause |
|--------|-------|
| `404` | Transaction not found, or it was initiated by a different API key |
| `401` | Missing or invalid API key |

---

## 20. Example TypeScript Implementation

See `platform_integration_example.ts` for a complete working example covering all four operations: deposit, withdrawal, refund, and status polling.

```bash
npx tsx platform_integration_example.ts
```

**.env required:**
```
API_BASE_URL=https://api.diversifi.trade   # or https://staging-api.diversifi.trade for staging
DIVERSIFI_API_KEY=dfi_...                  # must have 'integrations' permission
RPC_URL=https://...
USER_SECRET_KEY=[1,2,3,...]                # 64-byte keypair as JSON array (simulates the user's wallet)
```
