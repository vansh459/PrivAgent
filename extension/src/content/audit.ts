export type AuditStage = "observe" | "detect_pii" | "redact" | "reason" | "validate" | "act";
export interface AuditEntry {
  id: string;
  stage: AuditStage;
  timestamp: string;
  detail: string;
}

const KEY = "privagent.audit.v1";

/** Stores privacy-safe stage summaries locally; callers must never pass raw values. */
export function appendAudit(
  stage: AuditStage,
  detail: string,
  storage: Storage = localStorage,
): AuditEntry {
  const entries = readAudit(storage);
  const entry = { id: crypto.randomUUID(), stage, timestamp: new Date().toISOString(), detail };
  storage.setItem(KEY, JSON.stringify([...entries, entry]));
  return entry;
}

export function readAudit(storage: Storage = localStorage): AuditEntry[] {
  try {
    return JSON.parse(storage.getItem(KEY) ?? "[]") as AuditEntry[];
  } catch {
    return [];
  }
}
