import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { LocalRunner } from "../runner/local-runner.ts";
import { CheckpointStore } from "../runner/runtime.ts";
import { SqliteAccountLeaseManager, SqliteEffectLedger } from "../runner/persistent-state.ts";

function withTempDb(run: (path: string) => void | Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "ticket-persistent-runtime-"));
  const path = join(directory, "runtime.sqlite");
  return Promise.resolve().then(() => run(path)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("account lease excludes a second connection and fencing stays monotonic after normal release", async () => {
  await withTempDb(path => {
    const first = new SqliteAccountLeaseManager(path, { holderId: "runner-a", leaseTtlMs: 5_000 });
    const second = new SqliteAccountLeaseManager(path, { holderId: "runner-b", leaseTtlMs: 5_000 });
    try {
      const firstHandle = first.acquire("acct-1");
      assert.equal(first.current("acct-1")?.fencing_token, 1);
      assert.throws(() => second.acquire("acct-1"), /BLOCKED_RESOURCE_BUSY/);

      first.release(firstHandle);
      const secondHandle = second.acquire("acct-1");
      assert.equal(second.current("acct-1")?.fencing_token, 2);
      second.release(secondHandle);
      assert.equal(second.isHeld("acct-1"), false);
    } finally {
      first.close();
      second.close();
    }
  });
});

test("account lease survives manager restart and blocks another holder until expiry", async () => {
  await withTempDb(path => {
    const first = new SqliteAccountLeaseManager(path, { holderId: "runner-a", leaseTtlMs: 5_000 });
    first.acquire("acct-restart");
    first.close();

    const restarted = new SqliteAccountLeaseManager(path, { holderId: "runner-b", leaseTtlMs: 5_000 });
    try {
      assert.equal(restarted.isHeld("acct-restart"), true);
      assert.throws(() => restarted.acquire("acct-restart"), /BLOCKED_RESOURCE_BUSY/);
    } finally {
      restarted.close();
    }
  });
});

test("account lease excludes a separate OS process using the same durable database", async () => {
  await withTempDb(path => {
    const parent = new SqliteAccountLeaseManager(path, { holderId: "parent-process", leaseTtlMs: 5_000 });
    parent.acquire("acct-process");
    parent.close();

    const moduleUrl = pathToFileURL(resolve("runner/persistent-state.ts")).href;
    const childSource = `
      const { SqliteAccountLeaseManager } = await import(${JSON.stringify(moduleUrl)});
      const manager = new SqliteAccountLeaseManager(${JSON.stringify(path)}, { holderId: "child-process", leaseTtlMs: 5000 });
      try {
        manager.acquire("acct-process");
        console.error("unexpected-acquire");
        process.exitCode = 2;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "BLOCKED_RESOURCE_BUSY") throw error;
        console.log("BLOCKED_RESOURCE_BUSY");
      } finally {
        manager.close();
      }
    `;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", childSource], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.match(child.stdout, /BLOCKED_RESOURCE_BUSY/);
  });
});

test("expired holder cannot release a newer fenced lease", async () => {
  await withTempDb(async path => {
    // Keep a wide margin between the first immediate assertion and expiry so
    // loaded CI runners cannot let a valid lease expire before it is observed.
    const stale = new SqliteAccountLeaseManager(path, { holderId: "runner-stale", leaseTtlMs: 1_000 });
    const staleHandle = stale.acquire("acct-fence");
    assert.equal(stale.current("acct-fence")?.fencing_token, 1);

    await delay(1_200);
    const current = new SqliteAccountLeaseManager(path, { holderId: "runner-current", leaseTtlMs: 5_000 });
    try {
      const currentHandle = current.acquire("acct-fence");
      assert.equal(current.current("acct-fence")?.fencing_token, 2);
      assert.throws(() => stale.release(staleHandle), /STALE_OR_EXPIRED_ACCOUNT_LEASE/);
      assert.equal(current.current("acct-fence")?.fencing_token, 2);
      current.release(currentHandle);
    } finally {
      stale.close();
      current.close();
    }
  });
});

test("effect ledger survives restart and continues the append-only outcome-unknown chain", async () => {
  await withTempDb(path => {
    const first = new SqliteEffectLedger(path);
    const effect = first.start("task-persist", "SUBMIT_ORDER");
    assert.equal(effect.semantics, "NON_IDEMPOTENT_UNKNOWN");
    first.markUnknown(effect.effect_id, "response_lost_after_possible_apply");
    first.close();

    const second = new SqliteEffectLedger(path);
    assert.equal(second.records[0]?.state, "UNKNOWN");
    second.markReconciling(effect.effect_id, "query_real_state");
    second.complete(effect.effect_id, "pending_order_readback_verified");
    second.close();

    const third = new SqliteEffectLedger(path);
    try {
      assert.equal(third.records[0]?.state, "COMPLETED");
      assert.deepEqual(
        third.transitions.filter(item => item.effect_id === effect.effect_id).map(item => item.to_state),
        ["STARTED", "UNKNOWN", "RECONCILING", "COMPLETED"],
      );
    } finally {
      third.close();
    }
  });
});

test("effect tables reject history rewrite and legal idempotent effects still work", async () => {
  await withTempDb(path => {
    const ledger = new SqliteEffectLedger(path);
    const query = ledger.start("task-query", "QUERY");
    assert.equal(query.semantics, "IDEMPOTENT");
    ledger.complete(query.effect_id, "read_complete");
    ledger.close();

    const db = new DatabaseSync(path);
    try {
      assert.throws(
        () => db.exec("UPDATE ticket_effect_transition SET reason='tampered'"),
        /EFFECT_TRANSITION_APPEND_ONLY/,
      );
      assert.throws(
        () => db.exec("DELETE FROM ticket_effect_record"),
        /EFFECT_RECORD_APPEND_ONLY/,
      );
    } finally {
      db.close();
    }
  });
});

test("local runner accepts persistent providers without enabling submit capability", async () => {
  await withTempDb(path => {
    const accounts = new SqliteAccountLeaseManager(path, { holderId: "local-runner", leaseTtlMs: 5_000 });
    const ledger = new SqliteEffectLedger(path);
    try {
      const runner = new LocalRunner(
        "runner-persistent",
        { sessionState: async () => "READY", readPendingOrders: async () => [] },
        new CheckpointStore(),
        accounts,
        ledger,
      );
      assert.equal(runner.accounts, accounts);
      assert.equal(runner.ledger, ledger);
      assert.throws(() => runner.submitOrder(), /CAPABILITY_NOT_AVAILABLE/);
    } finally {
      accounts.close();
      ledger.close();
    }
  });
});
