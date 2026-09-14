/**
 * Staleness guard for the passive NAV read (README Section 8.3).
 *
 * Uses a real mainnet OracleQuote account captured in fixtures/stale_quote_account.json.
 * Its last write was in June 2026, so the guard must reject it.
 *
 *   npx tsx oracle_nav_read.test.ts
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import {
    DEFAULT_MAX_AGE_SLOTS,
    StaleQuoteError,
    assertQuoteFresh,
    decodeOracleQuoteRecentSlot,
    decodeOracleQuoteValue,
} from "./oracle_nav_read";

const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "stale_quote_account.json"), "utf8"),
);
const data = Buffer.from(fixture.dataBase64, "base64");
const recentSlot = BigInt(fixture.expectedRecentSlot);

let failures = 0;
function test(name: string, fn: () => void) {
    try {
        fn();
        console.log(`ok   ${name}`);
    } catch (e: any) {
        failures++;
        console.error(`FAIL ${name}\n     ${e.message}`);
    }
}

test("reads recent_slot from a real quote account", () => {
    assert.strictEqual(decodeOracleQuoteRecentSlot(data), recentSlot);
});

test("still decodes the NAV value from the same account", () => {
    const nav = decodeOracleQuoteValue(data, fixture.feedId);
    assert.ok(Number.isFinite(nav) && nav > 0, `unexpected NAV ${nav}`);
});

test("rejects the captured account as stale at the slot it was captured", () => {
    assert.throws(() => assertQuoteFresh(data, fixture.capturedAtSlot), StaleQuoteError);
});

test("rejects a quote one slot past the limit", () => {
    assert.throws(
        () => assertQuoteFresh(data, recentSlot + BigInt(DEFAULT_MAX_AGE_SLOTS) + 1n),
        StaleQuoteError,
    );
});

test("accepts a quote inside the limit and reports its age", () => {
    assert.strictEqual(assertQuoteFresh(data, recentSlot + 100n), 100n);
    assert.strictEqual(assertQuoteFresh(data, recentSlot + BigInt(DEFAULT_MAX_AGE_SLOTS)), BigInt(DEFAULT_MAX_AGE_SLOTS));
});

test("honours a caller-supplied limit", () => {
    assert.throws(() => assertQuoteFresh(data, recentSlot + 151n, 150), StaleQuoteError);
    assert.strictEqual(assertQuoteFresh(data, recentSlot + 150n, 150), 150n);
});

test("treats a quote newer than the observed slot (RPC lag) as age 0", () => {
    assert.strictEqual(assertQuoteFresh(data, recentSlot - 5n), 0n);
});

test("rejects data that is not a quote account", () => {
    const wrong = Buffer.from(data);
    wrong.write("NOTQUOTE", 0);
    assert.throws(() => decodeOracleQuoteRecentSlot(wrong), /Not a canonical OracleQuote account/);
    assert.throws(() => decodeOracleQuoteRecentSlot(data.subarray(0, 30)), /Not a canonical OracleQuote account/);
});

test("rejects a quote whose end marker is missing", () => {
    const broken = Buffer.from(data);
    const end = 42 + broken.readUInt16LE(40);
    broken.fill(0, end - 4, end);
    assert.throws(() => decodeOracleQuoteRecentSlot(broken), /malformed/);
});

if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
}
console.log("\nall staleness tests passed");
