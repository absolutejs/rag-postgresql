import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { createPostgresRAG } from "../index.js";

const containerName = "absolute-rag-postgresql-smoke";
const port = 55432;
const image = "pgvector/pgvector:pg17";
const connectionString = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;

const run = (args, options = {}) => {
  const result = spawnSync("docker", args, {
    stdio: "pipe",
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `docker ${args.join(" ")} failed`,
    );
  }
  return result.stdout.trim();
};

const cleanup = () => {
  spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
};

try {
  cleanup();
  run([
    "run",
    "-d",
    "--name",
    containerName,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-p",
    `${port}:5432`,
    image,
  ]);

  let sql;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      sql = postgres(connectionString, { max: 1 });
      await sql`select 1`;
      break;
    } catch {
      if (sql) {
        await sql.end({ timeout: 1 }).catch(() => {});
      }
      sql = undefined;
      await delay(1000);
    }
  }

  if (!sql) {
    throw new Error("PostgreSQL container did not become ready in time");
  }

  const rag = createPostgresRAG({
    connectionString,
    driver: { max: 1 },
    vector: {
      provider: "pgvector",
      dimensions: 4,
      autoCreateExtension: true,
      autoCreateSchema: true,
      autoCreateTables: true,
      autoCreateIndex: false,
      index: { type: "none" },
    },
  });

  await rag.store.upsert({
    chunks: [
      {
        chunkId: "smoke-1",
        text: "absolutejs pgvector smoke phrase",
        title: "Smoke",
        source: "smoke.md",
        metadata: { kind: "smoke" },
        embedding: [0.1, 0.2, 0.3, 0.4],
      },
    ],
  });

  const results = await rag.store.query({
    queryVector: [0.1, 0.2, 0.3, 0.4],
    topK: 1,
    filter: { source: "smoke.md" },
  });

  if (results.length !== 1 || results[0]?.chunkId !== "smoke-1") {
    throw new Error(`Unexpected smoke results: ${JSON.stringify(results)}`);
  }

  console.log("PostgreSQL pgvector smoke test passed");
  await sql.end({ timeout: 1 });
} finally {
  cleanup();
}
