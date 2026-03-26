/**
 * DiversiFi Deposit & Withdrawal Example
 *
 * Demonstrates how to deposit USDC into a basket and withdraw LP tokens back to USDC
 * using the DiversiFi API. Requires an API key with `position_management` permission.
 *
 * Flow for deposits and withdrawals:
 *   1. Call the API to get an unsigned Solana transaction.
 *   2. Sign it with the user's wallet.
 *   3. Submit it to the Solana network.
 *   4. Call the API confirm endpoint with the resulting signature.
 *
 * Requirements: npm install @solana/web3.js dotenv
 */

import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });

// ---------------------------------------------------------------------------
// Configuration — set these in your .env file
// ---------------------------------------------------------------------------
const API_BASE_URL = process.env.API_BASE_URL ?? "https://api.diversifi.trade";
const API_KEY      = process.env.DIVERSIFI_API_KEY ?? "";           // dfi_...
const RPC_URL      = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

// For a real integration the user signs client-side (e.g. via wallet adapter).
// Here we load a keypair from an environment variable for demonstration.
const USER_SECRET_KEY = process.env.USER_SECRET_KEY
    ? Uint8Array.from(JSON.parse(process.env.USER_SECRET_KEY))
    : null;

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

async function apiGet<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const url = new URL(path, API_BASE_URL);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
    }

    const response = await fetch(url.toString(), {
        headers: {
            Authorization: `Bearer ${API_KEY}`,
            "Content-Type": "application/json",
        },
    });

    if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after") ?? "60";
        throw new Error(`Rate limited. Retry after ${retryAfter}s`);
    }

    const body = await response.json() as any;

    if (!response.ok || body.error) {
        throw new Error(body.error ?? body.message ?? `HTTP ${response.status}`);
    }

    return body as T;
}

// ---------------------------------------------------------------------------
// Sign and submit a base64-encoded unsigned transaction
// ---------------------------------------------------------------------------

async function signAndSubmit(
    connection: Connection,
    signer: Keypair,
    base64Tx: string
): Promise<string> {
    const txBytes = Buffer.from(base64Tx, "base64");
    const tx = VersionedTransaction.deserialize(txBytes);
    tx.sign([signer]);
    const signature = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(signature, "confirmed");
    return signature;
}

// ---------------------------------------------------------------------------
// Deposit: USDC → LP tokens
// ---------------------------------------------------------------------------

/**
 * Deposits USDC into a DiversiFi basket.
 *
 * @param basketAddress  The basket address / Index PDA (base58)
 * @param usdcAmount     Human-readable USDC amount (e.g. 100.5 for $100.50)
 */
export async function deposit(
    connection: Connection,
    signer: Keypair,
    basketAddress: string,
    usdcAmount: number
): Promise<string> {
    console.log(`Fetching unsigned deposit transaction (${usdcAmount} USDC → ${basketAddress})...`);

    const { data } = await apiGet<{ data: { unsignedTxs: string[] } }>(
        "/v1/positions/open/tx",
        { basket_address: basketAddress, amount: usdcAmount }
    );

    let lastSignature = "";

    for (const unsignedTx of data.unsignedTxs) {
        console.log("Signing and submitting transaction...");
        lastSignature = await signAndSubmit(connection, signer, unsignedTx);
        console.log(`  Submitted: ${lastSignature}`);
    }

    console.log("Confirming with DiversiFi API...");
    await apiGet("/v1/positions/open/confirm", {
        basket_address: basketAddress,
        signature: lastSignature,
    });

    console.log("Deposit confirmed. LP tokens will arrive in your wallet shortly.");
    return lastSignature;
}

// ---------------------------------------------------------------------------
// Withdrawal: LP tokens → USDC
// ---------------------------------------------------------------------------

/**
 * Withdraws LP tokens from a DiversiFi basket back to USDC.
 *
 * @param basketAddress  The basket address / Index PDA (base58)
 * @param lpAmount       Human-readable LP token amount to withdraw
 */
export async function withdraw(
    connection: Connection,
    signer: Keypair,
    basketAddress: string,
    lpAmount: number
): Promise<string> {
    console.log(`Fetching unsigned withdrawal transaction (${lpAmount} LP tokens from ${basketAddress})...`);

    const { data } = await apiGet<{ data: { unsignedTxs: string[] } }>(
        "/v1/positions/close/tx",
        { basket_address: basketAddress, amount: lpAmount }
    );

    let lastSignature = "";

    for (const unsignedTx of data.unsignedTxs) {
        console.log("Signing and submitting transaction...");
        lastSignature = await signAndSubmit(connection, signer, unsignedTx);
        console.log(`  Submitted: ${lastSignature}`);
    }

    console.log("Confirming with DiversiFi API...");
    await apiGet("/v1/positions/close/confirm", {
        basket_address: basketAddress,
        signature: lastSignature,
    });

    console.log("Withdrawal confirmed. USDC will arrive in your wallet shortly.");
    return lastSignature;
}

// ---------------------------------------------------------------------------
// Refund: cancel a stuck deposit or withdrawal
// ---------------------------------------------------------------------------

/**
 * Cancels a pending deposit or withdrawal and reclaims the locked tokens.
 * Only the unprocessed portion is returned.
 *
 * @param basketAddress  The basket address / Index PDA (base58)
 */
export async function refund(
    connection: Connection,
    signer: Keypair,
    basketAddress: string
): Promise<void> {
    // Check what can be refunded
    const { data: eligibility } = await apiGet<{
        data: { canRefund: boolean; refundType: "deposit" | "withdrawal" | null }
    }>("/v1/positions/refund/check", { basket_address: basketAddress });

    if (!eligibility.canRefund || !eligibility.refundType) {
        console.log("No refundable balance found for this basket.");
        return;
    }

    // refund/check returns "withdrawal" but refund/tx expects "withdraw"
    const refundType = eligibility.refundType === "withdrawal" ? "withdraw" : eligibility.refundType;

    console.log(`Refunding ${refundType}...`);

    const { data: refundData } = await apiGet<{ data: { unsignedTx: string } }>(
        "/v1/positions/refund/tx",
        { basket_address: basketAddress, refund_type: refundType }
    );

    const signature = await signAndSubmit(connection, signer, refundData.unsignedTx);
    console.log(`  Submitted refund: ${signature}`);

    await apiGet("/v1/positions/refund/confirm", {
        basket_address: basketAddress,
        refund_signature: signature,
    });

    console.log("Refund confirmed.");
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

const isMain =
    typeof require !== "undefined" && require.main === module ||
    (typeof process !== "undefined" && process.argv[1]?.endsWith("deposit_withdraw_example.ts"));

if (isMain) {
    if (!API_KEY) {
        console.error("Set DIVERSIFI_API_KEY in your .env file.");
        process.exit(1);
    }
    if (!USER_SECRET_KEY) {
        console.error("Set USER_SECRET_KEY in your .env file (JSON array of 64 bytes).");
        process.exit(1);
    }

    const connection = new Connection(RPC_URL, "confirmed");
    const signer     = Keypair.fromSecretKey(USER_SECRET_KEY);
    const BASKET     = "HfrGnAvWjkNJCbixiVf9zRAbCZP8BKh2tWqtFqsGsdY1"; // example basket address (Index PDA) for dToken ADdkaLqDsupDXi3qAEpuv9LXUSjA25ypcKGRseejLXaz

    (async () => {
        try {
            // Deposit 10 USDC
            await deposit(connection, signer, BASKET, 10);

            // Withdraw 5 LP tokens
            // await withdraw(connection, signer, BASKET, 5);

            // Cancel a stuck operation
            // await refund(connection, signer, BASKET);
        } catch (e) {
            console.error(e);
        }
    })();
}
