# DiversiFi dToken On-Chain Pricing Integration Guide

This guide explains how aggregators, platforms, and indexers can retrieve real-time on-chain pricing for DiversiFi dTokens directly from the Solana blockchain.

## Overview

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

The Index Account follows the Anchor framework's 8-byte discriminator pattern.
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

// For each valid mint in the basket:
const isToken2022 = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
const tokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

const vaultPubkey = getAssociatedTokenAddressSync(
    constituentMint, // The underlying token mint
    indexPda,        // The Index PDA acts as the owner
    true,            // allowOwnerOffCurve = true (since owner is a PDA)
    tokenProgramId
);
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

See the provided `example.ts` script in this repository for a complete end-to-end working example using the `@solana/web3.js` and `@coral-xyz/anchor` libraries.
