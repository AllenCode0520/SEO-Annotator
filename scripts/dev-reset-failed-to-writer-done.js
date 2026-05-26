#!/usr/bin/env node
/**
 * DEV-ONLY UTILITY — DO NOT USE IN PRODUCTION
 *
 * For local re-runs of the Annotator against the same queue group:
 *
 *   node --env-file=.env scripts/dev-reset-failed-to-writer-done.js [--id <uuid>]
 *
 * Flips a content_queue row from status='failed' back to 'writer_done'
 * so the Annotator's pull_next_group can pick it up again. Clears
 * failure_reason in the process so the UI doesn't keep showing it.
 *
 * - With --id: targets that specific row.
 * - Without:   resets the single most-recently-failed row (if exactly
 *              one exists). Multiple → it errors out so you don't
 *              accidentally bulk-revive.
 *
 * Real production reset for a failed row should go through the planner
 * UI's "重置回 approved" button (which sends it back to Writer Robot),
 * not this script.
 */
import { Client } from "pg";

const args = process.argv.slice(2);
const idIndex = args.indexOf("--id");
const wantedId = idIndex >= 0 ? args[idIndex + 1] : null;

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  let row;
  if (wantedId) {
    const r = await client.query(
      "SELECT id, status, failure_reason FROM content_queue WHERE id = $1",
      [wantedId]
    );
    if (!r.rows.length) {
      console.error(`Queue ${wantedId} not found.`);
      process.exit(1);
    }
    row = r.rows[0];
  } else {
    const r = await client.query(
      "SELECT id, status, failure_reason FROM content_queue WHERE status = 'failed' ORDER BY updated_at DESC"
    );
    if (r.rows.length === 0) {
      console.log("No failed rows.");
      process.exit(0);
    }
    if (r.rows.length > 1) {
      console.error(`Multiple failed rows (${r.rows.length}). Use --id <uuid> to pick one:`);
      for (const item of r.rows) console.error(`  ${item.id}  (${item.failure_reason?.slice(0, 80) ?? ""})`);
      process.exit(1);
    }
    row = r.rows[0];
  }

  if (row.status !== "failed") {
    console.error(`Queue ${row.id} is currently '${row.status}', not 'failed'. Refusing to reset.`);
    process.exit(1);
  }

  await client.query(
    `UPDATE content_queue
     SET status = 'writer_done',
         failure_reason = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [row.id]
  );

  console.log(JSON.stringify({ ok: true, resetId: row.id, previousReason: row.failure_reason }, null, 2));
} finally {
  await client.end();
}
