#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pullNextGroup, submitAnnotations, markFailed } from "./db/db-layer.js";
import { runAnnotatorGroup } from "./pipeline/runner.js";

function parseArgs(argv) {
  const [, , command, ...rest] = argv;
  const args = { command, flags: {} };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    args.flags[token.slice(2)] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
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

  const group = await pullNextGroup(databaseUrl);
  if (!group) {
    process.stdout.write("No writer_done queue found.\n");
    return;
  }

  const result = await runAnnotatorGroup(group.queueRow, group.articles);
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
          comments: item.comments.length
        }))
      },
      null,
      2
    ) + "\n"
  );
}

async function main() {
  const { command, flags } = parseArgs(process.argv);
  if (command === "annotate-json") {
    if (!flags.input) {
      throw new Error("--input is required for annotate-json mode.");
    }
    await annotateJsonMode(path.resolve(flags.input), flags.output ? path.resolve(flags.output) : "");
    return;
  }

  if (command === "run-once") {
    await runOnceMode();
    return;
  }

  process.stdout.write(
    [
      "Usage:",
      "  node ./src/cli.js annotate-json --input ./fixtures/sample-payload.json [--output ./tmp/result.json]",
      "  node ./src/cli.js run-once"
    ].join("\n") + "\n"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
