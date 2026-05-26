#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  pullNextGroup,
  submitAnnotations,
  markFailed,
  precheckSchema,
  cleanupStaleAnnotating,
} from "./db/db-layer.js";
import { runAnnotatorGroup } from "./pipeline/runner.js";
import { shutdownBrowser } from "./utils/browser-fetch.js";

function parseArgs(argv) {
  const [, , command, ...rest] = argv;
  const args = { command, flags: {} };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    args.flags[token.slice(2)] =
      rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
  }
  return args;
}

async function annotateJsonMode(inputPath, outputPath) {
  const payload = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const result = await runAnnotatorGroup(payload.queueRow, payload.articles);
  const pretty = JSON.stringify(result, null, 2);
  if (outputPath) {
    await fs.writeFile(outputPath, pretty, "utf8");
  } else {
    process.stdout.write(`${pretty}\n`);
  }
}

async function runOnceMode() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for run-once mode.");
  }

  await precheckSchema(databaseUrl);

  const group = await pullNextGroup(databaseUrl);
  if (!group) {
    process.stdout.write("No writer_done queue found.\n");
    return;
  }

  let result;
  try {
    result = await runAnnotatorGroup(group.queueRow, group.articles);
  } catch (error) {
    await markFailed(databaseUrl, group.queueRow.id, `Annotator crashed: ${error?.message ?? error}`);
    throw error;
  }

  if (!result.ok) {
    await markFailed(databaseUrl, group.queueRow.id, result.reason);
    process.stdout.write(`${result.reason}\n`);
    return;
  }

  await submitAnnotations(databaseUrl, group.queueRow.id, result.articleResults);
  process.stdout.write(
    JSON.stringify(
      {
        queueId: group.queueRow.id,
        status: result.status,
        articles: result.articleResults.map((item) => ({
          articleId: item.articleId,
          skipped: Boolean(item.skipped),
          comments: item.comments.length,
          coverage: item.coverage
            ? { ratio: item.coverage.ratio, missing: item.coverage.missing.length }
            : null,
          groundedRatio: item.groundedRatio ?? null,
        })),
      },
      null,
      2
    ) + "\n"
  );
}

async function cleanupStaleMode(flags) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for cleanup-stale mode.");
  }
  const staleMinutes = flags.minutes ? Number(flags.minutes) : 60;
  const resetIds = await cleanupStaleAnnotating(databaseUrl, { staleMinutes });
  process.stdout.write(
    JSON.stringify({ resetCount: resetIds.length, resetIds }, null, 2) + "\n"
  );
}

async function main() {
  const { command, flags } = parseArgs(process.argv);
  try {
    if (command === "annotate-json") {
      if (!flags.input) {
        throw new Error("--input is required for annotate-json mode.");
      }
      await annotateJsonMode(
        path.resolve(flags.input),
        flags.output ? path.resolve(flags.output) : ""
      );
      return;
    }

    if (command === "run-once") {
      await runOnceMode();
      return;
    }

    if (command === "cleanup-stale") {
      await cleanupStaleMode(flags);
      return;
    }

    process.stdout.write(
      [
        "Usage:",
        "  node ./src/cli.js annotate-json --input ./fixtures/sample-payload.json [--output ./tmp/result.json]",
        "  node ./src/cli.js run-once",
        "  node ./src/cli.js cleanup-stale [--minutes 60]",
      ].join("\n") + "\n"
    );
  } finally {
    await shutdownBrowser();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
