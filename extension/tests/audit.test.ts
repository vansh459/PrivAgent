import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendAudit,
  assertPrivacySafe,
  readAudit,
  resetAuditConnection,
} from "../src/background/audit";

/**
 * The audit trail deliberately lives in the background worker's IndexedDB. A content
 * script's storage - `localStorage` and `indexedDB` alike - belongs to the *visited
 * page's* origin, so a trail written there would be readable by every site the agent
 * runs on. These tests cover the store's behaviour; the origin guarantee itself is
 * verified in the browser (see docs/SECURITY.md).
 */
describe("audit trail", () => {
  beforeEach(async () => {
    resetAuditConnection();
    indexedDB.deleteDatabase("privagent");
  });

  it("records a privacy-safe pipeline stage", async () => {
    await appendAudit({ taskId: "t1", stage: "redact", detail: "1 phone token emitted", ok: true });
    const entries = await readAudit("t1");

    expect(entries).toHaveLength(1);
    expect(entries[0]?.stage).toBe("redact");
    expect(entries[0]?.timestamp).toBeTruthy();
  });

  it("returns entries for one task in stage order", async () => {
    for (const stage of ["observe", "detect_pii", "redact", "reason", "validate", "act"] as const) {
      await appendAudit({ taskId: "t2", stage, detail: `${stage} done`, ok: true });
    }
    await appendAudit({ taskId: "other", stage: "observe", detail: "unrelated", ok: true });

    const entries = await readAudit("t2");

    expect(entries.map((entry) => entry.stage)).toEqual([
      "observe",
      "detect_pii",
      "redact",
      "reason",
      "validate",
      "act",
    ]);
  });

  it("refuses to write a detail that contains raw PII", async () => {
    expect(() => assertPrivacySafe("redacted 9876543210")).toThrow(/PHONE/);
    await expect(
      appendAudit({ taskId: "t3", stage: "redact", detail: "value was a@b.co", ok: true }),
    ).rejects.toThrow(/EMAIL/);
  });

  it("accepts counts and statuses", () => {
    expect(() =>
      assertPrivacySafe("3 of 12 elements matched a PII detector; 2 tokens emitted"),
    ).not.toThrow();
  });
});
