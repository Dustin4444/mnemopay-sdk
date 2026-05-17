# AUDIT-BUNDLES — EU AI Act Article 12 evidence in one call

Article 12 of the EU AI Act requires high-risk AI systems to keep automatically-generated logs for **at least 6 months** in a form a regulator can read. MnemoPay produces that archive directly from a finished FiscalGate mission — no extra logging code, no separate compliance pipeline.

`buildArticle12Bundle()` is the single entry point. It returns a set of files (mission metadata, every audit event, a Merkle digest chain, a manifest) plus a bundle-wide SHA-256 fingerprint. You write the files to disk, ship them to your regulator, and prove integrity later by re-checksumming.

---

## End-to-end example

```ts
import {
  validateCharter,
  runMission,
  MerkleAudit,
  buildArticle12Bundle,
} from "@mnemopay/sdk/governance";
import { writeFile, mkdir } from "node:fs/promises";

const charter = validateCharter({
  name: "weekly-research-digest",
  goal: "Summarize the week's AI agent news.",
  budget: { maxUsd: 5, approvalThresholdUsd: 2 },
  agents: [{ role: "research", model: "claude-sonnet-4-7" }],
  outputs: ["digest.md"],
  compliance: { article12: true },
});

const audit = new MerkleAudit();

const result = await runMission({
  charter,
  payments: yourPayments,
  agents: yourAgents,
  audit: {
    record:   (e, d) => audit.record(e, d),
    finalize: () => audit.finalize(),
  },
});

// One call. Deterministic. No filesystem I/O.
const bundle = buildArticle12Bundle({
  charter,
  result,
  audit,
  retentionMonths: 6,           // Article 12 minimum, default
  operatorId: "acme-corp-eu",
});

// Persist
await mkdir("./audit-bundles/2026-05-17", { recursive: true });
for (const f of bundle.files) {
  await writeFile(`./audit-bundles/2026-05-17/${f.path}`, f.body);
}

console.log("bundle digest:", bundle.bundleSha256);
// → a3f29c... — record this in your compliance log.
```

That's the entire compliance workflow. The mission ran, MnemoPay tracked every event in the Merkle chain, and the bundle drops out the other end with checksums.

---

## What's in the bundle

`buildArticle12Bundle()` returns an `Article12Bundle`:

```ts
interface Article12Bundle {
  files: Array<{ path: string; body: string; sha256: string }>;
  bundleSha256: string;
}
```

Five files, deterministic order:

| File             | Contents                                                            |
| ---------------- | ------------------------------------------------------------------- |
| `mission.json`   | Charter summary, mission result, retention window, legal basis      |
| `events.json`    | Every audit event in chain order                                    |
| `events.csv`     | Same events flattened for spreadsheet review                        |
| `chain.txt`      | Merkle digest sequence — one hash per line                          |
| `manifest.json`  | Per-file SHA-256 + bundle version + retention policy                |

`bundleSha256` is `sha256( sorted("path|sha256\n" for each file) )` — re-derivable at any future date.

`mission.json` includes a `retention.retainUntil` ISO timestamp computed from `retentionMonths` so your archival system knows when (or whether) the record can be deleted. The default is 6 months — Article 12's floor, not its ceiling.

---

## Verifying a bundle later

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

async function verifyBundle(dir: string, expectedDigest: string) {
  const manifest = JSON.parse(await readFile(`${dir}/manifest.json`, "utf8"));
  for (const { path, sha256 } of manifest.files) {
    const body = await readFile(`${dir}/${path}`, "utf8");
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual !== sha256) throw new Error(`tampered: ${path}`);
  }
  // Bundle-wide digest re-derivation
  const recomputed = createHash("sha256").update(
    manifest.files
      .slice()
      .sort((a: any, b: any) => a.path.localeCompare(b.path))
      .map((f: any) => `${f.path}|${f.sha256}`)
      .join("\n")
  ).digest("hex");
  if (recomputed !== expectedDigest) throw new Error("bundle digest mismatch");
}
```

The chain in `chain.txt` is the audit-side proof — every event in `events.json` re-hashes to the next entry. If anything in the run was tampered with after the fact, the chain breaks at the modified event and `MerkleAudit.verify()` catches it.

---

## Operator obligations Article 12 still owns

The bundle is **evidence**, not the obligation itself. You're still responsible for:

- **Retention**. Persist the bundle for at least `retentionMonths`. Cold storage is fine.
- **Access**. Regulators can request the bundle; have a documented process.
- **Tamper-evidence**. Store `bundleSha256` somewhere the regulator can countersign (any signed log, blockchain anchor, etc.). MnemoPay's audit chain proves the contents, not the chain-of-custody.

MnemoPay's role ends at "the bundle is regulator-handable and deterministically reproducible from the mission record." Everything downstream is your archive policy.

---

## Related

- [`FISCALGATE.md`](./FISCALGATE.md) — how the audit chain is built during a mission.
- [`src/governance/article12.ts`](../src/governance/article12.ts) — full implementation, ~140 LOC.
- [`src/governance/audit.ts`](../src/governance/audit.ts) — `MerkleAudit` class.
