import { Client } from "pg";
import { SQL } from "./sql.js";

const REQUIRED_QUEUE_STATUSES = [
  "writer_done",
  "annotating",
  "needs_review",
  "failed",
];

function resolveMainArticleId(queueRow) {
  return (
    queueRow.main_article_id ??
    queueRow.mainArticleId ??
    queueRow.article_id ??
    queueRow.articleId ??
    null
  );
}

/**
 * Check that the connected database has the schema the Annotator expects.
 * We probe the CHECK constraint definition for content_queue.status; if
 * any of the new pipeline statuses is missing we throw immediately so
 * a misconfigured deploy fails loudly instead of silently looping on
 * "no work to do".
 */
export async function precheckSchema(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT pg_get_constraintdef(c.oid) AS defn
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'content_queue'
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ILIKE '%status%';
    `);
    const allDefns = result.rows.map((r) => r.defn).join(" ");
    const missing = REQUIRED_QUEUE_STATUSES.filter((s) => !allDefns.includes(`'${s}'`));
    if (missing.length) {
      throw new Error(
        `Schema precheck failed: content_queue.status CHECK is missing values [${missing.join(", ")}]. ` +
        "Run the planner migrations (migrate-add-pipeline-statuses, migrate-add-failure-reason) first."
      );
    }

    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'content_queue'
        AND column_name IN ('failure_reason', 'completed_at', 'started_at');
    `);
    const colsPresent = new Set(colCheck.rows.map((r) => r.column_name));
    const requiredCols = ["failure_reason", "completed_at", "started_at"];
    const missingCols = requiredCols.filter((c) => !colsPresent.has(c));
    if (missingCols.length) {
      throw new Error(
        `Schema precheck failed: content_queue missing columns [${missingCols.join(", ")}].`
      );
    }
  } finally {
    await client.end();
  }
}

export async function pullNextGroup(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const pulled = await client.query(SQL.pullNextGroup);
    if (!pulled.rows.length) {
      await client.query("ROLLBACK");
      return null;
    }

    const queueRow = pulled.rows[0];
    const mainArticleId = resolveMainArticleId(queueRow);
    if (!mainArticleId) {
      throw new Error("Queue row is missing main article id (main_article_id / article_id).");
    }

    const articles = await client.query(SQL.groupArticles, [mainArticleId]);
    await client.query("COMMIT");
    return { queueRow, articles: articles.rows };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

export async function submitAnnotations(databaseUrl, queueId, articleResults) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const result of articleResults) {
      // Skipped articles already had comments; don't touch them.
      if (result.skipped) continue;
      await client.query(
        `UPDATE articles
         SET draft_json = jsonb_set(draft_json, '{comments}', $1::jsonb),
             status = 'needs_review',
             updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(result.comments), result.articleId]
      );
    }

    await client.query(
      `UPDATE content_queue
       SET status = 'needs_review',
           updated_at = NOW()
       WHERE id = $1`,
      [queueId]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

export async function markFailed(databaseUrl, queueId, reason) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `UPDATE content_queue
       SET status = 'failed',
           failure_reason = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [queueId, String(reason).slice(0, 2000)]
    );
  } finally {
    await client.end();
  }
}

/**
 * Reset queue rows stuck in 'annotating' longer than `staleMinutes`
 * (default 60). Useful for cron operations after a crashed worker
 * leaves a queue locked. Resets to 'writer_done' so the next worker
 * can pull it again, and records a failure_reason note.
 *
 * Returns the array of reset row ids.
 */
export async function cleanupStaleAnnotating(databaseUrl, { staleMinutes = 60 } = {}) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `UPDATE content_queue
       SET status = 'writer_done',
           failure_reason = COALESCE(failure_reason, '')
             || '[annotator-stale-reset ' || NOW()::text || ']',
           updated_at = NOW()
       WHERE status = 'annotating'
         AND updated_at < NOW() - INTERVAL '1 minute' * $1
       RETURNING id`,
      [staleMinutes]
    );
    return result.rows.map((r) => r.id);
  } finally {
    await client.end();
  }
}
