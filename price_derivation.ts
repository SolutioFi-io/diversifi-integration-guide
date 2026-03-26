import * as borsh from "@coral-xyz/borsh";
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });

// Requirements: npm install @solana/web3.js @solana/spl-token @coral-xyz/borsh dotenv

// --- Constants ---
const DIVERSIFI_PROGRAM_ID = new PublicKey("3vyr9DRfMZb2KvUQdnps7YG3PY38XdguLBQaJ2DFkSxk");
const ADMIN_WALLET = new PublicKey("H1TRD2XtpMy5RJurDNtboDAUuvfzUCUZn8d82oBW3FZd"); // Used purely as a fee payer for simulation
const JUP_API_KEY = process.env.JUP_API_KEY;

// Borsh schema matching the Rust struct returned by the get_vault_balances simulated instruction
const vaultBalancesSchema = borsh.struct([
    borsh.vec(borsh.u64(), "tokenBalances"),
    borsh.vec(borsh.publicKey(), "mints"),
    borsh.u64("indexSupply"),
    borsh.i64("timestamp"),
    borsh.u64("slot"),
]);

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

export async function fetchAllDTokenMints(connection: Connection): Promise<string[]> {
    console.log("Fetching dToken Mints using dataSlice...");
    const INDEX_ACCOUNT_SIZE = 246;

    // We use getProgramAccounts but strictly limit what the RPC sends back
    const accounts = await connection.getProgramAccounts(DIVERSIFI_PROGRAM_ID, {
        dataSlice: {
            // Note: The structure of the Index struct is:
            // 1 byte discriminator + 32 byte manager pubkey + 32 byte tokenMint pubkey
            offset: 33, // Start pulling exactly at the tokenMint pubkey
            length: 32  // Only pull the 32 byte pubkey and nothing else
        },
        filters: [
            // Ensure we only query valid Index Accounts by checking their layout size
            { dataSize: INDEX_ACCOUNT_SIZE }
        ]
    });

    console.log(`Found ${accounts.length} valid dTokens.`);

    // Convert the raw 32 bytes directly into an array of base-58 strings
    return accounts.map(acc => new PublicKey(acc.account.data).toBase58());
}

export async function fetchVaultBalancesWithInstruction(
    connection: Connection,
    indexPda: PublicKey,
    dTokenMint: PublicKey,
    dTokenDecimals: number,
    vaultAccountsWithMeta: any[]
) {
    // 5. Build and execute atomic on-chain `get_vault_balances` simulation
    const remainingAccounts = vaultAccountsWithMeta.map((v: any) => ({
        pubkey: v.pubkey,
        isSigner: v.isSigner,
        isWritable: v.isWritable
    }));

    // Construct the manual instruction bytes (method discriminator: [138, 38, 110, 31, 116, 102, 223, 172])
    const instructionHex = "8a266e1f7466dfac";
    const dataBuffer = Buffer.from(instructionHex, "hex");

    const ix = new TransactionInstruction({
        programId: DIVERSIFI_PROGRAM_ID,
        keys: [
            { pubkey: indexPda, isSigner: false, isWritable: false },
            { pubkey: dTokenMint, isSigner: false, isWritable: false },
            ...remainingAccounts,
        ],
        data: dataBuffer,
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = ADMIN_WALLET;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    // Simulate!
    const simulation = await connection.simulateTransaction(tx);
    if (simulation.value.err) {
        throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }

    const result = simulation.value;
    if (!result.returnData || !result.returnData.data) {
        throw new Error("No return data from get_vault_balances");
    }

    // Process the return data payload
    const returnDataBuffer = Buffer.from(result.returnData.data[0], "base64");
    const balances = vaultBalancesSchema.decode(returnDataBuffer) as any;

    const constituentVaults = balances.mints.map((mint: PublicKey, idx: number) => {
        const meta = vaultAccountsWithMeta.find((v) => v.mint.equals(mint));
        const atomicBalance = balances.tokenBalances[idx];
        const uiBalance = Number(atomicBalance.toString()) / Math.pow(10, meta!.decimals);

        return {
            mint,
            balance: uiBalance
        };
    });

    const dTokenSupply = Number(balances.indexSupply.toString()) / Math.pow(10, dTokenDecimals);

    return { constituentVaults, dTokenSupply };
}

export async function fetchVaultBalancesWithRPC(
    connection: Connection,
    dTokenMint: PublicKey,
    dTokenDecimals: number,
    vaultAccountsWithMeta: any[]
) {
    const constituentVaults = await Promise.all(vaultAccountsWithMeta.map(async (meta) => {
        try {
            const balanceInfo = await connection.getTokenAccountBalance(meta.pubkey);
            const uiBalance = balanceInfo.value.uiAmount || 0;
            return {
                mint: meta.mint,
                balance: uiBalance
            };
        } catch (e) {
            // Account might not exist yet if empty
            return {
                mint: meta.mint,
                balance: 0
            };
        }
    }));

    const supplyInfo = await connection.getTokenSupply(dTokenMint);
    const dTokenSupply = supplyInfo.value.uiAmount || 0;

    return { constituentVaults, dTokenSupply };
}

export async function fetchNAV(connection: Connection, dTokenMintStr: string) {
    const dTokenMint = new PublicKey(dTokenMintStr);

    console.log(`Analyzing DiversiFi dToken: ${dTokenMint.toBase58()}`);

    // 1 & 2. Derive the Index Account PDA
    const [indexPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("index"), dTokenMint.toBuffer()],
        DIVERSIFI_PROGRAM_ID
    );

    console.log(`Index PDA: ${indexPda.toBase58()}`);

    // 3. Fetch and Parse the actively configured underlying tokens
    const indexAccountInfo = await connection.getAccountInfo(indexPda);
    if (!indexAccountInfo) {
        throw new Error("Token is not a valid DiversiFi dToken: Index account does not exist.");
    }

    const decodedIndex = INDEX_ACCOUNT_LAYOUT.decode(indexAccountInfo.data);
    const activeMints = decodedIndex.mints.filter((m: any) => !m.mint.equals(PublicKey.default));

    console.log(`Found ${activeMints.length} underlying constituents.`);

    // 4. Fetch token decimals and derive Vault ATAs
    const dTokenMintInfo = await connection.getAccountInfo(dTokenMint);
    if (!dTokenMintInfo) throw new Error("dToken Mint not found");
    const dTokenDecimals = dTokenMintInfo.data[44]; // Offset 44 is the decimal byte

    const vaultAccountsWithMeta = await Promise.all(
        activeMints.map(async (oracleMint: any) => {
            const mintInfo = await connection.getAccountInfo(oracleMint.mint);
            if (!mintInfo) throw new Error(`Mint account not found: ${oracleMint.mint.toBase58()}`);

            const isToken2022 = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
            const tokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
            const decimals = mintInfo.data[44];

            return {
                pubkey: getAssociatedTokenAddressSync(oracleMint.mint, indexPda, true, tokenProgramId),
                isSigner: false,
                isWritable: false,
                mint: oracleMint.mint,
                decimals
            };
        })
    );

    // 5. Fetch balances and supply using both methods for side-by-side comparison
    const instructionData = await fetchVaultBalancesWithInstruction(
        connection,
        indexPda,
        dTokenMint,
        dTokenDecimals,
        vaultAccountsWithMeta
    );

    const rpcData = await fetchVaultBalancesWithRPC(
        connection,
        dTokenMint,
        dTokenDecimals,
        vaultAccountsWithMeta
    );

    console.log("\n--- Vault Balances Comparison ---");
    const comparisonTable = instructionData.constituentVaults.map((instVault: any) => {
        const rpcVault = rpcData.constituentVaults.find(v => v.mint.equals(instVault.mint));
        return {
            "Token Mint": instVault.mint.toBase58(),
            "Instruction Balance": instVault.balance,
            "RPC Balance": rpcVault ? rpcVault.balance : 0
        };
    });
    console.table(comparisonTable);

    console.log("\n--- Supply Comparison ---");
    console.table([
        { Method: "Instruction", "Total Supply": instructionData.dTokenSupply },
        { Method: "RPC", "Total Supply": rpcData.dTokenSupply }
    ]);

    // Use RPC data for NAV calculation
    const { constituentVaults, dTokenSupply } = rpcData;

    // 6. Demonstrate NAV / Price Calculation
    console.log("--- Pseudo-NAV Calculation ---");
    let totalBasketNAV = 0;

    // Fetch live prices from Jupiter API for accurate NAV calculation
    const mintStr = constituentVaults.map(v => v.mint.toBase58()).join(",");
    // Note: Jupiter V3 now strictly regulates rate limits/auth. Add { headers: { 'x-api-key': 'YOUR_KEY' } } if you have one.
    const fetchOptions: any = JUP_API_KEY ? { headers: { 'x-api-key': JUP_API_KEY } } : {};
    const priceResponse = await fetch(`https://api.jup.ag/price/v3?ids=${mintStr}`, fetchOptions);
    const priceData = await priceResponse.json();

    for (const vault of constituentVaults) {
        const mintId = vault.mint.toBase58();
        const livePriceStr = priceData?.[mintId]?.usdPrice;
        if (!livePriceStr || isNaN(parseFloat(livePriceStr))) {
            console.warn(`  No price available for ${mintId}, skipping`);
            continue;
        }
        const liveOraclePrice = parseFloat(livePriceStr);

        const valueUsd = vault.balance * liveOraclePrice;
        totalBasketNAV += valueUsd;
    }

    const estimatedDTokenPrice = dTokenSupply > 0 ? (totalBasketNAV / dTokenSupply) : 0;

    console.log(`Assessed Network Basket NAV: $${totalBasketNAV.toFixed(4)}`);
    console.log(`Derived dToken Price: $${estimatedDTokenPrice.toFixed(4)}`);
}

// Ensure proper execution
const isMain = typeof require !== 'undefined' && require.main === module || (typeof process !== 'undefined' && process.argv[1]?.endsWith('price_derivation.ts'));
if (isMain) {
    const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
    const connection = new Connection(RPC_URL);

    (async () => {
        try {
            console.log("\n1. Fetching all dToken Mints...");
            const allMints = await fetchAllDTokenMints(connection);
            console.log("First 3 dToken mints:");
            allMints.slice(0, 3).forEach((mint, i) => console.log(`  ${i + 1}. ${mint}`));

            console.log("\n2. Fetching NAV for a sample dToken...");
            const SAMPLE_DTOKEN = "ADdkaLqDsupDXi3qAEpuv9LXUSjA25ypcKGRseejLXaz";
            await fetchNAV(connection, SAMPLE_DTOKEN);
        } catch (e) {
            console.error(e);
        }
    })();
}
