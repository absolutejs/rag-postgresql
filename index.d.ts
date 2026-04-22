import type {
  RAGBackendCapabilities,
  RAGCollection,
  RAGVectorStore,
  RAGVectorStoreStatus,
} from "@absolutejs/rag";

export declare const ABSOLUTE_POSTGRESQL_RAG_PACKAGE_NAME =
  "@absolutejs/absolute-rag-postgresql";
export declare const POSTGRESQL_RAG_IMPLEMENTATIONS: readonly ["pgvector"];
export declare const PGVECTOR_DISTANCE_METRICS: readonly [
  "cosine",
  "l2",
  "inner_product",
];
export declare const PGVECTOR_INDEX_TYPES: readonly ["none", "hnsw", "ivfflat"];

export type PostgreSQLRAGVectorImplementation = "pgvector";
export type PgvectorDistanceMetric = "cosine" | "l2" | "inner_product";
export type PgvectorIndexType = "none" | "hnsw" | "ivfflat";

export type PostgreSQLRAGClient = {
  query: <TRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{
    rows: TRow[];
    rowCount?: number;
  }>;
  transaction?: <T>(
    run: (client: PostgreSQLRAGClient) => Promise<T>,
  ) => Promise<T>;
  close?: () => Promise<void>;
};

export type PostgreSQLRAGClientFactory = () =>
  | Promise<PostgreSQLRAGClient>
  | PostgreSQLRAGClient;

export type PostgreSQLRAGSchemaConfig = {
  schemaName?: string;
  chunkTableName?: string;
  migrationTableName?: string;
};

export type PgvectorHNSWConfig = {
  type: "hnsw";
  m?: number;
  efConstruction?: number;
  efSearch?: number;
  iterativeScan?: "off" | "strict_order" | "relaxed_order";
};

export type PgvectorIVFFlatConfig = {
  type: "ivfflat";
  lists?: number;
  probes?: number;
  maxProbes?: number;
  iterativeScan?: "off" | "strict_order" | "relaxed_order";
};

export type PgvectorNoIndexConfig = {
  type: "none";
};

export type PgvectorIndexConfig =
  | PgvectorNoIndexConfig
  | PgvectorHNSWConfig
  | PgvectorIVFFlatConfig;

export type PgvectorConfig = {
  provider: "pgvector";
  dimensions: number;
  distanceMetric?: PgvectorDistanceMetric;
  extensionName?: "vector" | string;
  autoCreateExtension?: boolean;
  autoCreateSchema?: boolean;
  autoCreateTables?: boolean;
  autoCreateIndex?: boolean;
  index?: PgvectorIndexConfig;
};

export type PostgreSQLDriverOptions = {
  max?: number;
  prepare?: boolean;
  idle_timeout?: number;
  connect_timeout?: number;
  max_lifetime?: number;
  ssl?: boolean | "require" | "allow" | "prefer" | "verify-full";
};

export type PostgreSQLRAGOptions = {
  connectionString?: string;
  client?: PostgreSQLRAGClient;
  clientFactory?: PostgreSQLRAGClientFactory;
  driver?: PostgreSQLDriverOptions;
  schema?: PostgreSQLRAGSchemaConfig;
  vector: PgvectorConfig;
  embedding?: RAGVectorStore["embed"];
};

export type PostgreSQLSchemaPlan = {
  implementation: PostgreSQLRAGVectorImplementation;
  extensionSql: string[];
  schemaSql: string[];
  tableSql: string[];
  indexSql: string[];
  querySessionSql: string[];
  migrationTableQualifiedName: string;
};

export type PostgreSQLMigrationStage = "extension" | "table" | "index";

export type PostgreSQLMigrationEntry = {
  name: string;
  stage: PostgreSQLMigrationStage;
  sql: string;
};

export type PostgreSQLMigrationPlan = {
  implementation: PostgreSQLRAGVectorImplementation;
  schemaName: string;
  migrationTableName: string;
  migrationTableQualifiedName: string;
  bootstrapSql: string[];
  migrations: PostgreSQLMigrationEntry[];
  schemaPlan: PostgreSQLSchemaPlan;
};

export type PostgreSQLApplyMigrationsOptions = {
  client?: PostgreSQLRAGClient;
  dryRun?: boolean;
};

export type PostgreSQLApplyMigrationsResult = {
  migrationPlan: PostgreSQLMigrationPlan;
  appliedNames: string[];
  skippedNames: string[];
  pendingNames: string[];
  appliedCount: number;
  pendingCount: number;
  dryRun: boolean;
};

export type PostgreSQLRAG = {
  store: RAGVectorStore;
  collection: RAGCollection;
  getStatus: () => RAGVectorStoreStatus | undefined;
  getCapabilities: () => RAGBackendCapabilities | undefined;
  getSchemaPlan: () => PostgreSQLSchemaPlan;
  getMigrationPlan: () => PostgreSQLMigrationPlan;
  applyMigrations: (
    options?: PostgreSQLApplyMigrationsOptions,
  ) => Promise<PostgreSQLApplyMigrationsResult>;
};

export declare const createPostgresRAG: (
  options: PostgreSQLRAGOptions,
) => PostgreSQLRAG;
export declare const createPostgreSQLRAG: typeof createPostgresRAG;
export declare const createPostgresRAGCollection: (
  options: PostgreSQLRAGOptions,
) => RAGCollection;
export declare const createPgvectorStore: (
  options: PostgreSQLRAGOptions,
) => RAGVectorStore;
export declare const createPostgresSchemaPlan: (
  options: PostgreSQLRAGOptions,
) => PostgreSQLSchemaPlan;
export declare const createPostgresMigrationPlan: (
  options: PostgreSQLRAGOptions,
) => PostgreSQLMigrationPlan;
export declare const applyPostgresMigrations: (
  options: PostgreSQLRAGOptions,
  applyOptions?: PostgreSQLApplyMigrationsOptions,
) => Promise<PostgreSQLApplyMigrationsResult>;
export declare const applyPostgresSchemaPlan: typeof applyPostgresMigrations;
