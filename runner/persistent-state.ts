import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EffectRecord, EffectState, EffectTransition } from "../src/ticket/contracts.ts";
import type { AccountLeaseProvider, EffectLedgerProvider } from "./runtime.ts";

type LeasePayload = { resource_key: string; lease_id: string; fencing_token: number };
export type PersistentAccountLease = LeasePayload & { holder_id: string; acquired_at: string; expires_at: string };

function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5_000 });
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_account_lease (
      resource_key TEXT PRIMARY KEY,
      lease_id TEXT NOT NULL,
      holder_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
      acquired_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ticket_effect_record (
      effect_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      effect TEXT NOT NULL,
      semantics TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ticket_effect_transition (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      transition_id TEXT NOT NULL UNIQUE,
      effect_id TEXT NOT NULL REFERENCES ticket_effect_record(effect_id),
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_effect_transition_effect_seq
      ON ticket_effect_transition(effect_id, seq);
    CREATE TRIGGER IF NOT EXISTS ticket_effect_record_no_update
      BEFORE UPDATE ON ticket_effect_record BEGIN SELECT RAISE(ABORT, 'EFFECT_RECORD_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS ticket_effect_record_no_delete
      BEFORE DELETE ON ticket_effect_record BEGIN SELECT RAISE(ABORT, 'EFFECT_RECORD_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS ticket_effect_transition_no_update
      BEFORE UPDATE ON ticket_effect_transition BEGIN SELECT RAISE(ABORT, 'EFFECT_TRANSITION_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS ticket_effect_transition_no_delete
      BEFORE DELETE ON ticket_effect_transition BEGIN SELECT RAISE(ABORT, 'EFFECT_TRANSITION_APPEND_ONLY'); END;
  `);
  return db;
}

function encodeLease(payload: LeasePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeLease(handle: string): LeasePayload {
  try {
    const value = JSON.parse(Buffer.from(handle, "base64url").toString("utf8")) as Partial<LeasePayload>;
    if (!value.resource_key || !value.lease_id || !Number.isSafeInteger(value.fencing_token) || value.fencing_token! < 1) throw new Error();
    return value as LeasePayload;
  } catch {
    throw new Error("INVALID_ACCOUNT_LEASE_HANDLE");
  }
}

function nowMs(): number { return Date.now(); }
function iso(ms: number): string { return new Date(ms).toISOString(); }

/**
 * Durable account-submit lease for a single shared filesystem/runtime domain.
 * SQLite serializes writers across processes that open the same database file.
 * This is not a cross-host/distributed lock: multi-replica deployments must use
 * a provider-backed distributed lease before enabling consequential submit.
 */
export class SqliteAccountLeaseManager implements AccountLeaseProvider {
  private readonly db: DatabaseSync;
  private readonly holderId: string;
  private readonly leaseTtlMs: number;

  constructor(path: string, options: { holderId?: string; leaseTtlMs?: number } = {}) {
    this.db = openDatabase(path);
    this.holderId = options.holderId ?? `runner-${process.pid}-${crypto.randomUUID()}`;
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000;
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs < 1) throw new Error("INVALID_ACCOUNT_LEASE_TTL");
  }

  acquire(accountRef: string): string {
    if (!accountRef) throw new Error("ACCOUNT_REF_REQUIRED");
    const resourceKey = `12306-account:${accountRef}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT fencing_token, expires_at_ms FROM ticket_account_lease WHERE resource_key = ?").get(resourceKey) as { fencing_token: number; expires_at_ms: number } | undefined;
      const now = nowMs();
      if (current && Number(current.expires_at_ms) > now) throw new Error("BLOCKED_RESOURCE_BUSY");

      const leaseId = crypto.randomUUID();
      const fencingToken = current ? Number(current.fencing_token) + 1 : 1;
      const expiresAt = now + this.leaseTtlMs;
      this.db.prepare(`INSERT INTO ticket_account_lease(resource_key, lease_id, holder_id, fencing_token, acquired_at_ms, expires_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(resource_key) DO UPDATE SET lease_id=excluded.lease_id, holder_id=excluded.holder_id,
          fencing_token=excluded.fencing_token, acquired_at_ms=excluded.acquired_at_ms, expires_at_ms=excluded.expires_at_ms`)
        .run(resourceKey, leaseId, this.holderId, fencingToken, now, expiresAt);
      this.db.exec("COMMIT");
      return encodeLease({ resource_key: resourceKey, lease_id: leaseId, fencing_token: fencingToken });
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* original error wins */ }
      throw error;
    }
  }

  renew(handle: string): string {
    const lease = decodeLease(handle);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = nowMs();
      const expiresAt = now + this.leaseTtlMs;
      const result = this.db.prepare(`UPDATE ticket_account_lease SET expires_at_ms=?
        WHERE resource_key=? AND lease_id=? AND fencing_token=? AND holder_id=? AND expires_at_ms>?`)
        .run(expiresAt, lease.resource_key, lease.lease_id, lease.fencing_token, this.holderId, now);
      if (Number(result.changes) !== 1) throw new Error("STALE_OR_EXPIRED_ACCOUNT_LEASE");
      this.db.exec("COMMIT");
      return handle;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* original error wins */ }
      throw error;
    }
  }

  release(handle: string): void {
    const lease = decodeLease(handle);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`DELETE FROM ticket_account_lease
        WHERE resource_key=? AND lease_id=? AND fencing_token=? AND holder_id=?`)
        .run(lease.resource_key, lease.lease_id, lease.fencing_token, this.holderId);
      if (Number(result.changes) !== 1) throw new Error("STALE_ACCOUNT_LEASE");
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* original error wins */ }
      throw error;
    }
  }

  isHeld(accountRef: string): boolean {
    const row = this.db.prepare("SELECT expires_at_ms FROM ticket_account_lease WHERE resource_key=?")
      .get(`12306-account:${accountRef}`) as { expires_at_ms: number } | undefined;
    return !!row && Number(row.expires_at_ms) > nowMs();
  }

  current(accountRef: string): PersistentAccountLease | undefined {
    const row = this.db.prepare(`SELECT resource_key, lease_id, holder_id, fencing_token, acquired_at_ms, expires_at_ms
      FROM ticket_account_lease WHERE resource_key=?`).get(`12306-account:${accountRef}`) as {
        resource_key: string; lease_id: string; holder_id: string; fencing_token: number; acquired_at_ms: number; expires_at_ms: number;
      } | undefined;
    if (!row || Number(row.expires_at_ms) <= nowMs()) return undefined;
    return {
      resource_key: row.resource_key,
      lease_id: row.lease_id,
      holder_id: row.holder_id,
      fencing_token: Number(row.fencing_token),
      acquired_at: iso(Number(row.acquired_at_ms)),
      expires_at: iso(Number(row.expires_at_ms)),
    };
  }

  close() { this.db.close(); }
}

/**
 * SQLite-backed append-only effect history. Current state is derived from the
 * transition chain; effect rows and transitions are protected by DB triggers
 * against UPDATE/DELETE so a restart cannot silently rewrite prior evidence.
 */
export class SqliteEffectLedger implements EffectLedgerProvider {
  private readonly db: DatabaseSync;
  constructor(path: string) { this.db = openDatabase(path); }

  get records(): EffectRecord[] {
    const rows = this.db.prepare(`SELECT r.effect_id, r.task_id, r.effect, r.semantics, r.at,
      (SELECT t.to_state FROM ticket_effect_transition t WHERE t.effect_id=r.effect_id ORDER BY t.seq DESC LIMIT 1) AS state
      FROM ticket_effect_record r ORDER BY r.at, r.effect_id`).all() as Array<Record<string, unknown>>;
    return rows.map(row => ({
      effect_id: String(row.effect_id), task_id: String(row.task_id), effect: row.effect as EffectRecord["effect"],
      semantics: row.semantics as EffectRecord["semantics"], state: row.state as EffectState, at: String(row.at),
    }));
  }

  get transitions(): EffectTransition[] {
    const rows = this.db.prepare(`SELECT transition_id, effect_id, from_state, to_state, observed_at, reason
      FROM ticket_effect_transition ORDER BY seq`).all() as Array<Record<string, unknown>>;
    return rows.map(row => ({
      transition_id: String(row.transition_id), effect_id: String(row.effect_id),
      from_state: row.from_state as EffectState | "NONE", to_state: row.to_state as EffectState,
      observed_at: String(row.observed_at), reason: String(row.reason),
    }));
  }

  start(task_id: string, effect: EffectRecord["effect"]): EffectRecord {
    const record: EffectRecord = {
      effect_id: crypto.randomUUID(), task_id, effect,
      semantics: effect === "SUBMIT_ORDER" ? "NON_IDEMPOTENT_UNKNOWN" : "IDEMPOTENT",
      state: "STARTED", at: new Date().toISOString(),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO ticket_effect_record(effect_id, task_id, effect, semantics, at) VALUES (?, ?, ?, ?, ?)")
        .run(record.effect_id, record.task_id, record.effect, record.semantics, record.at);
      this.db.prepare(`INSERT INTO ticket_effect_transition(transition_id, effect_id, from_state, to_state, observed_at, reason)
        VALUES (?, ?, 'NONE', 'STARTED', ?, 'effect_started')`).run(crypto.randomUUID(), record.effect_id, record.at);
      this.db.exec("COMMIT");
      return { ...record };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* original error wins */ }
      throw error;
    }
  }

  transition(effect_id: string, to_state: EffectState, reason: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT to_state FROM ticket_effect_transition WHERE effect_id=? ORDER BY seq DESC LIMIT 1")
        .get(effect_id) as { to_state: EffectState } | undefined;
      if (!row) throw new Error("EFFECT_NOT_FOUND");
      this.db.prepare(`INSERT INTO ticket_effect_transition(transition_id, effect_id, from_state, to_state, observed_at, reason)
        VALUES (?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), effect_id, row.to_state, to_state, new Date().toISOString(), reason);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* original error wins */ }
      throw error;
    }
  }

  markUnknown(effect_id: string, reason = "outcome_unknown") { this.transition(effect_id, "UNKNOWN", reason); }
  markReconciling(effect_id: string, reason = "query_real_state") { this.transition(effect_id, "RECONCILING", reason); }
  complete(effect_id: string, reason = "postcondition_verified") { this.transition(effect_id, "COMPLETED", reason); }
  block(effect_id: string, reason = "effect_blocked") { this.transition(effect_id, "BLOCKED", reason); }
  close() { this.db.close(); }
}
