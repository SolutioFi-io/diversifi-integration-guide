/**
 * DiversiFi Platform Integration Example
 *
 * Demonstrates how a third-party platform can execute deposits, withdrawals,
 * and refunds on behalf of its end users using a single API key with the
 * `integrations` permission.
 *
 * Flow:
 *   1. Platform backend calls /v1/integrations/deposit/tx (or withdraw/tx) with the user's wallet.
 *   2. API returns an unsigned Solana transaction + a one-time confirmToken.
 *   3. User signs and submits the transaction (e.g. via their wallet adapter).
 *   4. Platform calls POST /v1/integrations/confirm with the signature + confirmToken.
 *      This links the transaction to your API key and returns the transactionGroupId.
 *   5. Platform polls /v1/integrations/transaction/:transactionGroupId for status.
 *
 * Requirements: npm install @solana/web3.js dotenv
 */

import { createHash } from "crypto";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });

// ---------------------------------------------------------------------------
// Configuration — set these in your .env file
// ---------------------------------------------------------------------------
const API_BASE_URL = process.env.API_BASE_URL ?? "https://api.diversifi.trade";
const API_KEY = process.env.DIVERSIFI_API_KEY ?? "";  // dfi_... with 'integrations' permission
const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

// In production the user signs on the frontend via their wallet adapter.
// Here we load a keypair from an environment variable to simulate that step.
const USER_SECRET_KEY = process.env.USER_SECRET_KEY
    ? Uint8Array.from(JSON.parse(process.env.USER_SECRET_KEY))
    : null;

// ---------------------------------------------------------------------------
// Helpers
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

async function apiPost<T>(path: string, payload: Record<string, string>): Promise<T> {
    const response = await fetch(new URL(path, API_BASE_URL).toString(), {
        method: "POST",
        headers: {
            Authorization: `Bearer ${API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
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

/**
 * Derive the transactionGroupId from a Solana signature.
 * The backend computes: sha256(signature).hex().slice(0, 16)
 *
 * Used for refunds (which have no confirm step).
 * For deposits and withdrawals, prefer the ID returned by POST /confirm.
 */
function deriveTransactionGroupId(signature: string): string {
    return createHash("sha256")
        .update(signature)
        .digest("hex")
        .substring(0, 16);
}

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
// Platform deposit: USDC → LP tokens
// ---------------------------------------------------------------------------

/**
 * Initiates a deposit on behalf of an end user.
 *
 * @param userWallet     The end user's Solana wallet address (base58)
 * @param basketAddress  The basket address / Index PDA (base58)
 * @param usdcAmount     Human-readable USDC amount (e.g. 100.5 for $100.50)
 * @returns              transactionGroupId — use this to poll status
 */
export async function platformDeposit(
    connection: Connection,
    userSigner: Keypair,
    userWallet: string,
    basketAddress: string,
    usdcAmount: number
): Promise<string> {
    console.log(`Fetching unsigned deposit transaction (${usdcAmount} USDC → ${basketAddress})...`);

    const { data } = await apiGet<{ data: { unsignedTxs: string[]; confirmToken: string } }>(
        "/v1/integrations/deposit/tx",
        { basket_address: basketAddress, amount: usdcAmount, user_wallet: userWallet }
    );

    const { confirmToken } = data;
    let lastSignature = "";

    for (const unsignedTx of data.unsignedTxs) {
        // In production: present the transaction to the user's wallet adapter for signing.
        // Here we sign directly with the loaded keypair for demonstration.
        console.log("Signing and submitting transaction...");
        lastSignature = await signAndSubmit(connection, userSigner, unsignedTx);
        console.log(`  Submitted: ${lastSignature}`);
    }

    // Confirm: links the on-chain signature to your API key and returns the transactionGroupId.
    // Without this step the transaction processes but cannot be retrieved via GET /transaction/:id.
    console.log("Confirming with DiversiFi API...");
    const { data: confirmData } = await apiPost<{ data: { transactionGroupId: string } }>(
        "/v1/integrations/confirm",
        { signature: lastSignature, confirmToken }
    );

    const { transactionGroupId } = confirmData;
    console.log(`Deposit confirmed. transactionGroupId: ${transactionGroupId}`);
    return transactionGroupId;
}

// ---------------------------------------------------------------------------
// Platform withdrawal: LP tokens → USDC
// ---------------------------------------------------------------------------

/**
 * Initiates a withdrawal on behalf of an end user.
 *
 * @param userWallet     The end user's Solana wallet address (base58)
 * @param basketAddress  The basket address / Index PDA (base58)
 * @param lpAmount       Human-readable LP token amount to withdraw
 * @returns              transactionGroupId — use this to poll status
 */
export async function platformWithdraw(
    connection: Connection,
    userSigner: Keypair,
    userWallet: string,
    basketAddress: string,
    lpAmount: number
): Promise<string> {
    console.log(`Fetching unsigned withdrawal transaction (${lpAmount} LP tokens from ${basketAddress})...`);

    const { data } = await apiGet<{ data: { unsignedTxs: string[]; confirmToken: string } }>(
        "/v1/integrations/withdraw/tx",
        { basket_address: basketAddress, amount: lpAmount, user_wallet: userWallet }
    );

    const { confirmToken } = data;
    let lastSignature = "";

    for (const unsignedTx of data.unsignedTxs) {
        console.log("Signing and submitting transaction...");
        lastSignature = await signAndSubmit(connection, userSigner, unsignedTx);
        console.log(`  Submitted: ${lastSignature}`);
    }

    // Confirm: links the on-chain signature to your API key and returns the transactionGroupId.
    console.log("Confirming with DiversiFi API...");
    const { data: confirmData } = await apiPost<{ data: { transactionGroupId: string } }>(
        "/v1/integrations/confirm",
        { signature: lastSignature, confirmToken }
    );

    const { transactionGroupId } = confirmData;
    console.log(`Withdrawal confirmed. transactionGroupId: ${transactionGroupId}`);
    return transactionGroupId;
}

// ---------------------------------------------------------------------------
// Platform refund: cancel a stuck deposit or withdrawal
// ---------------------------------------------------------------------------

/**
 * Cancels a pending deposit or withdrawal and reclaims the locked tokens.
 *
 * @param userWallet     The end user's Solana wallet address (base58)
 * @param basketAddress  The basket address / Index PDA (base58)
 * @returns              transactionGroupId of the refund transaction, or null if nothing to refund
 */
export async function platformRefund(
    connection: Connection,
    userSigner: Keypair,
    userWallet: string,
    basketAddress: string
): Promise<string | null> {
    const { data: eligibility } = await apiGet<{
        data: {
            canRefund: boolean;
            refundType: "deposit" | "withdraw" | null;
        }
    }>("/v1/integrations/refund/check", { basket_address: basketAddress, user_wallet: userWallet });

    if (!eligibility.canRefund || !eligibility.refundType) {
        console.log("No refundable balance found.");
        return null;
    }

    console.log(`Refunding ${eligibility.refundType}...`);

    const { data: refundData } = await apiGet<{ data: { unsignedTx: string } }>(
        "/v1/integrations/refund/tx",
        { basket_address: basketAddress, user_wallet: userWallet, refund_type: eligibility.refundType }
    );

    const signature = await signAndSubmit(connection, userSigner, refundData.unsignedTx);
    console.log(`  Submitted refund: ${signature}`);

    const transactionGroupId = deriveTransactionGroupId(signature);
    console.log(`Refund submitted. transactionGroupId: ${transactionGroupId}`);
    return transactionGroupId;
}

// ---------------------------------------------------------------------------
// Poll transaction status
// ---------------------------------------------------------------------------

type TransactionState =
    | "initialized"
    | "executing"
    | "completed"
    | "partially_completed"
    | "refunded"
    | "failed";

const TERMINAL_STATES = new Set<TransactionState>(["completed", "partially_completed", "refunded", "failed"]);

/**
 * Polls /v1/integrations/transaction/:transactionGroupId until the transaction
 * reaches a terminal state or the timeout is exceeded.
 *
 * @param transactionGroupId  Derived from deriveTransactionGroupId(signature)
 * @param timeoutMs           Max wait time in milliseconds (default: 5 minutes)
 * @param intervalMs          Poll interval in milliseconds (default: 5 seconds)
 */
export async function pollTransactionStatus(
    transactionGroupId: string,
    timeoutMs = 5 * 60 * 1000,
    intervalMs = 5_000
): Promise<{ state: TransactionState; data: any }> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const { data } = await apiGet<{ data: { state: TransactionState } & any }>(
            `/v1/integrations/transaction/${transactionGroupId}`,
            {}
        );

        console.log(`  [${transactionGroupId}] state: ${data.state}`);

        if (TERMINAL_STATES.has(data.state)) {
            return { state: data.state, data };
        }

        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Transaction ${transactionGroupId} did not reach terminal state within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

const isMain =
    typeof require !== "undefined" && require.main === module ||
    (typeof process !== "undefined" && process.argv[1]?.endsWith("platform_integration_example.ts"));

if (isMain) {
    if (!API_KEY) {
        console.error("Set DIVERSIFI_API_KEY in your .env file (requires 'integrations' permission).");
        process.exit(1);
    }
    if (!USER_SECRET_KEY) {
        console.error("Set USER_SECRET_KEY in your .env file (JSON array of 64 bytes).");
        process.exit(1);
    }

    const connection = new Connection(RPC_URL, "confirmed");
    const userSigner = Keypair.fromSecretKey(USER_SECRET_KEY);
    const userWallet = userSigner.publicKey.toBase58();
    const BASKET = "HfrGnAvWjkNJCbixiVf9zRAbCZP8BKh2tWqtFqsGsdY1"; // example basket address (Index PDA) for dToken ADdkaLqDsupDXi3qAEpuv9LXUSjA25ypcKGRseejLXaz

    (async () => {
        try {
            console.log(`User wallet: ${userWallet}\n`);

            // --- Deposit 10 USDC ---
            const depositGroupId = await platformDeposit(connection, userSigner, userWallet, BASKET, 10);
            const { state, data } = await pollTransactionStatus(depositGroupId);
            console.log(`\nDeposit final state: ${state}`);
            if (data.finalIndexTokenBalance) {
                console.log(`LP tokens received: ${data.finalIndexTokenBalance}`);
            }

            // --- Withdraw 5 LP tokens ---
            // const withdrawGroupId = await platformWithdraw(connection, userSigner, userWallet, BASKET, 5);
            // await pollTransactionStatus(withdrawGroupId);

            // --- Refund a stuck operation ---
            // const refundGroupId = await platformRefund(connection, userSigner, userWallet, BASKET);
            // if (refundGroupId) await pollTransactionStatus(refundGroupId);
        } catch (e) {
            console.error(e);
        }
    })();
}
