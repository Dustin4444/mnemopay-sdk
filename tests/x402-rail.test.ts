/**
 * X402Rail — Coinbase HTTP 402 / USDC-on-Base tests.
 *
 * No real chain, no real signer. We inject a mock signer and assert the
 * exact EIP-712 typed-data shape, the EIP-3009 authorization payload,
 * the validity window, and the hold/capture/reverse semantics.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  X402Rail,
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  ETH_MAINNET_CHAIN_ID,
  USDC_CONTRACTS,
  USDC_DECIMALS,
  buildTransferWithAuthorizationTypedData,
  usdToUsdcBaseUnits,
  newNonce,
  type X402Signer,
  type TransferWithAuthorizationTypedData,
} from "../src/rails/x402.js";

const FROM = "0xabc1230000000000000000000000000000000001";
const RECIPIENT = "0xdef4560000000000000000000000000000000002";
const ALT_RECIPIENT = "0xdef4560000000000000000000000000000000003";

function makeMockSigner(): {
  signer: X402Signer;
  calls: Array<{ method: string; args: any[] }>;
  signature: string;
} {
  const calls: Array<{ method: string; args: any[] }> = [];
  // 65-byte sig: r (32) + s (32) + v (1) — placeholder hex
  const signature = "0x" + "11".repeat(32) + "22".repeat(32) + "1c";

  const signer: X402Signer = {
    getAddress() {
      calls.push({ method: "getAddress", args: [] });
      return FROM;
    },
    async signTypedDataV4(td: TransferWithAuthorizationTypedData) {
      calls.push({ method: "signTypedDataV4", args: [td] });
      return signature;
    },
  };

  return { signer, calls, signature };
}

describe("usdToUsdcBaseUnits", () => {
  it("converts 1 USD → 1_000_000 base units", () => {
    expect(usdToUsdcBaseUnits(1)).toBe("1000000");
  });
  it("converts 0.002 USD → 2000 (sub-cent)", () => {
    expect(usdToUsdcBaseUnits(0.002)).toBe("2000");
  });
  it("rounds at 6 decimals", () => {
    expect(usdToUsdcBaseUnits(0.0000005)).toBe("1");
    expect(usdToUsdcBaseUnits(0.0000004)).toBe("0");
  });
  it("handles large values", () => {
    expect(usdToUsdcBaseUnits(10_000)).toBe("10000000000");
  });
  it("rejects NaN", () => {
    expect(() => usdToUsdcBaseUnits(NaN)).toThrow(/invalid/);
  });
  it("rejects negative", () => {
    expect(() => usdToUsdcBaseUnits(-1)).toThrow(/invalid/);
  });
});

describe("newNonce", () => {
  it("produces a 32-byte 0x-prefixed hex nonce", () => {
    const n = newNonce();
    expect(n).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("is unique across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(newNonce());
    expect(seen.size).toBe(1000);
  });
});

describe("buildTransferWithAuthorizationTypedData", () => {
  it("emits the canonical EIP-712 structure", () => {
    const td = buildTransferWithAuthorizationTypedData({
      chainId: BASE_MAINNET_CHAIN_ID,
      usdcContract: USDC_CONTRACTS[BASE_MAINNET_CHAIN_ID]!,
      from: FROM,
      to: RECIPIENT,
      value: "1000000",
      validAfter: "100",
      validBefore: "200",
      nonce: "0x" + "ab".repeat(32),
    });

    expect(td.primaryType).toBe("TransferWithAuthorization");
    expect(td.domain.name).toBe("USD Coin");
    expect(td.domain.version).toBe("2");
    expect(td.domain.chainId).toBe(8453);
    expect(td.domain.verifyingContract).toBe(USDC_CONTRACTS[BASE_MAINNET_CHAIN_ID]);
    expect(td.types.TransferWithAuthorization).toHaveLength(6);
    expect(td.message).toEqual({
      from: FROM,
      to: RECIPIENT,
      value: "1000000",
      validAfter: "100",
      validBefore: "200",
      nonce: "0x" + "ab".repeat(32),
    });
  });

  it("honors domainName + domainVersion overrides", () => {
    const td = buildTransferWithAuthorizationTypedData({
      chainId: 1,
      usdcContract: USDC_CONTRACTS[ETH_MAINNET_CHAIN_ID]!,
      from: FROM,
      to: RECIPIENT,
      value: "100",
      validAfter: "0",
      validBefore: "1",
      nonce: "0x" + "00".repeat(32),
      domainName: "Custom",
      domainVersion: "9",
    });
    expect(td.domain.name).toBe("Custom");
    expect(td.domain.version).toBe("9");
  });
});

describe("X402Rail — constructor", () => {
  it("rejects missing options", () => {
    expect(() => new X402Rail(undefined as any)).toThrow(/options/);
  });
  it("rejects missing signer", () => {
    expect(() => new X402Rail({} as any)).toThrow(/signer/);
  });
  it("rejects signer without signTypedDataV4", () => {
    expect(
      () => new X402Rail({ signer: { getAddress: () => FROM } as any }),
    ).toThrow(/signer/);
  });
  it("defaults chainId to Base mainnet", () => {
    const { signer } = makeMockSigner();
    const rail = new X402Rail({ signer });
    expect(rail.name).toBe("x402");
  });
  it("rejects unknown chainId without explicit usdcContract", () => {
    const { signer } = makeMockSigner();
    expect(
      () => new X402Rail({ signer, chainId: 999_999 }),
    ).toThrow(/USDC contract/);
  });
  it("accepts unknown chainId with explicit usdcContract", () => {
    const { signer } = makeMockSigner();
    const rail = new X402Rail({
      signer,
      chainId: 999_999,
      usdcContract: "0x" + "f".repeat(40),
    });
    expect(rail.name).toBe("x402");
  });
  it("rejects invalid defaultRecipient address", () => {
    const { signer } = makeMockSigner();
    expect(
      () => new X402Rail({ signer, defaultRecipient: "not-an-address" }),
    ).toThrow(/defaultRecipient/);
  });
  it("rejects non-positive validitySeconds", () => {
    const { signer } = makeMockSigner();
    expect(
      () => new X402Rail({ signer, validitySeconds: 0 }),
    ).toThrow(/validitySeconds/);
    expect(
      () => new X402Rail({ signer, validitySeconds: -1 }),
    ).toThrow(/validitySeconds/);
  });
});

describe("X402Rail — createHold", () => {
  let mock: ReturnType<typeof makeMockSigner>;

  beforeEach(() => {
    mock = makeMockSigner();
  });

  it("produces a signed EIP-3009 authorization", async () => {
    const rail = new X402Rail({ signer: mock.signer, defaultRecipient: RECIPIENT });
    const result = await rail.createHold(0.002, "embed_document", "agent-1");

    expect(result.status).toBe("authorized");
    expect(result.externalId).toMatch(/^[a-f0-9]{64}$/); // sha256 hex

    // signer was called once with the typed data
    const sigCalls = mock.calls.filter((c) => c.method === "signTypedDataV4");
    expect(sigCalls).toHaveLength(1);

    const td: TransferWithAuthorizationTypedData = sigCalls[0].args[0];
    expect(td.message.from).toBe(FROM);
    expect(td.message.to).toBe(RECIPIENT);
    expect(td.message.value).toBe("2000"); // 0.002 USD = 2000 base units
    expect(td.domain.chainId).toBe(BASE_MAINNET_CHAIN_ID);
    expect(td.domain.verifyingContract).toBe(USDC_CONTRACTS[BASE_MAINNET_CHAIN_ID]);

    // receipt is the JSON authorization payload
    expect(result.receiptId).toBeTruthy();
    const payload = JSON.parse(result.receiptId!);
    expect(payload.from).toBe(FROM);
    expect(payload.to).toBe(RECIPIENT);
    expect(payload.value).toBe("2000");
    expect(payload.signature).toBe(mock.signature);
    expect(payload.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("uses metadata.recipient over defaultRecipient", async () => {
    const rail = new X402Rail({ signer: mock.signer, defaultRecipient: RECIPIENT });
    const r = await rail.createHold(1, "x", "agent-1", {
      metadata: { recipient: ALT_RECIPIENT },
    });
    const payload = JSON.parse(r.receiptId!);
    expect(payload.to).toBe(ALT_RECIPIENT);
  });

  it("throws if no recipient is provided anywhere", async () => {
    const rail = new X402Rail({ signer: mock.signer });
    await expect(rail.createHold(1, "x", "agent-1")).rejects.toThrow(/recipient/);
  });

  it("throws on invalid recipient address", async () => {
    const rail = new X402Rail({ signer: mock.signer });
    await expect(
      rail.createHold(1, "x", "agent-1", { metadata: { recipient: "not-hex" } }),
    ).rejects.toThrow(/recipient/);
  });

  it("validBefore reflects custom validitySeconds", async () => {
    const rail = new X402Rail({
      signer: mock.signer,
      defaultRecipient: RECIPIENT,
      validitySeconds: 60,
    });
    const before = Math.floor(Date.now() / 1000);
    await rail.createHold(1, "x", "agent-1");
    const after = Math.floor(Date.now() / 1000);

    const td: TransferWithAuthorizationTypedData = mock.calls.find(
      (c) => c.method === "signTypedDataV4",
    )!.args[0];
    const validBefore = Number(td.message.validBefore);
    // window = 60s; validBefore = now+60. Allow +/- some test-clock slack.
    expect(validBefore).toBeGreaterThanOrEqual(before + 55);
    expect(validBefore).toBeLessThanOrEqual(after + 65);
  });

  it("metadata.validitySeconds overrides constructor default", async () => {
    const rail = new X402Rail({
      signer: mock.signer,
      defaultRecipient: RECIPIENT,
      validitySeconds: 60,
    });
    const before = Math.floor(Date.now() / 1000);
    await rail.createHold(1, "x", "agent-1", {
      metadata: { validitySeconds: 600 },
    });
    const td: TransferWithAuthorizationTypedData = mock.calls.find(
      (c) => c.method === "signTypedDataV4",
    )!.args[0];
    const validBefore = Number(td.message.validBefore);
    expect(validBefore).toBeGreaterThanOrEqual(before + 595);
  });

  it("each hold has a unique nonce", async () => {
    const rail = new X402Rail({ signer: mock.signer, defaultRecipient: RECIPIENT });
    const r1 = await rail.createHold(1, "x", "agent-1");
    const r2 = await rail.createHold(1, "x", "agent-1");
    const p1 = JSON.parse(r1.receiptId!);
    const p2 = JSON.parse(r2.receiptId!);
    expect(p1.nonce).not.toBe(p2.nonce);
    expect(r1.externalId).not.toBe(r2.externalId);
  });

  it("rejects non-positive amount", async () => {
    const rail = new X402Rail({ signer: mock.signer, defaultRecipient: RECIPIENT });
    await expect(rail.createHold(0, "x", "agent-1")).rejects.toThrow(/positive/);
    await expect(rail.createHold(-1, "x", "agent-1")).rejects.toThrow(/positive/);
  });

  it("rejects empty agentId", async () => {
    const rail = new X402Rail({ signer: mock.signer, defaultRecipient: RECIPIENT });
    await expect(rail.createHold(1, "x", "")).rejects.toThrow(/agentId/);
  });

  it("rejects bad signer signature", async () => {
    const badSigner: X402Signer = {
      getAddress: () => FROM,
      signTypedDataV4: async () => "not-hex" as any,
    };
    const rail = new X402Rail({ signer: badSigner, defaultRecipient: RECIPIENT });
    await expect(rail.createHold(1, "x", "agent-1")).rejects.toThrow(/signature/);
  });
});

describe("X402Rail — Base Sepolia (testnet)", () => {
  it("uses the testnet USDC contract", async () => {
    const { signer, calls } = makeMockSigner();
    const rail = new X402Rail({
      signer,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      defaultRecipient: RECIPIENT,
    });
    await rail.createHold(1, "x", "agent-1");
    const td: TransferWithAuthorizationTypedData = calls.find(
      (c) => c.method === "signTypedDataV4",
    )!.args[0];
    expect(td.domain.chainId).toBe(BASE_SEPOLIA_CHAIN_ID);
    expect(td.domain.verifyingContract).toBe(USDC_CONTRACTS[BASE_SEPOLIA_CHAIN_ID]);
  });
});

describe("X402Rail — capturePayment + reversePayment", () => {
  let mock: ReturnType<typeof makeMockSigner>;
  let rail: X402Rail;

  beforeEach(() => {
    mock = makeMockSigner();
    rail = new X402Rail({ signer: mock.signer, defaultRecipient: RECIPIENT });
  });

  it("capturePayment marks the hold as captured", async () => {
    const r = await rail.capturePayment("hold123", 1);
    expect(r.status).toBe("captured");
    expect(r.externalId).toBe("hold123");
  });

  it("reversePayment pre-capture returns reversed", async () => {
    const r = await rail.reversePayment("hold-not-captured", 1);
    expect(r.status).toBe("reversed");
  });

  it("reversePayment post-capture returns irreversible", async () => {
    await rail.capturePayment("hold-real", 1);
    const r = await rail.reversePayment("hold-real", 1);
    expect(r.status).toBe("irreversible");
  });

  it("capture + reverse reject empty externalId", async () => {
    await expect(rail.capturePayment("", 1)).rejects.toThrow(/externalId/);
    await expect(rail.reversePayment("", 1)).rejects.toThrow(/externalId/);
  });
});

describe("X402Rail — full authorization payload round-trip", () => {
  it("payload from receiptId can be parsed and replayed structurally", async () => {
    const { signer, signature } = makeMockSigner();
    const rail = new X402Rail({
      signer,
      defaultRecipient: RECIPIENT,
      chainId: BASE_MAINNET_CHAIN_ID,
    });
    const r = await rail.createHold(0.5, "subscription", "agent-x");
    const payload = JSON.parse(r.receiptId!);

    expect(payload).toMatchObject({
      chainId: BASE_MAINNET_CHAIN_ID,
      usdcContract: USDC_CONTRACTS[BASE_MAINNET_CHAIN_ID],
      from: FROM,
      to: RECIPIENT,
      value: "500000",
      signature,
    });
    expect(payload.validAfter).toMatch(/^\d+$/);
    expect(payload.validBefore).toMatch(/^\d+$/);
    expect(Number(payload.validBefore)).toBeGreaterThan(Number(payload.validAfter));
    expect(payload.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("X402Rail — exports + constants", () => {
  it("USDC_DECIMALS is 6", () => {
    expect(USDC_DECIMALS).toBe(6);
  });
  it("Base mainnet chainId is 8453", () => {
    expect(BASE_MAINNET_CHAIN_ID).toBe(8453);
  });
  it("Base Sepolia chainId is 84532", () => {
    expect(BASE_SEPOLIA_CHAIN_ID).toBe(84532);
  });
  it("USDC_CONTRACTS is frozen", () => {
    expect(Object.isFrozen(USDC_CONTRACTS)).toBe(true);
  });
});
