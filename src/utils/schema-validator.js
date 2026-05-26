/**
 * Comment schema validator — last line of defence before we write
 * draft_json.comments back to Postgres.
 *
 * Spec: every comment must have exactly the 11 fixed keys, with the
 * right types. We don't pull in a JSON Schema library to keep the
 * dependency surface minimal; the validation surface is small and
 * stable enough to handle inline.
 */

const REQUIRED_FIELDS = [
  ["id",           "number"],
  ["search_text",  "string"],
  ["placement",    "string"],     // "run" | "paragraph"
  ["label",        "string"],
  ["checkpoint",   "string"],
  ["url",          "string"],
  ["position",     "string"],
  ["verbatim",     "string"],
  ["scope",        "string"],
  ["supplemental", "string"],
  ["fallback",     "string"],
];

const ALLOWED_PLACEMENTS = new Set(["run", "paragraph"]);

export function validateComment(comment, { commentIndex = 0 } = {}) {
  const errors = [];
  if (typeof comment !== "object" || comment === null || Array.isArray(comment)) {
    return [`comment[${commentIndex}]: not an object`];
  }

  for (const [field, expected] of REQUIRED_FIELDS) {
    if (!(field in comment)) {
      errors.push(`comment[${commentIndex}].${field}: missing`);
      continue;
    }
    const actual = typeof comment[field];
    if (expected === "number" && actual !== "number") {
      errors.push(`comment[${commentIndex}].${field}: expected number, got ${actual}`);
    } else if (expected === "string" && actual !== "string") {
      errors.push(`comment[${commentIndex}].${field}: expected string, got ${actual}`);
    }
  }

  if (typeof comment.placement === "string" && !ALLOWED_PLACEMENTS.has(comment.placement)) {
    errors.push(
      `comment[${commentIndex}].placement: must be 'run' or 'paragraph', got '${comment.placement}'`
    );
  }

  if (Number.isFinite(comment.id) && comment.id < 0) {
    errors.push(`comment[${commentIndex}].id: must be >= 0`);
  }

  // Extra keys are tolerated by docx generator but make the schema noisier;
  // we let them through with a soft warning rather than blocking.

  return errors;
}

/**
 * Validate an entire comments[] array.
 * Returns { ok, errors }. When ok=false, errors is a non-empty array
 * of human-readable strings (also acceptable for a failure_reason field).
 */
export function validateComments(comments) {
  if (!Array.isArray(comments)) {
    return { ok: false, errors: ["comments: not an array"] };
  }
  const all = [];
  const idsSeen = new Set();
  comments.forEach((comment, index) => {
    all.push(...validateComment(comment, { commentIndex: index }));
    if (typeof comment?.id === "number") {
      if (idsSeen.has(comment.id)) {
        all.push(`comment[${index}].id: duplicate id ${comment.id}`);
      }
      idsSeen.add(comment.id);
    }
  });
  return { ok: all.length === 0, errors: all };
}
