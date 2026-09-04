import { beforeEach, describe, expect, it } from "vitest";
import { appendAudit, readAudit } from "../src/content/audit";

describe("local audit trail", () => {
  beforeEach(() => localStorage.clear());
  it("records a privacy-safe pipeline stage locally", () => {
    appendAudit("redact", "1 phone token emitted");
    expect(readAudit()).toHaveLength(1);
    expect(readAudit()[0].stage).toBe("redact");
  });
});
