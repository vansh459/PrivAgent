import { detectStructuredPii } from "../content/privacy";
import type { AuditEntry, AuditEntryInput } from "../shared/messages";

/**
 * Local audit trail, stored in IndexedDB **on the extension's own origin**.
 *
 * This module deliberately lives in the background worker. A content script's
 * `localStorage` and `indexedDB` both belong to the *visited page's* origin, so writing
 * the trail from a content script would hand every site a readable log of what the agent
 * saw and redacted on it. Storing it here keeps it inside the extension.
 */

const DATABASE_NAME = "privagent";
const DATABASE_VERSION = 1;
const STORE = "audit";

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        // An auto-increment key makes insertion order the storage order. Sorting by
        // timestamp is not sufficient: several stages routinely land in the same
        // millisecond, and ISO strings cannot separate them.
        const store = database.createObjectStore(STORE, { keyPath: "seq", autoIncrement: true });
        store.createIndex("taskId", "taskId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
  return databasePromise;
}

/**
 * Enforces Build Spec Phase 7.4 at write time rather than auditing for it afterwards.
 *
 * If a caller ever passes a raw value through by mistake, the write fails loudly instead
 * of quietly persisting PII into the trail.
 */
export function assertPrivacySafe(detail: string): void {
  const found = detectStructuredPii(detail);
  if (found.length > 0) {
    throw new Error(
      `Refusing to write audit detail containing ${found[0]?.type} - pass a summary, not a value`,
    );
  }
}

export async function appendAudit(input: AuditEntryInput): Promise<AuditEntry> {
  assertPrivacySafe(input.detail);
  const entry: AuditEntry = {
    ...input,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };

  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).add(entry);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Audit write failed"));
  });

  return entry;
}

export async function readAudit(taskId?: string): Promise<AuditEntry[]> {
  const database = await openDatabase();
  const entries = await new Promise<AuditEntry[]>((resolve, reject) => {
    const transaction = database.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as AuditEntry[]);
    request.onerror = () => reject(request.error ?? new Error("Audit read failed"));
  });

  return taskId ? entries.filter((entry) => entry.taskId === taskId) : entries;
}

/** Test seam: drops the cached connection so a fresh database can be opened. */
export function resetAuditConnection(): void {
  databasePromise = undefined;
}
