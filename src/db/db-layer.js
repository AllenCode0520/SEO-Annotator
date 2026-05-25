import { Client } from "pg";
import { SQL } from "./sql.js";

function resolveMainArticleId(queueRow) {
  return queueRow.main_article_id ?? queueRow.mainArticleId ?? queueRow.article_id ?? queueRow.articleId ?? null;
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
    await client.query("ROLLBACK");
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
    await client.query("ROLLBACK");
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
      [queueId, reason.slice(0, 2000)]
    );
  } finally {
    await client.end();
  }
}
