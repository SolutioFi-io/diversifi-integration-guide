/**
 * oracle_nav_read.ts - companion to README Section 8.
 *
 * Reads a dToken NAV from a Switchboard On-Demand canonical OracleQuote account, and refuses
 * to hand back a value older than your staleness limit.
 *
 *   1. Passive read (Section 8.3): one getAccountInfo, no Switchboard SDK required.
 *   2. Atomic crank (Section 8.4): fetch a fresh oracle quote and consume it in the same
 *      transaction. Requires @switchboard-xyz/on-demand and @switchboard-xyz/common. The demo
 *      only simulates, so it never spends SOL.
 *
 * No basket currently has a published NAV feed (README Section 8.2). Run it against the
 * feedId DiversiFi gives you:
 *
 *   FEED_ID=0x... npx tsx oracle_nav_read.ts
 *
 * Optional env (.env):
 *   RPC_URL=https://...    defaults to the public mainnet RPC
 *   MAX_AGE_SLOTS=4500     staleness limit for the passive read (default about 30 minutes)
 *   SIM_PAYER=<pubkey>     any funded wallet, used only as fee payer to simulate the crank demo
 */

import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });

// --- Constants ---

// Switchboard quote program (owns the canonical OracleQuote PDA).
const QUOTE_PROGRAM_ID = new PublicKey("orac1eFjzWL5R3RbbdMV68K9H6TaCVVcL6LjvQQWAbz");

// Default Switchboard On-Demand mainnet queue.
const QUEUE = new PublicKey("A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w");

// About 30 minutes at ~400ms per slot. Reasonable for a balance display. For anything that
// moves money, use the atomic crank rather than trusting a passive read.
export const DEFAULT_MAX_AGE_SLOTS = 4_500;

// Canonical OracleQuote account layout:
//   [8 bytes "SBOracle"][32 bytes queue][u16 LE quote length][quote bytes][zero padding]
// The quote bytes end with [u64 LE recent_slot][u8 version][4 bytes "SBOD"].
const ACCOUNT_DISCRIMINATOR = Buffer.from("SBOracle");
const QUOTE_END_MARKER = Buffer.from("SBOD");
const QUOTE_LENGTH_OFFSET = 40;
const QUOTE_DATA_OFFSET = 42;
const RECENT_SLOT_FROM_QUOTE_END = 13;

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

/**
 * Read the slot at which the oracle produced the quote held in a canonical OracleQuote account.
 * Throws if the data is not a well-formed quote account.
 */
export function decodeOracleQuoteRecentSlot(accountData: Buffer | Uint8Array): bigint {
    const data = Buffer.from(accountData);
    if (data.length < QUOTE_DATA_OFFSET || !data.subarray(0, 8).equals(ACCOUNT_DISCRIMINATOR)) {
        throw new Error("Not a canonical OracleQuote account");
    }

    const quoteLength = data.readUInt16LE(QUOTE_LENGTH_OFFSET);
    const quoteEnd = QUOTE_DATA_OFFSET + quoteLength;
    if (
        quoteLength < RECENT_SLOT_FROM_QUOTE_END ||
        quoteEnd > data.length ||
        !data.subarray(quoteEnd - 4, quoteEnd).equals(QUOTE_END_MARKER)
    ) {
        throw new Error("OracleQuote account data is malformed; cannot read recent_slot");
    }
    return data.readBigUInt64LE(quoteEnd - RECENT_SLOT_FROM_QUOTE_END);
}

export class StaleQuoteError extends Error {
    constructor(
        readonly recentSlot: bigint,
        readonly currentSlot: bigint,
        readonly maxAgeSlots: number,
    ) {
        super(
            `Quote is ${currentSlot - recentSlot} slots old (limit ${maxAgeSlots}); refusing to use it`,
        );
        this.name = "StaleQuoteError";
    }
}

/**
 * Throw StaleQuoteError when the quote is older than `maxAgeSlots` at `currentSlot`.
 * Returns the age in slots. A quote newer than `currentSlot` (your RPC lagging the write)
 * counts as age 0.
 */
export function assertQuoteFresh(
    accountData: Buffer | Uint8Array,
    currentSlot: number | bigint,
    maxAgeSlots: number = DEFAULT_MAX_AGE_SLOTS,
): bigint {
    const recentSlot = decodeOracleQuoteRecentSlot(accountData);
    const now = BigInt(currentSlot);
    if (recentSlot >= now) return 0n;

    const age = now - recentSlot;
    if (age > BigInt(maxAgeSlots)) {
        throw new StaleQuoteError(recentSlot, now, maxAgeSlots);
    }
    return age;
}

// --- 1. Passive read (no Switchboard SDK dependency) ---

export async function readNAVPassive(
    connection: Connection,
    feedId: string,
    maxAgeSlots: number = DEFAULT_MAX_AGE_SLOTS,
): Promise<{ navUsd: number; quoteAccount: PublicKey; ageSlots: bigint }> {
    const [quoteAccount] = getCanonicalQuotePubkey(QUEUE, [feedId]);

    // Read the account and the slot it was observed at in one call, so the age is measured
    // against the same point in time as the data.
    const { context, value } = await connection.getAccountInfoAndContext(quoteAccount, "confirmed");
    if (!value?.data) {
        throw new Error(
            `Canonical quote account ${quoteAccount.toBase58()} not yet bootstrapped - ` +
            "the basket may not have a published feed yet, or the first crank hasn't fired. " +
            "Contact DiversiFi if this persists."
        );
    }

    const ageSlots = assertQuoteFresh(value.data, context.slot, maxAgeSlots);
    const navUsd = decodeOracleQuoteValue(value.data, feedId);
    return { navUsd, quoteAccount, ageSlots };
}

// --- 2. Atomic crank (requires @switchboard-xyz/on-demand) ---

/**
 * Build a transaction that includes a fresh oracle attestation for `feedId`
 * alongside any caller-supplied instructions. Use this when your downstream
 * logic must consume the NAV value with zero staleness - e.g. AMM quoting,
 * orderbook routing, arbitrage protection.
 *
 * NOTE: This function requires `@switchboard-xyz/on-demand` and
 * `@switchboard-xyz/common`. They are listed in the optional `peerDependencies`
 * - install them only if you need the atomic crank path:
 *
 *   pnpm add @switchboard-xyz/on-demand @switchboard-xyz/common
 *
 * Cost added per atomic crank (verified on mainnet):
 *   - tx fee:  10,000 lamports (5,000 base x 2 - one signature + Ed25519 precompile)
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
    const feedId = process.env.FEED_ID;
    if (!feedId) {
        console.error(
            "Set FEED_ID to the feedId DiversiFi published for your basket.\n" +
            "No basket currently has a published NAV feed (README Section 8.2). Until one does, " +
            "compute NAV from on-chain state (Sections 1-7, price_derivation.ts)."
        );
        process.exit(1);
    }

    const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
    const maxAgeSlots = Number(process.env.MAX_AGE_SLOTS ?? DEFAULT_MAX_AGE_SLOTS);
    const connection = new Connection(RPC_URL, "confirmed");

    console.log(`RPC host: ${new URL(RPC_URL).host}`);
    console.log(`Queue: ${QUEUE.toBase58()}`);
    console.log(`feedId: ${feedId}`);
    console.log(`Staleness limit: ${maxAgeSlots} slots`);
    console.log();

    // --- Demo 1: Passive read ---
    console.log("--- Demo 1: Passive read (no Switchboard SDK) ---");
    try {
        const { navUsd, quoteAccount, ageSlots } = await readNAVPassive(connection, feedId, maxAgeSlots);
        console.log(`  Canonical quote account: ${quoteAccount.toBase58()}`);
        console.log(`  NAV: $${navUsd.toFixed(8)} per dToken (quote is ${ageSlots} slots old)`);
    } catch (e: any) {
        if (e instanceof StaleQuoteError) {
            console.error(`  Rejected stale quote: ${e.message}`);
        } else {
            console.error(`  Passive read failed: ${e.message}`);
        }
    }

    // --- Demo 2: Atomic crank (simulate-only) ---
    const simPayer = process.env.SIM_PAYER;
    if (!simPayer) {
        console.log("\n--- Demo 2 skipped: set SIM_PAYER to a funded wallet to simulate the atomic crank ---");
        return;
    }

    console.log("\n--- Demo 2: Atomic crank (simulate-only) ---");
    try {
        const payer = new PublicKey(simPayer);
        const updateIxs = await buildAtomicCrankInstructions(connection, feedId, payer);
        console.log(`  Got ${updateIxs.length} update instruction(s) from the oracle`);

        // In production the integrator would prepend updateIxs to their own tx,
        // sign with their payer, and submit. Here we just simulate a tx that
        // contains only the update ixs to confirm the oracle responded.
        const blockhash = await connection.getLatestBlockhash("confirmed");
        const tx = new Transaction({
            recentBlockhash: blockhash.blockhash,
            feePayer: payer,
        });
        for (const ix of updateIxs) tx.add(ix);

        const sim = await connection.simulateTransaction(tx);
        if (sim.value.err) {
            console.warn(`  Simulation reported err: ${JSON.stringify(sim.value.err)}`);
        } else {
            console.log(`  Simulation OK - CU consumed: ${sim.value.unitsConsumed ?? "?"}`);
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
            console.log("  Skipped - install @switchboard-xyz/on-demand + @switchboard-xyz/common to run this demo.");
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
