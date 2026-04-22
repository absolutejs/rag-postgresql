import { describe, expect, test } from 'bun:test';
import {
  applyPostgresMigrations,
  createPgvectorStore,
  createPostgresRAG
} from '../index.js';

const createMockClient = () => {
  const calls = [];
  const responders = [];

  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params, kind: 'query' });
      const matched = responders.find((entry) => entry.when(sql, params));
      if (matched) {
        return matched.result(sql, params);
      }
      return { rows: [], rowCount: 0 };
    },
    async transaction(run) {
      calls.push({ sql: '-- begin transaction --', params: [], kind: 'transaction' });
      return run(client);
    }
  };

  return {
    calls,
    responders,
    client
  };
};

describe('createPgvectorStore', () => {
  test('initializes schema and upserts/query/clear through the client boundary', async () => {
    const mock = createMockClient();
    const store = createPgvectorStore({
      client: mock.client,
      vector: {
        provider: 'pgvector',
        dimensions: 4,
        distanceMetric: 'cosine',
        autoCreateExtension: true,
        autoCreateSchema: true,
        autoCreateTables: true,
        autoCreateIndex: true,
        index: { type: 'hnsw', efSearch: 50 }
      },
      schema: {
        schemaName: 'absolute_rag',
        chunkTableName: 'chunks'
      }
    });

    mock.responders.push({
      when: (sql) => sql.startsWith('SELECT name FROM "absolute_rag"."migrations"'),
      result: () => ({ rows: [], rowCount: 0 })
    });

    await store.upsert({
      chunks: [{
        chunkId: 'doc-1-0',
        text: 'hello pgvector',
        title: 'Doc 1',
        source: 'doc-1.md',
        metadata: { kind: 'seed' },
        embedding: [0.1, 0.2, 0.3, 0.4]
      }]
    });

    mock.responders.push({
      when: (sql) => sql.includes('ORDER BY distance ASC'),
      result: () => ({
        rows: [{
          chunk_id: 'doc-1-0',
          text: 'hello pgvector',
          title: 'Doc 1',
          source: 'doc-1.md',
          metadata: '{"kind":"seed"}',
          distance: 0.1
        }],
        rowCount: 1
      })
    });

    const results = await store.query({
      queryVector: [0.1, 0.2, 0.3, 0.4],
      topK: 1,
      filter: { source: 'doc-1.md', kind: 'seed' }
    });

    await store.clear?.();

    expect(results).toHaveLength(1);
    expect(results[0]?.chunkId).toBe('doc-1-0');
    expect(results[0]?.source).toBe('doc-1.md');
    expect(results[0]?.metadata).toEqual({ kind: 'seed' });
    expect(store.getCapabilities?.()).toMatchObject({
      backend: 'postgres',
      nativeVectorSearch: true,
      persistence: 'external'
    });
    expect(store.getStatus?.()).toMatchObject({
      backend: 'postgres',
      vectorMode: 'native_pgvector'
    });
    expect(mock.calls.some((entry) => entry.kind === 'transaction')).toBe(true);
    expect(mock.calls.some((entry) => entry.sql.includes('CREATE EXTENSION IF NOT EXISTS'))).toBe(true);
    expect(mock.calls.some((entry) => entry.sql.includes('INSERT INTO "absolute_rag"."migrations"'))).toBe(true);
    expect(mock.calls.some((entry) => entry.sql.includes('INSERT INTO'))).toBe(true);
    expect(mock.calls.some((entry) => entry.sql.includes('ORDER BY distance ASC'))).toBe(true);
    expect(mock.calls.some((entry) => entry.sql.includes('DELETE FROM'))).toBe(true);
  });

  test('applyPostgresMigrations reports pending vs skipped names', async () => {
    const mock = createMockClient();
    let migrationReads = 0;

    mock.responders.push({
      when: (sql) => sql.startsWith('SELECT name FROM "absolute_rag"."migrations"'),
      result: () => {
        migrationReads += 1;
        if (migrationReads === 1) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [{ name: '01_extension_001_create_extension_if_not_exists_vector' }],
          rowCount: 1
        };
      }
    });

    const first = await applyPostgresMigrations({
      client: mock.client,
      vector: {
        provider: 'pgvector',
        dimensions: 4,
        autoCreateExtension: true,
        autoCreateSchema: true,
        autoCreateTables: true,
        autoCreateIndex: false,
        index: { type: 'none' }
      }
    });

    const dryRun = await applyPostgresMigrations({
      client: mock.client,
      vector: {
        provider: 'pgvector',
        dimensions: 4,
        autoCreateExtension: true,
        autoCreateSchema: true,
        autoCreateTables: true,
        autoCreateIndex: false,
        index: { type: 'none' }
      }
    }, {
      dryRun: true
    });

    expect(first.appliedCount).toBeGreaterThan(0);
    expect(first.dryRun).toBe(false);
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.skippedNames).toContain('01_extension_001_create_extension_if_not_exists_vector');
    expect(dryRun.pendingCount).toBeGreaterThanOrEqual(0);
  });

  test('createPostgresRAG returns bundle helpers and migration plan', () => {
    const mock = createMockClient();
    const rag = createPostgresRAG({
      client: mock.client,
      vector: {
        provider: 'pgvector',
        dimensions: 8,
        index: { type: 'none' }
      }
    });

    expect(typeof rag.collection.search).toBe('function');
    expect(typeof rag.store.query).toBe('function');
    expect(rag.getCapabilities?.()).toMatchObject({ backend: 'postgres' });
    expect(rag.getSchemaPlan().implementation).toBe('pgvector');
    expect(rag.getMigrationPlan().migrations.length).toBeGreaterThan(0);
    expect(typeof rag.applyMigrations).toBe('function');
  });
});
