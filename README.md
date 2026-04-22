# @absolutejs/absolute-rag-postgresql

PostgreSQL adapter package for AbsoluteJS RAG workflows.

This package exists at the PostgreSQL boundary, not the `pgvector` boundary.
That is deliberate: AbsoluteJS should build around the database/platform layer,
while treating vector extensions like `pgvector` as replaceable implementation
choices inside the package.

## Package role

- Package identity: PostgreSQL
- First vector implementation: `pgvector`
- Future room for other PostgreSQL-native or managed-provider vector paths

## Design principles

- AbsoluteJS owns the RAG workflow and adapter contract.
- PostgreSQL is the backend boundary.
- `pgvector` is the first implementation, not the package identity.
- Schema, extension, and index management need to be explicit and inspectable.
- Runtime diagnostics should match the SQLite adapter line as closely as possible.

## Public surface

```ts
import {
  createPostgresRAG,
  ragPlugin,
} from "@absolutejs/absolute-rag-postgresql";

const rag = createPostgresRAG({
  connectionString: process.env.DATABASE_URL,
  vector: {
    provider: "pgvector",
    dimensions: 1536,
    distanceMetric: "cosine",
    autoCreateExtension: true,
    autoCreateSchema: true,
    autoCreateTables: true,
    autoCreateIndex: true,
    index: {
      type: "hnsw",
      efSearch: 100,
      efConstruction: 64,
      m: 16,
    },
  },
  schema: {
    schemaName: "absolute_rag",
    chunkTableName: "chunks",
  },
});

app.use(
  ragPlugin({
    path: "/rag",
    collection: rag.collection,
  }),
);
```

## Package primitives

- `createPostgresRAG(...)`
  - returns the PostgreSQL RAG bundle
- `createPostgresRAGCollection(...)`
  - collection-level convenience helper
- `createPgvectorStore(...)`
  - first concrete PostgreSQL vector store implementation
- `createPostgresSchemaPlan(...)`
  - returns the SQL plan for extension/schema/table/index setup
- `createPostgresMigrationPlan(...)`
  - returns the deterministic migration ledger derived from the schema plan
- `applyPostgresMigrations(...)`
  - applies pending migrations and records them in the PostgreSQL migration table

## PostgreSQL design

### Connection boundary

The package now supports either:

- `connectionString` using the bundled `postgres` driver
- injected `client`
- injected `clientFactory`

That keeps it compatible with:

- direct Postgres clients
- pooled clients
- framework-managed DB lifecycles

### Schema boundary

The package should own a default schema layout but allow overrides:

- schema name
- chunk table name
- migration table name
- stable column naming

The initial pgvector implementation should store:

- chunk id
- chunk text
- title
- source
- metadata JSON
- embedding vector
- created/updated timestamps

### Extension boundary

The first implementation should assume the `vector` extension provided by `pgvector`.
The package should generate explicit SQL for:

- `CREATE EXTENSION IF NOT EXISTS vector`
- schema creation
- table creation
- index creation
- query-session tuning statements when configured

### Distance/index boundary

The first pgvector implementation should support:

- distance metrics:
  - `cosine`
  - `l2`
  - `inner_product`
- index types:
  - `none`
  - `hnsw`
  - `ivfflat`

The design should let users choose exact search first and add ANN indexing intentionally.

## Why not `absolute-rag-pgvector`?

Because `pgvector` is an implementation choice, not the product boundary.
If the PostgreSQL vector story changes later, AbsoluteJS should be able to keep
its public package identity stable.

## Current state

Implemented now:

- schema plan generation
- pgvector-backed store contract against the core `RAGVectorStore` interface
- PostgreSQL RAG bundle and collection helpers
- PostgreSQL status and capability reporting
- built-in `postgres` driver support for the normal `connectionString` path

Advanced override paths remain available through `client` and `clientFactory`.
