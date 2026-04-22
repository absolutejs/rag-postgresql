import {
  createRAGCollection,
  createRAGVector,
  normalizeVector
} from '@absolutejs/absolute/ai';

export const ABSOLUTE_POSTGRESQL_RAG_PACKAGE_NAME = '@absolutejs/absolute-rag-postgresql';

export const POSTGRESQL_RAG_IMPLEMENTATIONS = ['pgvector'];
export const PGVECTOR_DISTANCE_METRICS = ['cosine', 'l2', 'inner_product'];
export const PGVECTOR_INDEX_TYPES = ['none', 'hnsw', 'ivfflat'];

const DEFAULT_SCHEMA_NAME = 'absolute_rag';
const DEFAULT_CHUNK_TABLE_NAME = 'chunks';
const DEFAULT_MIGRATION_TABLE_NAME = 'migrations';
const DEFAULT_DIMENSIONS = 1536;

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const assertIdentifier = (value, label) => {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) {
    throw new Error(`${ABSOLUTE_POSTGRESQL_RAG_PACKAGE_NAME}: invalid ${label} "${value}"`);
  }
};

const quoteIdentifier = (value) => {
  assertIdentifier(value, 'identifier');
  return `"${value}"`;
};

const qualifiedTable = (schemaName, tableName) =>
  `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;

const escapeLiteral = (value) => value.replace(/'/g, "''");

const vectorLiteral = (vector) => {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(`${ABSOLUTE_POSTGRESQL_RAG_PACKAGE_NAME}: vector values must be a non-empty array`);
  }

  return `[${vector.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${ABSOLUTE_POSTGRESQL_RAG_PACKAGE_NAME}: vector values must be finite numbers`);
    }

    return String(value);
  }).join(',')}]`;
};

const makePlaceholder = (params, value, cast = '') => {
  params.push(value);
  const suffix = cast ? `::${cast}` : '';
  return `$${params.length}${suffix}`;
};

const normalizeMetric = (metric) => {
  if (metric === 'l2' || metric === 'inner_product') {
    return metric;
  }

  return 'cosine';
};

const normalizeIndex = (index) => {
  if (!index || index.type === undefined) {
    return { type: 'none' };
  }

  if (index.type === 'hnsw' || index.type === 'ivfflat' || index.type === 'none') {
    return index;
  }

  throw new Error(`${ABSOLUTE_POSTGRESQL_RAG_PACKAGE_NAME}: unsupported pgvector index type "${index.type}"`);
};

const resolveSchemaConfig = (options) => {
  const schemaName = options.schema?.schemaName ?? DEFAULT_SCHEMA_NAME;
  const chunkTableName = options.schema?.chunkTableName ?? DEFAULT_CHUNK_TABLE_NAME;
  const migrationTableName = options.schema?.migrationTableName ?? DEFAULT_MIGRATION_TABLE_NAME;

  assertIdentifier(schemaName, 'schema name');
  assertIdentifier(chunkTableName, 'chunk table name');
  assertIdentifier(migrationTableName, 'migration table name');

  return {
    schemaName,
    chunkTableName,
    migrationTableName
  };
};

const resolveVectorConfig = (options) => {
  const vector = options?.vector;

  if (!vector || vector.provider !== 'pgvector') {
    throw new Error(
      `${ABSOLUTE_POSTGRESQL_RAG_PACKAGE_NAME}: PostgreSQL RAG currently requires vector.provider = "pgvector"`
    );
  }

  const dimensions = vector.dimensions ?? DEFAULT_DIMENSIONS;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`${ABSOLUTE_POSTGRESQL_RAG_PACKAGE_NAME}: dimensions must be a positive integer`);
  }

  const distanceMetric = normalizeMetric(vector.distanceMetric);
  const index = normalizeIndex(vector.index);

  return {
    ...vector,
    dimensions,
    distanceMetric,
    extensionName: vector.extensionName ?? 'vector',
    index
  };
};

const operatorForMetric = (distanceMetric) => {
  switch (distanceMetric) {
    case 'l2':
      return '<->';
    case 'inner_product':
      return '<#>';
    case 'cosine':
    default:
      return '<=>';
  }
};

const operatorClassForMetric = (distanceMetric) => {
  switch (distanceMetric) {
    case 'l2':
      return 'vector_l2_ops';
    case 'inner_product':
      return 'vector_ip_ops';
    case 'cosine':
    default:
      return 'vector_cosine_ops';
  }
};

const scoreFromDistance = (distance, distanceMetric) => {
  if (typeof distance !== 'number' || !Number.isFinite(distance)) {
    return 0;
  }

  switch (distanceMetric) {
    case 'inner_product':
      return -distance;
    case 'l2':
      return 1 / (1 + Math.abs(distance));
    case 'cosine':
    default:
      return 1 - distance;
  }
};

const createIndexSql = ({ schemaName, chunkTableName, distanceMetric, index }) => {
  if (!index || index.type === 'none') {
    return [];
  }

  const qualifiedChunkTable = qualifiedTable(schemaName, chunkTableName);
  const opClass = operatorClassForMetric(distanceMetric);
  const indexName = `${chunkTableName}_embedding_${index.type}_${distanceMetric}_idx`;
  const withParts = [];

  if (index.type === 'hnsw') {
    if (Number.isInteger(index.m) && index.m > 0) {
      withParts.push(`m = ${index.m}`);
    }
    if (Number.isInteger(index.efConstruction) && index.efConstruction > 0) {
      withParts.push(`ef_construction = ${index.efConstruction}`);
    }
  }

  if (index.type === 'ivfflat' && Number.isInteger(index.lists) && index.lists > 0) {
    withParts.push(`lists = ${index.lists}`);
  }

  const withClause = withParts.length > 0 ? ` WITH (${withParts.join(', ')})` : '';

  return [
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${qualifiedChunkTable} USING ${index.type} (embedding ${opClass})${withClause}`
  ];
};

const createQuerySessionSql = ({ index }) => {
  if (!index || index.type === 'none') {
    return [];
  }

  const sql = [];

  if (index.type === 'hnsw') {
    if (Number.isInteger(index.efSearch) && index.efSearch > 0) {
      sql.push(`SET LOCAL hnsw.ef_search = ${index.efSearch}`);
    }
    if (index.iterativeScan && index.iterativeScan !== 'off') {
      sql.push(`SET LOCAL hnsw.iterative_scan = '${escapeLiteral(index.iterativeScan)}'`);
    }
  }

  if (index.type === 'ivfflat') {
    if (Number.isInteger(index.probes) && index.probes > 0) {
      sql.push(`SET LOCAL ivfflat.probes = ${index.probes}`);
    }
    if (Number.isInteger(index.maxProbes) && index.maxProbes > 0) {
      sql.push(`SET LOCAL ivfflat.max_probes = ${index.maxProbes}`);
    }
    if (index.iterativeScan && index.iterativeScan !== 'off') {
      sql.push(`SET LOCAL ivfflat.iterative_scan = '${escapeLiteral(index.iterativeScan)}'`);
    }
  }

  return sql;
};

const stageOrder = ['extension', 'schema', 'table', 'index'];

const buildMigrationName = (stage, stageIndex, sql) => {
  const normalized = sql
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'statement';
  const globalOrder = String(stageOrder.indexOf(stage) + 1).padStart(2, '0');
  const localOrder = String(stageIndex + 1).padStart(3, '0');
  return `${globalOrder}_${stage}_${localOrder}_${normalized}`;
};

const createMigrationTableSql = (schemaName, migrationTableName) =>
  `CREATE TABLE IF NOT EXISTS ${qualifiedTable(schemaName, migrationTableName)} (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;

const filterTrackedTableSql = (tableSql, schemaName, migrationTableName) => {
  const migrationTableTarget = qualifiedTable(schemaName, migrationTableName);
  return tableSql.filter((sql) => !sql.includes(migrationTableTarget));
};

export const createPostgresSchemaPlan = (options) => {
  const schema = resolveSchemaConfig(options ?? {});
  const vector = resolveVectorConfig(options ?? {});
  const qualifiedChunkTable = qualifiedTable(schema.schemaName, schema.chunkTableName);
  const qualifiedMigrationTable = qualifiedTable(schema.schemaName, schema.migrationTableName);

  const extensionSql = vector.autoCreateExtension === false
    ? []
    : [`CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(vector.extensionName)}`];

  const schemaSql = vector.autoCreateSchema === false
    ? []
    : [`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema.schemaName)}`];

  const tableSql = vector.autoCreateTables === false
    ? []
    : [
        `CREATE TABLE IF NOT EXISTS ${qualifiedChunkTable} (id BIGSERIAL PRIMARY KEY, chunk_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, title TEXT, source TEXT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, embedding VECTOR(${vector.dimensions}) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
        `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${schema.chunkTableName}_chunk_id_idx`)} ON ${qualifiedChunkTable} (chunk_id)`,
        `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${schema.chunkTableName}_source_idx`)} ON ${qualifiedChunkTable} (source)`,
        `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${schema.chunkTableName}_metadata_idx`)} ON ${qualifiedChunkTable} USING GIN (metadata)`,
        createMigrationTableSql(schema.schemaName, schema.migrationTableName)
      ];

  const indexSql = vector.autoCreateIndex === false
    ? []
    : createIndexSql({
        schemaName: schema.schemaName,
        chunkTableName: schema.chunkTableName,
        distanceMetric: vector.distanceMetric,
        index: vector.index
      });

  return {
    implementation: 'pgvector',
    extensionSql,
    schemaSql,
    tableSql,
    indexSql,
    querySessionSql: createQuerySessionSql({ index: vector.index }),
    migrationTableQualifiedName: qualifiedMigrationTable
  };
};

export const createPostgresMigrationPlan = (options) => {
  const schema = resolveSchemaConfig(options ?? {});
  const schemaPlan = createPostgresSchemaPlan(options ?? {});
  const bootstrapSql = [];

  if (schemaPlan.schemaSql.length > 0) {
    bootstrapSql.push(...schemaPlan.schemaSql);
  }

  const migrationTableSql = createMigrationTableSql(schema.schemaName, schema.migrationTableName);
  if (!bootstrapSql.includes(migrationTableSql)) {
    bootstrapSql.push(migrationTableSql);
  }

  const migrations = [
    ...schemaPlan.extensionSql.map((sql, index) => ({ stage: 'extension', sql, stageIndex: index })),
    ...filterTrackedTableSql(schemaPlan.tableSql, schema.schemaName, schema.migrationTableName)
      .map((sql, index) => ({ stage: 'table', sql, stageIndex: index })),
    ...schemaPlan.indexSql.map((sql, index) => ({ stage: 'index', sql, stageIndex: index }))
  ].map((entry) => ({
    name: buildMigrationName(entry.stage, entry.stageIndex, entry.sql),
    stage: entry.stage,
    sql: entry.sql
  }));

  return {
    implementation: schemaPlan.implementation,
    schemaName: schema.schemaName,
    migrationTableName: schema.migrationTableName,
    migrationTableQualifiedName: qualifiedTable(schema.schemaName, schema.migrationTableName),
    bootstrapSql,
    migrations,
    schemaPlan
  };
};

const createWrappedPostgresClient = (sql, rootSql = sql) => ({
  query: async (queryText, params = []) => {
    const rows = await sql.unsafe(queryText, params);
    return {
      rows,
      rowCount: typeof rows.count === 'number' ? rows.count : rows.length
    };
  },
  transaction: async (run) =>
    rootSql.begin(async (transactionSql) => run(createWrappedPostgresClient(transactionSql, transactionSql))),
  close: async () => {
    if (typeof rootSql.end === 'function') {
      await rootSql.end({ timeout: 5 });
    }
  }
});

const createDefaultPostgresClientFactory = (options) => {
  const connectionString = typeof options.connectionString === 'string' ? options.connectionString.trim() : '';

  if (connectionString.length === 0) {
    return undefined;
  }

  let clientPromise;

  return async () => {
    if (!clientPromise) {
      clientPromise = (async () => {
        const postgresModule = await import('postgres');
        const postgres = postgresModule.default;
        const sql = postgres(connectionString, {
          onnotice: () => {},
          ...(options.driver ?? {})
        });
        return createWrappedPostgresClient(sql, sql);
      })();
    }

    return clientPromise;
  };
};

const resolveClientFactory = (options) => {
  if (typeof options.clientFactory === 'function') {
    return async () => options.clientFactory();
  }

  if (options.client) {
    return async () => options.client;
  }

  const defaultFactory = createDefaultPostgresClientFactory(options);
  if (defaultFactory) {
    return defaultFactory;
  }

  return async () => {
    throw new Error(
      `${ABSOLUTE_POSTGRESQL_RAG_PACKAGE_NAME}: createPostgresRAG requires connectionString, client, or clientFactory.`
    );
  };
};

const buildMetadataFilter = (filter) => {
  if (!filter) {
    return undefined;
  }

  const metadataEntries = Object.entries(filter).filter(([key]) =>
    key !== 'chunkId' && key !== 'title' && key !== 'source'
  );

  if (metadataEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(metadataEntries);
};

const parseMetadataValue = (value) => {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      return undefined;
    }
  }

  if (typeof value === "object") {
    return value;
  }

  return undefined;
};

const createPgvectorStoreStatus = ({ vector, schema, diagnostics, initialized }) => ({
  backend: 'postgres',
  vectorMode: 'native_pgvector',
  dimensions: vector.dimensions,
  native: {
    requested: true,
    available: initialized && !diagnostics.lastInitError,
    active: initialized && !diagnostics.lastInitError,
    mode: 'pgvector',
    extensionName: vector.extensionName,
    schemaName: schema.schemaName,
    tableName: schema.chunkTableName,
    distanceMetric: vector.distanceMetric,
    indexType: vector.index.type,
    fallbackReason: diagnostics.fallbackReason,
    lastInitError: diagnostics.lastInitError,
    lastQueryError: diagnostics.lastQueryError,
    lastUpsertError: diagnostics.lastUpsertError,
    lastMigrationError: diagnostics.lastMigrationError
  }
});

const getAppliedMigrationNames = async (client, migrationPlan) => {
  const result = await client.query(`SELECT name FROM ${migrationPlan.migrationTableQualifiedName} ORDER BY name ASC`);
  return new Set(result.rows.map((row) => String(row.name)));
};

const insertAppliedMigration = async (client, migrationPlan, name) => {
  await client.query(
    `INSERT INTO ${migrationPlan.migrationTableQualifiedName} (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
    [name]
  );
};

const executeMigrationSequence = async (client, migrationPlan, migrations) => {
  const appliedNames = [];

  for (const migration of migrations) {
    await client.query(migration.sql);
    await insertAppliedMigration(client, migrationPlan, migration.name);
    appliedNames.push(migration.name);
  }

  return appliedNames;
};

export const applyPostgresMigrations = async (options, applyOptions = {}) => {
  const migrationPlan = createPostgresMigrationPlan(options ?? {});
  const getClient = applyOptions.client
    ? async () => applyOptions.client
    : resolveClientFactory(options ?? {});
  const client = await getClient();

  for (const sql of migrationPlan.bootstrapSql) {
    await client.query(sql);
  }

  const alreadyApplied = await getAppliedMigrationNames(client, migrationPlan);
  const pendingMigrations = migrationPlan.migrations.filter((migration) => !alreadyApplied.has(migration.name));
  const skippedNames = migrationPlan.migrations
    .filter((migration) => alreadyApplied.has(migration.name))
    .map((migration) => migration.name);

  if (applyOptions.dryRun === true) {
    return {
      migrationPlan,
      appliedNames: [],
      skippedNames,
      pendingNames: pendingMigrations.map((migration) => migration.name),
      appliedCount: 0,
      pendingCount: pendingMigrations.length,
      dryRun: true
    };
  }

  const run = async (activeClient) => {
    const names = await executeMigrationSequence(activeClient, migrationPlan, pendingMigrations);
    return {
      migrationPlan,
      appliedNames: names,
      skippedNames,
      pendingNames: pendingMigrations.map((migration) => migration.name),
      appliedCount: names.length,
      pendingCount: pendingMigrations.length,
      dryRun: false
    };
  };

  if (typeof client.transaction === 'function' && pendingMigrations.length > 0) {
    return client.transaction(async (transactionClient) => run(transactionClient));
  }

  return run(client);
};

export const applyPostgresSchemaPlan = applyPostgresMigrations;

export const createPgvectorStore = (options) => {
  const vector = resolveVectorConfig(options ?? {});
  const schema = resolveSchemaConfig(options ?? {});
  const plan = createPostgresSchemaPlan(options ?? {});
  const getClient = resolveClientFactory(options ?? {});
  const diagnostics = {
    fallbackReason: undefined,
    lastInitError: undefined,
    lastQueryError: undefined,
    lastUpsertError: undefined,
    lastMigrationError: undefined
  };
  let initialized = false;
  let initPromise;

  const ensureInitialized = async () => {
    if (initialized) {
      return;
    }

    if (!initPromise) {
      initPromise = (async () => {
        try {
          const client = await getClient();
          await applyPostgresMigrations(options ?? {}, { client });
          initialized = true;
          diagnostics.lastInitError = undefined;
          diagnostics.lastMigrationError = undefined;
          diagnostics.fallbackReason = undefined;
        } catch (error) {
          initialized = false;
          const message = error instanceof Error ? error.message : String(error);
          diagnostics.lastInitError = message;
          diagnostics.lastMigrationError = message;
          diagnostics.fallbackReason = message;
          throw error;
        }
      })();
    }

    return initPromise;
  };

  const embed = async (input) => {
    if (typeof options.embedding === 'function') {
      const result = await options.embedding(input);
      return normalizeVector(result);
    }

    return normalizeVector([...createRAGVector(input.text, vector.dimensions)]);
  };

  const query = async (input) => {
    await ensureInitialized();
    const client = await getClient();
    const params = [];
    const qualifiedChunkTable = qualifiedTable(schema.schemaName, schema.chunkTableName);
    const operator = operatorForMetric(vector.distanceMetric);
    const vectorPlaceholder = makePlaceholder(params, vectorLiteral(normalizeVector(input.queryVector)), 'vector');
    const limitPlaceholder = makePlaceholder(params, input.topK);
    const whereParts = [];

    if (input.filter?.chunkId !== undefined) {
      whereParts.push(`chunk_id = ${makePlaceholder(params, input.filter.chunkId)}`);
    }
    if (input.filter?.title !== undefined) {
      whereParts.push(`title = ${makePlaceholder(params, input.filter.title)}`);
    }
    if (input.filter?.source !== undefined) {
      whereParts.push(`source = ${makePlaceholder(params, input.filter.source)}`);
    }

    const metadataFilter = buildMetadataFilter(input.filter);
    if (metadataFilter) {
      whereParts.push(`metadata @> ${makePlaceholder(params, JSON.stringify(metadataFilter), 'jsonb')}`);
    }

    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
    const sessionSql = plan.querySessionSql;
    const selectSql = `SELECT chunk_id, text, title, source, metadata, embedding ${operator} ${vectorPlaceholder} AS distance FROM ${qualifiedChunkTable} ${whereSql} ORDER BY distance ASC LIMIT ${limitPlaceholder}`;

    try {
      for (const sql of sessionSql) {
        await client.query(sql);
      }

      const result = await client.query(selectSql, params);
      return result.rows.map((row) => ({
        chunkId: row.chunk_id,
        chunkText: row.text,
        title: row.title ?? undefined,
        source: row.source ?? undefined,
        metadata: parseMetadataValue(row.metadata),
        score: scoreFromDistance(Number(row.distance), vector.distanceMetric)
      }));
    } catch (error) {
      diagnostics.lastQueryError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };

  const upsert = async (input) => {
    await ensureInitialized();
    const client = await getClient();
    const qualifiedChunkTable = qualifiedTable(schema.schemaName, schema.chunkTableName);
    const sql = `INSERT INTO ${qualifiedChunkTable} (chunk_id, text, title, source, metadata, embedding, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector, NOW()) ON CONFLICT (chunk_id) DO UPDATE SET text = EXCLUDED.text, title = EXCLUDED.title, source = EXCLUDED.source, metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding, updated_at = NOW()`;

    try {
      for (const chunk of input.chunks) {
        const vectorValue = Array.isArray(chunk.embedding) && chunk.embedding.length > 0
          ? normalizeVector(chunk.embedding)
          : await embed({ text: chunk.text });
        await client.query(sql, [
          chunk.chunkId,
          chunk.text,
          chunk.title ?? null,
          chunk.source ?? null,
          JSON.stringify(chunk.metadata ?? {}),
          vectorLiteral(vectorValue)
        ]);
      }
    } catch (error) {
      diagnostics.lastUpsertError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };

  const clear = async () => {
    await ensureInitialized();
    const client = await getClient();
    const qualifiedChunkTable = qualifiedTable(schema.schemaName, schema.chunkTableName);
    await client.query(`DELETE FROM ${qualifiedChunkTable}`);
  };

  return {
    embed,
    query,
    upsert,
    clear,
    getCapabilities: () => ({
      backend: 'postgres',
      persistence: 'external',
      nativeVectorSearch: true,
      serverSideFiltering: true,
      streamingIngestStatus: false
    }),
    getStatus: () => createPgvectorStoreStatus({
      vector,
      schema,
      diagnostics,
      initialized
    })
  };
};

export const createPostgresRAGCollection = (options) =>
  createRAGCollection({
    store: createPgvectorStore(options)
  });

export const createPostgresRAG = (options) => {
  const store = createPgvectorStore(options);
  const collection = createRAGCollection({ store });
  const schemaPlan = createPostgresSchemaPlan(options);
  const migrationPlan = createPostgresMigrationPlan(options);

  return {
    store,
    collection,
    getStatus: () => store.getStatus?.(),
    getCapabilities: () => store.getCapabilities?.(),
    getSchemaPlan: () => schemaPlan,
    getMigrationPlan: () => migrationPlan,
    applyMigrations: (applyOptions) => applyPostgresMigrations(options, applyOptions)
  };
};

export const createPostgreSQLRAG = createPostgresRAG;
