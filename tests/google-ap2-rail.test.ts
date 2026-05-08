/**
 * GoogleAP2Rail — tests.
 *
 * No real Google AP2 endpoint, no real signer. We inject a mock signer
 * + mock fetcher and assert: mandate validation, intent shape, signing
 * flow, pre-flight policy enforcement (cap, currency, recipient,
 * expiry), HTTP settlement payload, hold/capture/reverse semantics,
 * aggregate accounting.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  GoogleAP2Rail,
  validateMandate,
  usdToMinorUnits,
  newIntentNonce,
  newIntentId,
  type AP2Mandate,
  type AP2Signer,
  type AP2Intent,
} from "../src/rails/google-ap2.js";

const AGENT_CRED = "did:key:zStEZpzSMtTt9k2vszgvCwF4fLQQSyA15W5AQ4z3AR6Bx4eFJ5crJFbuGxKmbma4";
const PRINCIPAL_CRED = "did:web:principal.example/jeremiah";
const RECIPIENT = "merchant:acme-grocery-fpa";
const ALT_RECIPIENT = "merchant:other-store";

function futureIso(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

function validMandate(overrides?: Partial<AP2Mandate>): AP2Mandate {
  return {
    mandateId: "mnd_3f8c2a",
    agentCredential: AGENT_CRED,
    principalCredential: PRINCIPAL_CRED,
    limits: {
      maxPerTransaction: "5000", // $50
      maxAggregate: "20000", // $200
      currency: "USD",
      expiresAt: futureIso(7 * 24 * 60 * 60), // 7 days out
    },
    allowedRecipients: [RECIPIENT, ALT_RECIPIENT],
    signature: "mockprincipalsig_" + "a".repeat(40),
  };
}

function makeMockSigner(): {
  signer: AP2Signer;
  calls: Array<{ method: string; args: any[] }>;
} {
  const calls: Array<{ method: string; args: any[] }> = [];
  const signer: AP2Signer = {
    getAgentCredential() {
      calls.push({ method: "getAgentCredential", args: [] });
      return AGENT_CRED;
    },
    async signIntent(unsigned) {
      calls.push({ method: "signIntent", args: [unsigned] });
      return "agent_sig_" + "b".repeat(64);
    },
  };
  return { signer, calls };
}

function makeMockFetcher(opts?: {
  status?: number;
  body?: object;
  capture?: (url: string, init: RequestInit) => void;
}): {
  fetcher: (url: string, init: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (opts?.capture) opts.capture(url, init);
    const status = opts?.status ?? 200;
    const body = opts?.body ?? { status: "settled", settlementId: "stl_test_xyz" };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetcher, calls };
}

describe("usdToMinorUnits", () => {
  it("converts 1 USD → 100 cents", () => {
    expect(usdToMinorUnits(1)).toBe("100");
  });
  it("converts 12.50 USD → 1250", () => {
    expect(usdToMinorUnits(12.5)).toBe("1250");
  });
  it("rounds at the decimal boundary", () => {
    expect(usdToMinorUnits(0.005)).toBe("1"); // banker's would give 0; Math.round gives 1
  });
  it("handles 0", () => {
    expect(usdToMinorUnits(0)).toBe("0");
  });
  it("rejects negative + NaN", () => {
    expect(() => usdToMinorUnits(-1)).toThrow(/invalid/);
    expect(() => usdToMinorUnits(NaN)).toThrow(/invalid/);
  });
});

describe("newIntentNonce", () => {
  it("emits 32-byte 0x-prefixed hex", () => {
    expect(newIntentNonce()).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("is unique across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(newIntentNonce());
    expect(seen.size).toBe(500);
  });
});

describe("newIntentId", () => {
  it("includes mandate prefix", () => {
    const id = newIntentId("mnd_abcd1234");
    expect(id).toMatch(/^int_mnd_abcd_[0-9a-f]{24}$/);
  });
});

describe("validateMandate", () => {
  it("accepts a well-formed mandate", () => {
    expect(validateMandate(validMandate())).toEqual({ ok: true });
  });

  it("rejects null", () => {
    expect(validateMandate(null)).toEqual({ ok: false, reason: "missing-mandate-id" });
  });

  it("rejects missing fields one by one", () => {
    expect(validateMandate({ ...validMandate(), mandateId: "" } as any))
      .toEqual({ ok: false, reason: "missing-mandate-id" });
    expect(validateMandate({ ...validMandate(), agentCredential: "" } as any))
      .toEqual({ ok: false, reason: "missing-agent-credential" });
    expect(validateMandate({ ...validMandate(), principalCredential: "" } as any))
      .toEqual({ ok: false, reason: "missing-principal-credential" });
    expect(validateMandate({ ...validMandate(), signature: "" } as any))
      .toEqual({ ok: false, reason: "missing-signature" });
  });

  it("rejects bad currency", () => {
    const m = validMandate();
    m.limits.currency = "XX";
    expect(validateMandate(m)).toEqual({ ok: false, reason: "invalid-currency" });
  });

  it("rejects non-numeric caps", () => {
    const m = validMandate();
    m.limits.maxPerTransaction = "fifty";
    expect(validateMandate(m)).toEqual({ ok: false, reason: "invalid-cap" });
  });

  it("rejects malformed expiry", () => {
    const m = validMandate();
    m.limits.expiresAt = "next Tuesday";
    expect(validateMandate(m)).toEqual({ ok: false, reason: "invalid-expiry" });
  });

  it("rejects expired mandate", () => {
    const m = validMandate();
    m.limits.expiresAt = "2020-01-01T00:00:00Z";
    expect(validateMandate(m)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("GoogleAP2Rail — constructor", () => {
  it("rejects missing options", () => {
    expect(() => new GoogleAP2Rail(undefined as any)).toThrow(/options/);
  });
  it("rejects missing signer", () => {
    expect(
      () =>
        new GoogleAP2Rail({
          mandate: validMandate(),
          endpoint: "https://ap2.example",
        } as any),
    ).toThrow(/signer/);
  });
  it("rejects missing endpoint", () => {
    const { signer } = makeMockSigner();
    expect(
      () => new GoogleAP2Rail({ signer, mandate: validMandate() } as any),
    ).toThrow(/endpoint/);
  });
  it("rejects invalid mandate (caps non-numeric)", () => {
    const { signer } = makeMockSigner();
    const bad = validMandate();
    bad.limits.maxPerTransaction = "fifty";
    expect(
      () =>
        new GoogleAP2Rail({
          signer,
          mandate: bad,
          endpoint: "https://ap2.example",
        }),
    ).toThrow(/invalid-cap/);
  });
  it("rejects expired mandate", () => {
    const { signer } = makeMockSigner();
    const bad = validMandate();
    bad.limits.expiresAt = "2020-01-01T00:00:00Z";
    expect(
      () =>
        new GoogleAP2Rail({
          signer,
          mandate: bad,
          endpoint: "https://ap2.example",
        }),
    ).toThrow(/expired/);
  });
  it("rejects non-positive validitySeconds", () => {
    const { signer } = makeMockSigner();
    expect(
      () =>
        new GoogleAP2Rail({
          signer,
          mandate: validMandate(),
          endpoint: "https://ap2.example",
          validitySeconds: 0,
        }),
    ).toThrow(/validitySeconds/);
  });
});

describe("GoogleAP2Rail — createHold (intent signing)", () => {
  let mockSigner: ReturnType<typeof makeMockSigner>;
  let mockFetcher: ReturnType<typeof makeMockFetcher>;
  let rail: GoogleAP2Rail;

  beforeEach(() => {
    mockSigner = makeMockSigner();
    mockFetcher = makeMockFetcher();
    rail = new GoogleAP2Rail({
      signer: mockSigner.signer,
      mandate: validMandate(),
      endpoint: "https://ap2.example/settle",
      fetcher: mockFetcher.fetcher,
      defaultRecipient: RECIPIENT,
    });
  });

  it("signs an intent and returns externalId + receiptId", async () => {
    const r = await rail.createHold(15.0, "groceries-week-1", "agent-1");

    expect(r.status).toBe("intent_signed");
    // mandateId "mnd_3f8c2a" sliced to 8 chars → "mnd_3f8c" prefix
    expect(r.externalId).toMatch(/^int_mnd_3f8c_[0-9a-f]{24}$/);
    expect(r.receiptId).toBeTruthy();

    const sigCalls = mockSigner.calls.filter((c) => c.method === "signIntent");
    expect(sigCalls).toHaveLength(1);

    const intent: AP2Intent = JSON.parse(r.receiptId!);
    expect(intent.mandateId).toBe("mnd_3f8c2a");
    expect(intent.amount).toBe("1500"); // $15 = 1500 cents
    expect(intent.currency).toBe("USD");
    expect(intent.recipient).toBe(RECIPIENT);
    expect(intent.memo).toBe("groceries-week-1");
    expect(intent.signature).toMatch(/^agent_sig_/);
    expect(intent.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("uses metadata.recipient over defaultRecipient", async () => {
    const r = await rail.createHold(5, "x", "agent-1", {
      metadata: { recipient: ALT_RECIPIENT },
    });
    const intent: AP2Intent = JSON.parse(r.receiptId!);
    expect(intent.recipient).toBe(ALT_RECIPIENT);
  });

  it("throws if recipient not in mandate allowlist", async () => {
    await expect(
      rail.createHold(5, "x", "agent-1", {
        metadata: { recipient: "merchant:not-allowed" },
      }),
    ).rejects.toThrow(/allowlist/);
  });

  it("rejects amount over maxPerTransaction", async () => {
    // mandate maxPerTransaction = 5000 cents = $50
    await expect(rail.createHold(75, "too-big", "agent-1")).rejects.toThrow(
      /maxPerTransaction/,
    );
  });

  it("rejects amount that would exceed aggregate", async () => {
    // mandate maxAggregate = 20000 cents = $200
    await rail.createHold(50, "buy-1", "agent-1"); // $50 → 5000 cents minted
    await rail.createHold(50, "buy-2", "agent-1");
    await rail.createHold(50, "buy-3", "agent-1");
    // Fourth $50 would push aggregate to $200; 3rd brought us to $150; 4th to $200, last cent OK
    await rail.createHold(50, "buy-4", "agent-1");
    // A 5th transaction at $50 would exceed
    await expect(rail.createHold(50, "buy-5", "agent-1")).rejects.toThrow(
      /maxAggregate/,
    );
  });

  it("rejects when signer credential doesn't match mandate", async () => {
    const { signer } = makeMockSigner();
    const otherCredSigner: AP2Signer = {
      getAgentCredential: () => "did:key:wrongAgent",
      signIntent: signer.signIntent,
    };
    const r2 = new GoogleAP2Rail({
      signer: otherCredSigner,
      mandate: validMandate(),
      endpoint: "https://ap2.example/settle",
      fetcher: mockFetcher.fetcher,
      defaultRecipient: RECIPIENT,
    });
    await expect(r2.createHold(5, "x", "agent-1")).rejects.toThrow(
      /credential.*does not match/,
    );
  });

  it("rejects no-recipient", async () => {
    const r2 = new GoogleAP2Rail({
      signer: mockSigner.signer,
      mandate: validMandate(),
      endpoint: "https://ap2.example/settle",
      fetcher: mockFetcher.fetcher,
    });
    await expect(r2.createHold(5, "x", "agent-1")).rejects.toThrow(/recipient/);
  });

  it("aggregate increments per hold", async () => {
    expect(rail.getAggregateMinted()).toBe("0");
    await rail.createHold(10, "a", "agent-1");
    expect(rail.getAggregateMinted()).toBe("1000");
    await rail.createHold(5, "b", "agent-1");
    expect(rail.getAggregateMinted()).toBe("1500");
  });

  it("validBefore matches validitySeconds", async () => {
    const r2 = new GoogleAP2Rail({
      signer: mockSigner.signer,
      mandate: validMandate(),
      endpoint: "https://ap2.example/settle",
      fetcher: mockFetcher.fetcher,
      defaultRecipient: RECIPIENT,
      validitySeconds: 60,
    });
    const before = Date.now();
    const r = await r2.createHold(1, "x", "agent-1");
    const after = Date.now();
    const intent: AP2Intent = JSON.parse(r.receiptId!);
    const validBefore = Date.parse(intent.validBefore);
    expect(validBefore).toBeGreaterThanOrEqual(before + 55_000);
    expect(validBefore).toBeLessThanOrEqual(after + 65_000);
  });

  it("rejects non-positive amount", async () => {
    await expect(rail.createHold(0, "x", "agent-1")).rejects.toThrow(/positive/);
    await expect(rail.createHold(-5, "x", "agent-1")).rejects.toThrow(/positive/);
  });

  it("rejects empty agentId", async () => {
    await expect(rail.createHold(5, "x", "")).rejects.toThrow(/agentId/);
  });

  it("truncates memo to 500 chars", async () => {
    const long = "a".repeat(1000);
    const r = await rail.createHold(5, long, "agent-1");
    const intent: AP2Intent = JSON.parse(r.receiptId!);
    expect(intent.memo!.length).toBe(500);
  });
});

describe("GoogleAP2Rail — capturePayment (HTTP settlement)", () => {
  let mockSigner: ReturnType<typeof makeMockSigner>;
  let mockFetcher: ReturnType<typeof makeMockFetcher>;
  let rail: GoogleAP2Rail;

  beforeEach(() => {
    mockSigner = makeMockSigner();
    mockFetcher = makeMockFetcher();
    rail = new GoogleAP2Rail({
      signer: mockSigner.signer,
      mandate: validMandate(),
      endpoint: "https://ap2.example/settle",
      fetcher: mockFetcher.fetcher,
      defaultRecipient: RECIPIENT,
    });
  });

  it("POSTs mandate + intentId to the AP2 endpoint", async () => {
    const r = await rail.createHold(10, "x", "agent-1");
    const cap = await rail.capturePayment(r.externalId, 10);

    expect(cap.status).toBe("settled");
    expect(cap.receiptId).toBe("stl_test_xyz");

    expect(mockFetcher.calls).toHaveLength(1);
    expect(mockFetcher.calls[0].url).toBe("https://ap2.example/settle");
    expect(mockFetcher.calls[0].init.method).toBe("POST");
    const headers = mockFetcher.calls[0].init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-ap2-version"]).toBe("0.2");

    const body = JSON.parse(mockFetcher.calls[0].init.body as string);
    expect(body.mandate.mandateId).toBe("mnd_3f8c2a");
    expect(body.intentId).toBe(r.externalId);
  });

  it("idempotent: re-capturing the same hold returns captured", async () => {
    const r = await rail.createHold(10, "x", "agent-1");
    await rail.capturePayment(r.externalId, 10);
    const cap2 = await rail.capturePayment(r.externalId, 10);
    expect(cap2.status).toBe("captured");
    // Only the first call hit the network.
    expect(mockFetcher.calls).toHaveLength(1);
  });

  it("throws if hold not found on this rail", async () => {
    await expect(rail.capturePayment("int_unknown_xyz", 10)).rejects.toThrow(
      /not found/,
    );
  });

  it("surfaces non-2xx status from the AP2 endpoint", async () => {
    const fetcher = makeMockFetcher({ status: 422, body: { status: "rejected" } });
    const r2 = new GoogleAP2Rail({
      signer: mockSigner.signer,
      mandate: validMandate(),
      endpoint: "https://ap2.example/settle",
      fetcher: fetcher.fetcher,
      defaultRecipient: RECIPIENT,
    });
    const r = await r2.createHold(10, "x", "agent-1");
    const cap = await r2.capturePayment(r.externalId, 10);
    expect(cap.status).toBe("rejected");
  });

  it("rejects empty externalId", async () => {
    await expect(rail.capturePayment("", 10)).rejects.toThrow(/externalId/);
  });
});

describe("GoogleAP2Rail — reversePayment", () => {
  let mockSigner: ReturnType<typeof makeMockSigner>;
  let mockFetcher: ReturnType<typeof makeMockFetcher>;
  let rail: GoogleAP2Rail;

  beforeEach(() => {
    mockSigner = makeMockSigner();
    mockFetcher = makeMockFetcher();
    rail = new GoogleAP2Rail({
      signer: mockSigner.signer,
      mandate: validMandate(),
      endpoint: "https://ap2.example/settle",
      fetcher: mockFetcher.fetcher,
      defaultRecipient: RECIPIENT,
    });
  });

  it("pre-capture returns reversed AND frees up aggregate", async () => {
    const r = await rail.createHold(50, "x", "agent-1");
    expect(rail.getAggregateMinted()).toBe("5000");
    const rev = await rail.reversePayment(r.externalId, 50);
    expect(rev.status).toBe("reversed");
    // aggregate should be freed
    expect(rail.getAggregateMinted()).toBe("0");
  });

  it("post-capture returns irreversible", async () => {
    const r = await rail.createHold(10, "x", "agent-1");
    await rail.capturePayment(r.externalId, 10);
    const rev = await rail.reversePayment(r.externalId, 10);
    expect(rev.status).toBe("irreversible");
  });

  it("rejects empty externalId", async () => {
    await expect(rail.reversePayment("", 10)).rejects.toThrow(/externalId/);
  });
});
