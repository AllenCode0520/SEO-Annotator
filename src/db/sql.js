export const SQL = {
  pullNextGroup: `
WITH next_q AS (
  SELECT id
  FROM content_queue
  WHERE status = 'writer_done'
  ORDER BY completed_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE content_queue
SET status = 'annotating', updated_at = NOW()
WHERE id IN (SELECT id FROM next_q)
RETURNING *;
`,
  groupArticles: `
SELECT a.id, a.title, a.slug, a.content_tier, a.target_reader,
       a.draft_json, a.meta_description, a.status,
       a.journey_stage_id,
       (a.id = $1) AS is_main
FROM articles a
WHERE a.id = $1
   OR EXISTS (
     SELECT 1 FROM article_links al
     WHERE al.source_id = a.id
       AND al.target_id = $1
       AND al.link_type = 'satellite_of'
       AND al.status != 'rejected'
   )
ORDER BY (a.id = $1) DESC, a.created_at ASC;
`
};
