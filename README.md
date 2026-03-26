# DiversiFi Integration Guide

This guide covers three integration paths for third-party platforms:

- **On-chain pricing** (Sections 1–7): Read real-time NAV and dToken prices directly from the Solana blockchain — no API key required.
- **Deposits & withdrawals** (Sections 8–13): Execute deposits and withdrawals on behalf of a single authenticated wallet via the DiversiFi API.
- **Platform integration** (Sections 14–18): Manage deposits, withdrawals, and refunds for multiple end users from a single API key — designed for platforms that want to embed DiversiFi without exposing credentials to users.

---

## On-Chain Pricing Overview

A dToken (e.g., dBLUE) represents a programmable, self-custodial basket of underlying assets on Solana. To calculate the real-time net asset value (NAV) and price of a dToken, integrator platforms need to:
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

## 8. Authentication

All deposit and withdrawal operations go through the DiversiFi API. You will need an API key to interact with these endpoints.

Contact the DiversiFi team to obtain an API key. Keys are prefixed with `dfi_` and must be sent as a Bearer token on every request:

```
Authorization: Bearer dfi_your_api_key_here
```

**Rate limit:** 120 requests per minute per API key.

**Required permission scope:** `position_management` (for deposits, withdrawals, and refunds). Read-only endpoints require only `read_only`.

---

## 9. Deposit Flow

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

## 10. Withdrawal Flow

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

## 11. Cancelling Pending Operations

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

## 12. Reading Positions and History

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

## 13. Example TypeScript Implementation

See `deposit_withdraw_example.ts` for a complete working example of the deposit and withdrawal flows using the API.

---

## 14. Platform Integration Overview

The platform integration API (`/v1/integrations/`) is designed for third-party platforms that want to embed DiversiFi deposits and withdrawals for their own end users without requiring each user to authenticate directly with DiversiFi.

**Key difference from Sections 8–13:** The standard `/v1/positions/` endpoints act on behalf of the authenticated wallet. The `/v1/integrations/` endpoints let your platform specify any `user_wallet` address, so a single API key can serve many users.

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

## 15. Platform Deposit Flow

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

The `transactionGroupId` is a 16-character hex ID you use to poll status (Section 18). It is also deterministic — computed as `sha256(signature).slice(0, 16)` — so you can derive it locally, but the confirm response is the canonical source.

> **Why is the confirm step required?** It links the on-chain transaction to your API key so that only your key can retrieve it via `/transaction/:id`. Without it, the transaction processes normally but will not be visible through the integrations API.

---

## 16. Platform Withdrawal Flow

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

The user signs and submits the transaction. Then call `POST /v1/integrations/confirm` with the signature and `confirmToken`, exactly as in Section 15. The confirm response returns the `transactionGroupId` for polling.

---

## 17. Platform Refund Flow

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

## 18. Tracking Transaction Status

```
GET /v1/integrations/transaction/:transactionGroupId
```

Use the `transactionGroupId` returned by `POST /confirm` (Sections 15–16) or derived locally from a refund signature (Section 17) to poll status. You can only look up transactions that were confirmed with your own API key.

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

**Note:** All token amounts are in atomic units (smallest denomination). Divide by `10^decimals` to get human-readable values. USDC uses 6 decimals; dToken decimals can be read from the mint account (byte offset 44, as shown in Section 4).

**Error responses:**

| Status | Cause |
|--------|-------|
| `404` | Transaction not found, or it was initiated by a different API key |
| `401` | Missing or invalid API key |

---

## 19. Example TypeScript Implementation

See `platform_integration_example.ts` for a complete working example covering all four operations: deposit, withdrawal, refund, and status polling.

```bash
npx tsx platform_integration_example.ts
```

**.env required:**
```
API_BASE_URL=https://dev-api.diversifi.trade
DIVERSIFI_API_KEY=dfi_...          # must have 'integrations' permission
RPC_URL=https://...
USER_SECRET_KEY=[1,2,3,...]        # 64-byte keypair as JSON array (simulates the user's wallet)
```
