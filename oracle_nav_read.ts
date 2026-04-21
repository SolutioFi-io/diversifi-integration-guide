/**
 * oracle_nav_read.ts — companion to README §8.
 *
 * Demonstrates two ways to consume the on-chain dToken NAV from a Switchboard
 * On-Demand canonical OracleQuote account:
 *
 *   1. Passive read (§8.3) — single getAccountInfo, no Switchboard SDK required.
 *      Returns whatever value the canonical account holds at read time
 *      (≤15 min stale under the DiversiFi keeper SLA).
 *
 *   2. Atomic crank (§8.4) — request a fresh oracle attestation and consume it
 *      in the same transaction. Requires @switchboard-xyz/on-demand and
 *      @switchboard-xyz/common. Demonstrates the simulate-only flow here so the
 *      example doesn't actually spend SOL; integrators who use this in
 *      production will sign and submit instead of simulating.
 *
 * Run: npx tsx oracle_nav_read.ts
 *
 * Required env (.env):
 *   RPC_URL=https://...                 # Optional, defaults to public mainnet RPC
 */

import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });

// --- Constants ---

// Switchboard quote program (owns the canonical OracleQuote PDA).
const QUOTE_PROGRAM_ID = new PublicKey("orac1eFjzWL5R3RbbdMV68K9H6TaCVVcL6LjvQQWAbz");

// Default Switchboard On-Demand mainnet queue.
const QUEUE = new PublicKey("A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w");

// dBONK NAV feedId (V2). Per-basket feedIds are managed by DiversiFi —
// contact us for the current feedId of any other basket.
const DBONK_FEED_ID = "0x9a5cfb9568ca6c9eeb9833ea0fbfb2a9e163f50d78fad56411010d386ea0c19f";

// Used purely as a fee payer for tx simulation in the atomic-crank example.
// In production, this would be the integrator's actual payer wallet.
const ADMIN_WALLET = new PublicKey("H1TRD2XtpMy5RJurDNtboDAUuvfzUCUZn8d82oBW3FZd");

// --- Helpers ---

/**
 * Derive the canonical OracleQuote PDA from (queue, [feedId]).
 *
 * Seeds: queue.toBytes() ++ feedHash bytes (32 bytes per feedId, in order).
 * Owner: QUOTE_PROGRAM_ID.
 *
 * This matches the on-chain derivation used by Switchboard's quote program;
 * the @switchboard-xyz/on-demand SDK exposes it as OracleQuote.getCanonicalPubkey.
 */
export function getCanonicalQuotePubkey(
    queue: PublicKey,
    feedIds: string[],
): [PublicKey, number] {
    const feedIdBuffers = feedIds.map(id => {
        const hex = id.replace(/^0x/, "");
        if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
            throw new Error(`Invalid feedId format (expected 32-byte hex): ${id}`);
        }
        return Buffer.from(hex, "hex");
    });
    const seeds = [Buffer.from(queue.toBytes()), ...feedIdBuffers];
    return PublicKey.findProgramAddressSync(seeds, QUOTE_PROGRAM_ID);
}

/**
 * Decode the 16-byte little-endian u128 value associated with `feedId` from a
 * canonical OracleQuote account's raw data.
 *
 * The account stores one or more (feedHash, value, minOracleSamples) records;
 * we locate the feedHash bytes and read the next 16 bytes as the value.
 *
 * Returns the value as a Number divided by 1e18 (the fixed-point decimals
 * Switchboard uses for its standard Decimal representation).
 */
export function decodeOracleQuoteValue(
    accountData: Buffer | Uint8Array,
    feedId: string,
): number {
    const data = Buffer.from(accountData);
    const feedHashBytes = Buffer.from(feedId.replace(/^0x/, ""), "hex");

    const idx = data.indexOf(feedHashBytes);
    if (idx === -1) {
        throw new Error(`feedId ${feedId} not found in account data`);
    }
    if (data.length < idx + 32 + 16) {
        throw new Error("Account data truncated; cannot read value");
    }

    let value = 0n;
    for (let j = 0; j < 16; j++) {
        value |= BigInt(data[idx + 32 + j]) << (BigInt(j) * 8n);
    }
    return Number(value) / 1e18;
}

// --- 1. Passive read (no Switchboard SDK dependency) ---

export async function readNAVPassive(
    connection: Connection,
    feedId: string,
): Promise<{ navUsd: number; quoteAccount: PublicKey }> {
    const [quoteAccount] = getCanonicalQuotePubkey(QUEUE, [feedId]);

    const accountInfo = await connection.getAccountInfo(quoteAccount, "confirmed");
    if (!accountInfo?.data) {
        throw new Error(
            `Canonical quote account ${quoteAccount.toBase58()} not yet bootstrapped — ` +
            "the basket may not have a published feed yet, or the first crank hasn't fired. " +
            "Contact DiversiFi if this persists."
        );
    }

    const navUsd = decodeOracleQuoteValue(accountInfo.data, feedId);
    return { navUsd, quoteAccount };
}

// --- 2. Atomic crank (requires @switchboard-xyz/on-demand) ---

/**
 * Build a transaction that includes a fresh oracle attestation for `feedId`
 * alongside any caller-supplied instructions. Use this when your downstream
 * logic must consume the NAV value with zero staleness — e.g. AMM quoting,
 * orderbook routing, arbitrage protection.
 *
 * NOTE: This function requires `@switchboard-xyz/on-demand` and
 * `@switchboard-xyz/common`. They are listed in the optional `peerDependencies`
 * — install them only if you need the atomic crank path:
 *
 *   pnpm add @switchboard-xyz/on-demand @switchboard-xyz/common
 *
 * Cost added per atomic crank (verified on mainnet):
 *   - tx fee:  10,000 lamports (5,000 base × 2 — one signature + Ed25519 precompile)
 *   - CU:      ~628 (Ed25519 runs as native precompile, doesn't count)
 *   - bytes:   ~330 (Ed25519 ix data + quote-program ix data)
 *   - latency: ~2-5s (Switchboard gateway round-trip)
 */
export async function buildAtomicCrankInstructions(
    connection: Connection,
    feedId: string,
    payer: PublicKey,
) {
    // Lazy-import so the file still runs in passive-read-only mode without these deps.
    // @ts-ignore - optional peer dependency
    const sb = await import("@switchboard-xyz/on-demand");
    // @ts-ignore - optional peer dependency
    const { CrossbarClient } = await import("@switchboard-xyz/common");

    const program = await (sb.AnchorUtils as any).loadProgramFromConnection(
        connection,
        undefined,
        sb.ON_DEMAND_MAINNET_PID,
    );
    const queue = await sb.Queue.loadDefault(program);
    const crossbar = new CrossbarClient("https://crossbar.switchboard.xyz", false);

    // Returns [ed25519VerifyIx, quoteProgramVerifiedUpdateIx].
    const updateIxs = await queue.fetchManagedUpdateIxs(crossbar, [feedId], { payer });
    return updateIxs as any[];
}

// --- Main demo ---

async function main() {
    const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
    const connection = new Connection(RPC_URL, "confirmed");

    console.log(`RPC: ${RPC_URL}`);
    console.log(`Queue: ${QUEUE.toBase58()}`);
    console.log(`feedId (dBONK): ${DBONK_FEED_ID}`);
    console.log();

    // --- Demo 1: Passive read ---
    console.log("--- Demo 1: Passive read (no Switchboard SDK) ---");
    try {
        const { navUsd, quoteAccount } = await readNAVPassive(connection, DBONK_FEED_ID);
        console.log(`  Canonical quote account: ${quoteAccount.toBase58()}`);
        console.log(`  dBONK NAV: $${navUsd.toFixed(8)} per LP token`);
    } catch (e: any) {
        console.error(`  Passive read failed: ${e.message}`);
    }

    // --- Demo 2: Atomic crank (simulate-only) ---
    console.log("\n--- Demo 2: Atomic crank (simulate-only) ---");
    try {
        const updateIxs = await buildAtomicCrankInstructions(
            connection,
            DBONK_FEED_ID,
            ADMIN_WALLET,
        );
        console.log(`  Got ${updateIxs.length} update instruction(s) from the oracle`);

        // In production the integrator would prepend updateIxs to their own tx,
        // sign with their payer, and submit. Here we just simulate a tx that
        // contains only the update ixs to confirm the oracle responded.
        const blockhash = await connection.getLatestBlockhash("confirmed");
        const tx = new Transaction({
            recentBlockhash: blockhash.blockhash,
            feePayer: ADMIN_WALLET,
        });
        for (const ix of updateIxs) tx.add(ix);

        const sim = await connection.simulateTransaction(tx);
        if (sim.value.err) {
            console.warn(`  Simulation reported err: ${JSON.stringify(sim.value.err)}`);
        } else {
            console.log(`  Simulation OK — CU consumed: ${sim.value.unitsConsumed ?? "?"}`);
            console.log("  In production: prepend these instructions to your own tx,");
            console.log("  sign with your payer, and submit. The canonical account will");
            console.log("  hold the freshly-signed value at the end of your transaction.");
        }
    } catch (e: any) {
        const msg = e.message ?? "";
        const isMissingDep =
            e.code === "MODULE_NOT_FOUND" ||
            e.code === "ERR_MODULE_NOT_FOUND" ||
            /Cannot find (module|package) '@switchboard-xyz/.test(msg);
        if (isMissingDep) {
            console.log("  Skipped — install @switchboard-xyz/on-demand + @switchboard-xyz/common to run this demo.");
        } else {
            console.error(`  Atomic crank demo failed: ${msg}`);
        }
    }
}

const isMain =
    (typeof require !== "undefined" && require.main === module) ||
    (typeof process !== "undefined" && process.argv[1]?.endsWith("oracle_nav_read.ts"));

if (isMain) {
    main().catch(e => {
        console.error("FATAL:", e);
        process.exit(1);
    });
}
