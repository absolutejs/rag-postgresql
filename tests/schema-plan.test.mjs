import { describe, expect, test } from 'bun:test';
import { createPostgresMigrationPlan, createPostgresSchemaPlan } from '../index.js';

describe('createPostgresSchemaPlan', () => {
  test('builds extension, schema, table, and hnsw index SQL', () => {
    const plan = createPostgresSchemaPlan({
      vector: {
        provider: 'pgvector',
        dimensions: 1536,
        distanceMetric: 'cosine',
        autoCreateExtension: true,
        autoCreateSchema: true,
        autoCreateTables: true,
        autoCreateIndex: true,
        index: {
          type: 'hnsw',
          m: 16,
          efConstruction: 64,
          efSearch: 80
        }
      },
      schema: {
        schemaName: 'absolute_rag',
        chunkTableName: 'chunks',
        migrationTableName: 'migrations'
      }
    });

    expect(plan.implementation).toBe('pgvector');
    expect(plan.extensionSql).toEqual(['CREATE EXTENSION IF NOT EXISTS "vector"']);
    expect(plan.schemaSql).toEqual(['CREATE SCHEMA IF NOT EXISTS "absolute_rag"']);
    expect(plan.tableSql[0]).toContain('embedding VECTOR(1536)');
    expect(plan.indexSql[0]).toContain('USING hnsw');
    expect(plan.indexSql[0]).toContain('vector_cosine_ops');
    expect(plan.indexSql[0]).toContain('m = 16');
    expect(plan.querySessionSql).toContain('SET LOCAL hnsw.ef_search = 80');
    expect(plan.migrationTableQualifiedName).toBe('"absolute_rag"."migrations"');
  });

  test('supports exact search with no ANN index', () => {
    const plan = createPostgresSchemaPlan({
      vector: {
        provider: 'pgvector',
        dimensions: 24,
        index: { type: 'none' }
      }
    });

    expect(plan.indexSql).toEqual([]);
    expect(plan.querySessionSql).toEqual([]);
  });
});

describe('createPostgresMigrationPlan', () => {
  test('creates deterministic bootstrap and tracked migrations', () => {
    const plan = createPostgresMigrationPlan({
      vector: {
        provider: 'pgvector',
        dimensions: 4,
        autoCreateExtension: true,
        autoCreateSchema: true,
        autoCreateTables: true,
        autoCreateIndex: true,
        index: { type: 'none' }
      },
      schema: {
        schemaName: 'absolute_rag',
        chunkTableName: 'chunks',
        migrationTableName: 'migrations'
      }
    });

    expect(plan.bootstrapSql).toContain('CREATE SCHEMA IF NOT EXISTS "absolute_rag"');
    expect(plan.bootstrapSql).toContain(
      'CREATE TABLE IF NOT EXISTS "absolute_rag"."migrations" (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
    );
    expect(plan.migrations.length).toBeGreaterThan(0);
    expect(plan.migrations.some((entry) => entry.stage === 'extension')).toBe(true);
    expect(plan.migrations.some((entry) => entry.sql.includes('"absolute_rag"."migrations"'))).toBe(false);
    expect(plan.migrations[0]?.name).toMatch(/^01_extension_/);
  });
});
