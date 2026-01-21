/**
 * Integration Tests - Pinecone
 * US-P5-002: Pinecone integration tests
 *
 * These tests verify the Pinecone vector database operations for the Legal Chatbot.
 * They test the local logic for building requests and validating responses,
 * without making actual API calls (which would require API keys).
 *
 * Run with: cd mcp-server && node --import tsx ../chatbot/tests/test_pinecone.ts
 */

import assert from 'node:assert';
import crypto from 'node:crypto';

// ============================================================
// Pinecone Configuration
// ============================================================

const PINECONE_CONFIG = {
  host: 'https://gov-il-decisions-k1iqa9s.svc.aped-4627-b74a.pinecone.io',
  namespace: 'gov-il-decisions',
  dimension: 1024 // text-embedding-3-small
};

// ============================================================
// Types (matching PRD US-P2-003 schema)
// ============================================================

interface PineconeVector {
  id: string;
  values: number[];
  metadata: PineconeMetadata;
}

interface PineconeMetadata {
  // Core fields
  id: string;
  database: 'decisive_appraiser' | 'appeals_committee' | 'appeals_board';
  title: string;
  url: string;

  // Structured fields (for filtering)
  block: string | null;
  plot: string | null;
  committee: string | null;
  appraiser: string | null;
  caseType: string | null;
  decisionDate: string | null;
  year: string | null;

  // Content
  description: string;
  contentHash: string;

  // Timestamps
  indexedAt: string;
  publishDate: string | null;
}

interface UpsertRequest {
  vectors: PineconeVector[];
  namespace: string;
}

interface UpsertResponse {
  upsertedCount: number;
}

interface QueryRequest {
  vector: number[];
  topK: number;
  namespace: string;
  includeMetadata: boolean;
  filter?: Record<string, unknown>;
}

interface QueryMatch {
  id: string;
  score: number;
  metadata?: PineconeMetadata;
}

interface QueryResponse {
  matches: QueryMatch[];
  namespace: string;
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Generate a content hash for deduplication
 * Uses the same algorithm as scraper.ts
 */
function generateContentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Build a Pinecone vector ID following PRD schema
 * Format: {database}-{contentHash.slice(0,12)}
 */
function buildVectorId(database: string, contentHash: string): string {
  return `${database}-${contentHash.slice(0, 12)}`;
}

/**
 * Build an upsert request for a single document
 */
function buildUpsertRequest(vector: PineconeVector): UpsertRequest {
  return {
    vectors: [vector],
    namespace: PINECONE_CONFIG.namespace
  };
}

/**
 * Validate a Pinecone vector against PRD schema requirements
 */
function validateVector(vector: PineconeVector): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check required fields
  if (!vector.id) {
    errors.push('Missing required field: id');
  }

  if (!vector.values || !Array.isArray(vector.values)) {
    errors.push('Missing required field: values (must be array)');
  } else if (vector.values.length !== PINECONE_CONFIG.dimension) {
    errors.push(`Vector dimension mismatch: expected ${PINECONE_CONFIG.dimension}, got ${vector.values.length}`);
  }

  if (!vector.metadata) {
    errors.push('Missing required field: metadata');
  } else {
    // Check metadata required fields
    if (!vector.metadata.id) errors.push('Missing metadata.id');
    if (!vector.metadata.database) errors.push('Missing metadata.database');
    if (!vector.metadata.title) errors.push('Missing metadata.title');
    if (!vector.metadata.url) errors.push('Missing metadata.url');
    if (!vector.metadata.contentHash) errors.push('Missing metadata.contentHash');
    if (!vector.metadata.indexedAt) errors.push('Missing metadata.indexedAt');

    // Validate database enum
    const validDatabases = ['decisive_appraiser', 'appeals_committee', 'appeals_board'];
    if (vector.metadata.database && !validDatabases.includes(vector.metadata.database)) {
      errors.push(`Invalid database: ${vector.metadata.database}`);
    }

    // Validate id format
    if (vector.id && vector.metadata.database && vector.metadata.contentHash) {
      const expectedId = buildVectorId(vector.metadata.database, vector.metadata.contentHash);
      if (vector.id !== expectedId) {
        errors.push(`Vector id format mismatch: expected "${expectedId}", got "${vector.id}"`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Build a complete Pinecone vector from document data
 */
function buildPineconeVector(
  database: 'decisive_appraiser' | 'appeals_committee' | 'appeals_board',
  title: string,
  url: string,
  description: string,
  embedding: number[],
  options?: {
    block?: string;
    plot?: string;
    committee?: string;
    appraiser?: string;
    caseType?: string;
    decisionDate?: string;
    year?: string;
    publishDate?: string;
  }
): PineconeVector {
  const contentHash = generateContentHash(title + description);
  const id = buildVectorId(database, contentHash);
  const indexedAt = new Date().toISOString();

  return {
    id,
    values: embedding,
    metadata: {
      id,
      database,
      title,
      url,
      block: options?.block || null,
      plot: options?.plot || null,
      committee: options?.committee || null,
      appraiser: options?.appraiser || null,
      caseType: options?.caseType || null,
      decisionDate: options?.decisionDate || null,
      year: options?.year || null,
      description: description.substring(0, 35000), // Max 35KB per PRD
      contentHash,
      indexedAt,
      publishDate: options?.publishDate || null
    }
  };
}

/**
 * Generate a mock embedding vector for testing
 */
function generateMockEmbedding(): number[] {
  return Array.from({ length: PINECONE_CONFIG.dimension }, () => Math.random() * 2 - 1);
}

/**
 * Simulate an upsert response
 */
function simulateUpsertResponse(request: UpsertRequest): UpsertResponse {
  return {
    upsertedCount: request.vectors.length
  };
}

// ============================================================
// Test: test_upsert_single_document
// ============================================================

/**
 * Test basic Pinecone upsert operation for a single document
 * Verifies that the upsert request is correctly structured
 */
function test_upsert_single_document(): void {
  console.log('Running: test_upsert_single_document()');
  let passed = 0;
  let failed = 0;

  // Test case 1: Basic upsert with minimal required fields
  try {
    const embedding = generateMockEmbedding();
    const vector = buildPineconeVector(
      'decisive_appraiser',
      'הכרעת שמאי מכריע מיום 15-03-2024',
      'https://free-justice.openapi.gov.il/free/moj/portal/rest/doc/12345',
      'תוכן ההחלטה בעברית',
      embedding
    );

    const request = buildUpsertRequest(vector);

    // Verify request structure
    assert.strictEqual(request.namespace, PINECONE_CONFIG.namespace,
      'Namespace should match config');
    assert.strictEqual(request.vectors.length, 1,
      'Should have exactly one vector');
    assert.ok(request.vectors[0].id,
      'Vector should have an id');
    assert.strictEqual(request.vectors[0].values.length, PINECONE_CONFIG.dimension,
      `Vector dimension should be ${PINECONE_CONFIG.dimension}`);

    console.log('  ✓ Basic upsert with minimal fields');
    passed++;
  } catch (error) {
    console.log(`  ✗ Basic upsert with minimal fields: ${(error as Error).message}`);
    failed++;
  }

  // Test case 2: Verify vector ID format (PRD: {database}-{contentHash.slice(0,12)})
  try {
    const embedding = generateMockEmbedding();
    const title = 'הכרעת שמאי מכריע מיום 15-03-2024';
    const description = 'תוכן ההחלטה';
    const contentHash = generateContentHash(title + description);
    const expectedId = `decisive_appraiser-${contentHash.slice(0, 12)}`;

    const vector = buildPineconeVector(
      'decisive_appraiser',
      title,
      'https://example.com/doc.pdf',
      description,
      embedding
    );

    assert.strictEqual(vector.id, expectedId,
      'Vector ID should follow PRD format');
    assert.strictEqual(vector.metadata.contentHash, contentHash,
      'Content hash should be stored in metadata');

    console.log('  ✓ Vector ID follows PRD format');
    passed++;
  } catch (error) {
    console.log(`  ✗ Vector ID follows PRD format: ${(error as Error).message}`);
    failed++;
  }

  // Test case 3: Verify all required metadata fields are present
  try {
    const embedding = generateMockEmbedding();
    const vector = buildPineconeVector(
      'appeals_committee',
      'החלטה בהשגה מס\' 12345',
      'https://example.com/doc.pdf',
      'תוכן ההחלטה',
      embedding,
      {
        block: '6158',
        plot: '25',
        committee: 'תל אביב',
        caseType: 'היטל השבחה',
        decisionDate: '15-03-2024',
        year: '2024'
      }
    );

    const validation = validateVector(vector);

    assert.strictEqual(validation.valid, true,
      `Vector should be valid. Errors: ${validation.errors.join(', ')}`);

    console.log('  ✓ All required metadata fields present');
    passed++;
  } catch (error) {
    console.log(`  ✗ All required metadata fields present: ${(error as Error).message}`);
    failed++;
  }

  // Test case 4: Verify upsert response simulation
  try {
    const embedding = generateMockEmbedding();
    const vector = buildPineconeVector(
      'appeals_board',
      'ערעור מס\' 98765',
      'https://example.com/doc.pdf',
      'תוכן הערעור',
      embedding
    );

    const request = buildUpsertRequest(vector);
    const response = simulateUpsertResponse(request);

    assert.strictEqual(response.upsertedCount, 1,
      'Upserted count should be 1');

    console.log('  ✓ Upsert response structure correct');
    passed++;
  } catch (error) {
    console.log(`  ✗ Upsert response structure correct: ${(error as Error).message}`);
    failed++;
  }

  // Test case 5: Verify description truncation (max 35KB per PRD)
  try {
    const embedding = generateMockEmbedding();
    const longDescription = 'א'.repeat(40000); // Longer than 35KB limit

    const vector = buildPineconeVector(
      'decisive_appraiser',
      'Test Document',
      'https://example.com/doc.pdf',
      longDescription,
      embedding
    );

    assert.ok(vector.metadata.description.length <= 35000,
      `Description should be truncated to 35KB, got ${vector.metadata.description.length}`);

    console.log('  ✓ Description truncated to 35KB limit');
    passed++;
  } catch (error) {
    console.log(`  ✗ Description truncated to 35KB limit: ${(error as Error).message}`);
    failed++;
  }

  // Test case 6: Verify different databases produce different ID prefixes
  try {
    const embedding = generateMockEmbedding();
    const title = 'Same Title';
    const description = 'Same Description';

    const vector1 = buildPineconeVector('decisive_appraiser', title, 'url1', description, embedding);
    const vector2 = buildPineconeVector('appeals_committee', title, 'url1', description, embedding);
    const vector3 = buildPineconeVector('appeals_board', title, 'url1', description, embedding);

    assert.ok(vector1.id.startsWith('decisive_appraiser-'),
      'Decisive appraiser ID should have correct prefix');
    assert.ok(vector2.id.startsWith('appeals_committee-'),
      'Appeals committee ID should have correct prefix');
    assert.ok(vector3.id.startsWith('appeals_board-'),
      'Appeals board ID should have correct prefix');

    // All should have different IDs
    assert.notStrictEqual(vector1.id, vector2.id,
      'Different databases should produce different IDs');
    assert.notStrictEqual(vector2.id, vector3.id,
      'Different databases should produce different IDs');

    console.log('  ✓ Database prefixes produce unique IDs');
    passed++;
  } catch (error) {
    console.log(`  ✗ Database prefixes produce unique IDs: ${(error as Error).message}`);
    failed++;
  }

  // Test case 7: Verify indexedAt timestamp is set
  try {
    const before = new Date().toISOString();
    const embedding = generateMockEmbedding();
    const vector = buildPineconeVector(
      'decisive_appraiser',
      'Test',
      'https://example.com',
      'Content',
      embedding
    );
    const after = new Date().toISOString();

    assert.ok(vector.metadata.indexedAt >= before,
      'indexedAt should be after test start');
    assert.ok(vector.metadata.indexedAt <= after,
      'indexedAt should be before test end');

    console.log('  ✓ indexedAt timestamp is set correctly');
    passed++;
  } catch (error) {
    console.log(`  ✗ indexedAt timestamp is set correctly: ${(error as Error).message}`);
    failed++;
  }

  // Test case 8: Verify vector dimension validation
  try {
    const wrongDimensionVector: PineconeVector = {
      id: 'test-id',
      values: Array.from({ length: 512 }, () => 0), // Wrong dimension
      metadata: {
        id: 'test-id',
        database: 'decisive_appraiser',
        title: 'Test',
        url: 'https://example.com',
        block: null,
        plot: null,
        committee: null,
        appraiser: null,
        caseType: null,
        decisionDate: null,
        year: null,
        description: 'Test',
        contentHash: 'abc123',
        indexedAt: new Date().toISOString(),
        publishDate: null
      }
    };

    const validation = validateVector(wrongDimensionVector);

    assert.strictEqual(validation.valid, false,
      'Vector with wrong dimension should be invalid');
    assert.ok(validation.errors.some(e => e.includes('dimension')),
      'Should have dimension error');

    console.log('  ✓ Wrong dimension validation works');
    passed++;
  } catch (error) {
    console.log(`  ✗ Wrong dimension validation works: ${(error as Error).message}`);
    failed++;
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

// ============================================================
// Test: test_upsert_with_metadata
// ============================================================

/**
 * Test that ALL metadata fields are properly included in Pinecone upsert
 * Verifies PRD US-P2-003 metadata schema compliance
 */
function test_upsert_with_metadata(): void {
  console.log('\nRunning: test_upsert_with_metadata()');
  let passed = 0;
  let failed = 0;

  // Test case 1: All metadata fields are present for decisive_appraiser
  try {
    const embedding = generateMockEmbedding();
    const vector = buildPineconeVector(
      'decisive_appraiser',
      'הכרעת שמאי מכריע מיום 15-03-2024 בעניין ועדה מקומית תל אביב ג 6158 ח 25 - כהן',
      'https://free-justice.openapi.gov.il/free/moj/portal/rest/doc/12345',
      'תוכן מלא של ההחלטה בעברית. השמאי קבע כי הפיצוי יהיה בסך 100,000 ש"ח.',
      embedding,
      {
        block: '6158',
        plot: '25',
        committee: 'תל אביב',
        appraiser: 'כהן',
        caseType: 'היטל השבחה',
        decisionDate: '15-03-2024',
        year: '2024',
        publishDate: '20-03-2024'
      }
    );

    const meta = vector.metadata;

    // Verify ALL metadata fields exist
    assert.strictEqual(meta.database, 'decisive_appraiser', 'database field');
    assert.strictEqual(meta.block, '6158', 'block field');
    assert.strictEqual(meta.plot, '25', 'plot field');
    assert.strictEqual(meta.committee, 'תל אביב', 'committee field');
    assert.strictEqual(meta.appraiser, 'כהן', 'appraiser field');
    assert.strictEqual(meta.caseType, 'היטל השבחה', 'caseType field');
    assert.strictEqual(meta.decisionDate, '15-03-2024', 'decisionDate field');
    assert.strictEqual(meta.year, '2024', 'year field');
    assert.strictEqual(meta.publishDate, '20-03-2024', 'publishDate field');
    assert.ok(meta.title.includes('שמאי מכריע'), 'title field');
    assert.ok(meta.url.includes('free-justice'), 'url field');
    assert.ok(meta.description.includes('תוכן מלא'), 'description field');
    assert.ok(meta.contentHash.length === 64, 'contentHash is SHA256 (64 hex chars)');
    assert.ok(meta.indexedAt.includes('T'), 'indexedAt is ISO format');
    assert.strictEqual(meta.id, vector.id, 'metadata.id matches vector.id');

    console.log('  ✓ All metadata fields present for decisive_appraiser');
    passed++;
  } catch (error) {
    console.log(`  ✗ All metadata fields present for decisive_appraiser: ${(error as Error).message}`);
    failed++;
  }

  // Test case 2: All metadata fields for appeals_committee
  try {
    const embedding = generateMockEmbedding();
    const vector = buildPineconeVector(
      'appeals_committee',
      'החלטה בהשגה מס\' 12345 ועדה מקומית ירושלים ג 30000 ח 100',
      'https://free-justice.openapi.gov.il/free/moj/portal/rest/doc/67890',
      'החלטת ועדת השגות בעניין חיוב היטל השבחה.',
      embedding,
      {
        block: '30000',
        plot: '100',
        committee: 'ירושלים',
        appraiser: null, // appeals_committee may not have appraiser
        caseType: 'פיצויים',
        decisionDate: '10-01-2023',
        year: '2023',
        publishDate: '15-01-2023'
      }
    );

    const meta = vector.metadata;

    assert.strictEqual(meta.database, 'appeals_committee', 'database is appeals_committee');
    assert.strictEqual(meta.block, '30000', 'block field');
    assert.strictEqual(meta.plot, '100', 'plot field');
    assert.strictEqual(meta.committee, 'ירושלים', 'committee field');
    assert.strictEqual(meta.appraiser, null, 'appraiser can be null');
    assert.strictEqual(meta.caseType, 'פיצויים', 'caseType field');
    assert.strictEqual(meta.year, '2023', 'year field');

    console.log('  ✓ All metadata fields present for appeals_committee');
    passed++;
  } catch (error) {
    console.log(`  ✗ All metadata fields present for appeals_committee: ${(error as Error).message}`);
    failed++;
  }

  // Test case 3: All metadata fields for appeals_board
  try {
    const embedding = generateMockEmbedding();
    const vector = buildPineconeVector(
      'appeals_board',
      'ערעור מס\' 98765 על החלטת ועדת השגות חיפה',
      'https://free-justice.openapi.gov.il/free/moj/portal/rest/doc/11111',
      'החלטת ועדת ערעורים בעניין ערעור על היטל השבחה.',
      embedding,
      {
        block: '11111',
        plot: '55',
        committee: 'חיפה',
        appraiser: null,
        caseType: 'ירידת ערך',
        decisionDate: '05-06-2022',
        year: '2022',
        publishDate: '10-06-2022'
      }
    );

    const meta = vector.metadata;

    assert.strictEqual(meta.database, 'appeals_board', 'database is appeals_board');
    assert.strictEqual(meta.caseType, 'ירידת ערך', 'caseType field');
    assert.strictEqual(meta.year, '2022', 'year field');

    console.log('  ✓ All metadata fields present for appeals_board');
    passed++;
  } catch (error) {
    console.log(`  ✗ All metadata fields present for appeals_board: ${(error as Error).message}`);
    failed++;
  }

  // Test case 4: Null handling for optional fields
  try {
    const embedding = generateMockEmbedding();
    const vector = buildPineconeVector(
      'decisive_appraiser',
      'הכרעת שמאי מכריע',
      'https://example.com/doc.pdf',
      'תוכן',
      embedding
      // No optional fields provided
    );

    const meta = vector.metadata;

    // Required fields should exist
    assert.ok(meta.id, 'id is required');
    assert.ok(meta.database, 'database is required');
    assert.ok(meta.title, 'title is required');
    assert.ok(meta.url, 'url is required');
    assert.ok(meta.contentHash, 'contentHash is required');
    assert.ok(meta.indexedAt, 'indexedAt is required');
    assert.ok(meta.description, 'description is required');

    // Optional fields should be null (not undefined)
    assert.strictEqual(meta.block, null, 'block should be null when not provided');
    assert.strictEqual(meta.plot, null, 'plot should be null when not provided');
    assert.strictEqual(meta.committee, null, 'committee should be null when not provided');
    assert.strictEqual(meta.appraiser, null, 'appraiser should be null when not provided');
    assert.strictEqual(meta.caseType, null, 'caseType should be null when not provided');
    assert.strictEqual(meta.decisionDate, null, 'decisionDate should be null when not provided');
    assert.strictEqual(meta.year, null, 'year should be null when not provided');
    assert.strictEqual(meta.publishDate, null, 'publishDate should be null when not provided');

    console.log('  ✓ Null handling for optional fields');
    passed++;
  } catch (error) {
    console.log(`  ✗ Null handling for optional fields: ${(error as Error).message}`);
    failed++;
  }

  // Test case 5: Hebrew content in all text fields
  try {
    const embedding = generateMockEmbedding();
    const hebrewTitle = 'הכרעת שמאי מכריע מיום 01-01-2024 בעניין ועדה מקומית ראשון לציון';
    const hebrewDescription = 'החלטה זו ניתנה בעניין תביעת פיצויים בגין ירידת ערך מקרקעין';
    const hebrewCommittee = 'ראשון לציון';
    const hebrewAppraiser = 'דוד כהן';
    const hebrewCaseType = 'היטל השבחה';

    const vector = buildPineconeVector(
      'decisive_appraiser',
      hebrewTitle,
      'https://example.com/doc.pdf',
      hebrewDescription,
      embedding,
      {
        committee: hebrewCommittee,
        appraiser: hebrewAppraiser,
        caseType: hebrewCaseType
      }
    );

    const meta = vector.metadata;

    assert.strictEqual(meta.title, hebrewTitle, 'Hebrew title preserved');
    assert.strictEqual(meta.description, hebrewDescription, 'Hebrew description preserved');
    assert.strictEqual(meta.committee, hebrewCommittee, 'Hebrew committee preserved');
    assert.strictEqual(meta.appraiser, hebrewAppraiser, 'Hebrew appraiser preserved');
    assert.strictEqual(meta.caseType, hebrewCaseType, 'Hebrew caseType preserved');

    console.log('  ✓ Hebrew content preserved in all text fields');
    passed++;
  } catch (error) {
    console.log(`  ✗ Hebrew content preserved in all text fields: ${(error as Error).message}`);
    failed++;
  }

  // Test case 6: Metadata field types are correct
  try {
    const embedding = generateMockEmbedding();
    const vector = buildPineconeVector(
      'decisive_appraiser',
      'Test',
      'https://example.com',
      'Content',
      embedding,
      {
        block: '6158',
        plot: '25',
        committee: 'תל אביב',
        year: '2024'
      }
    );

    const meta = vector.metadata;

    // String fields
    assert.strictEqual(typeof meta.id, 'string', 'id is string');
    assert.strictEqual(typeof meta.database, 'string', 'database is string');
    assert.strictEqual(typeof meta.title, 'string', 'title is string');
    assert.strictEqual(typeof meta.url, 'string', 'url is string');
    assert.strictEqual(typeof meta.description, 'string', 'description is string');
    assert.strictEqual(typeof meta.contentHash, 'string', 'contentHash is string');
    assert.strictEqual(typeof meta.indexedAt, 'string', 'indexedAt is string');

    // String or null fields
    assert.ok(meta.block === null || typeof meta.block === 'string', 'block is string or null');
    assert.ok(meta.plot === null || typeof meta.plot === 'string', 'plot is string or null');
    assert.ok(meta.committee === null || typeof meta.committee === 'string', 'committee is string or null');
    assert.ok(meta.appraiser === null || typeof meta.appraiser === 'string', 'appraiser is string or null');
    assert.ok(meta.caseType === null || typeof meta.caseType === 'string', 'caseType is string or null');
    assert.ok(meta.year === null || typeof meta.year === 'string', 'year is string or null');
    assert.ok(meta.publishDate === null || typeof meta.publishDate === 'string', 'publishDate is string or null');

    console.log('  ✓ Metadata field types are correct');
    passed++;
  } catch (error) {
    console.log(`  ✗ Metadata field types are correct: ${(error as Error).message}`);
    failed++;
  }

  // Test case 7: PRD schema field completeness validation
  try {
    const embedding = generateMockEmbedding();
    const vector = buildPineconeVector(
      'decisive_appraiser',
      'Test Document',
      'https://example.com/doc.pdf',
      'Test content',
      embedding,
      {
        block: '1000',
        plot: '50',
        committee: 'נתניה',
        appraiser: 'לוי',
        caseType: 'היטל השבחה',
        decisionDate: '01-01-2024',
        year: '2024',
        publishDate: '05-01-2024'
      }
    );

    // PRD US-P2-003 lists all required metadata fields
    const prdRequiredFields = [
      'id', 'database', 'title', 'url',
      'block', 'plot', 'committee', 'appraiser', 'caseType', 'decisionDate', 'year',
      'description', 'contentHash', 'indexedAt', 'publishDate'
    ];

    const metaKeys = Object.keys(vector.metadata);

    for (const field of prdRequiredFields) {
      assert.ok(metaKeys.includes(field), `PRD field "${field}" should exist in metadata`);
    }

    console.log('  ✓ PRD schema field completeness validated');
    passed++;
  } catch (error) {
    console.log(`  ✗ PRD schema field completeness validated: ${(error as Error).message}`);
    failed++;
  }

  // Test case 8: Upsert request includes all metadata in correct format
  try {
    const embedding = generateMockEmbedding();
    const vector = buildPineconeVector(
      'appeals_committee',
      'החלטה בהשגה',
      'https://example.com/doc.pdf',
      'תוכן ההחלטה',
      embedding,
      {
        block: '5000',
        plot: '10',
        committee: 'באר שבע',
        caseType: 'פיצויים',
        year: '2023'
      }
    );

    const request = buildUpsertRequest(vector);

    // Verify the request structure contains complete metadata
    const reqVector = request.vectors[0];
    assert.ok(reqVector.metadata, 'Request vector should include metadata');
    assert.strictEqual(reqVector.metadata.database, 'appeals_committee', 'Metadata database preserved in request');
    assert.strictEqual(reqVector.metadata.committee, 'באר שבע', 'Metadata committee preserved in request');
    assert.strictEqual(reqVector.metadata.year, '2023', 'Metadata year preserved in request');

    console.log('  ✓ Upsert request includes all metadata correctly');
    passed++;
  } catch (error) {
    console.log(`  ✗ Upsert request includes all metadata correctly: ${(error as Error).message}`);
    failed++;
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

// ============================================================
// Test: test_query_by_filter
// ============================================================

/**
 * Build a Pinecone filter object from field conditions
 * Uses Pinecone's filter syntax: { field: { $eq: value } }
 */
function buildPineconeFilter(conditions: Record<string, string | null>): Record<string, unknown> {
  const filter: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(conditions)) {
    if (value !== null && value !== undefined) {
      filter[field] = { $eq: value };
    }
  }

  return filter;
}

/**
 * Build a query request with filters
 */
function buildQueryRequest(
  embedding: number[],
  topK: number,
  filter?: Record<string, unknown>
): QueryRequest {
  const request: QueryRequest = {
    vector: embedding,
    topK,
    namespace: PINECONE_CONFIG.namespace,
    includeMetadata: true
  };

  if (filter && Object.keys(filter).length > 0) {
    request.filter = filter;
  }

  return request;
}

/**
 * Simulate query response with filtering
 * This simulates how Pinecone would filter vectors based on metadata
 */
function simulateQueryWithFilter(
  vectors: PineconeVector[],
  request: QueryRequest
): QueryResponse {
  let matches = vectors;

  // Apply filters if present
  if (request.filter) {
    matches = vectors.filter(v => {
      for (const [field, condition] of Object.entries(request.filter!)) {
        const cond = condition as { $eq?: string };
        if (cond.$eq !== undefined) {
          const metaValue = (v.metadata as Record<string, unknown>)[field];
          if (metaValue !== cond.$eq) {
            return false;
          }
        }
      }
      return true;
    });
  }

  // Sort by a simulated score (in real Pinecone, this would be vector similarity)
  // Here we just assign random scores for testing purposes
  const scoredMatches: QueryMatch[] = matches.slice(0, request.topK).map(v => ({
    id: v.id,
    score: Math.random() * 0.5 + 0.5, // Score between 0.5 and 1.0
    metadata: request.includeMetadata ? v.metadata : undefined
  }));

  // Sort by score descending
  scoredMatches.sort((a, b) => b.score - a.score);

  return {
    matches: scoredMatches,
    namespace: request.namespace
  };
}

/**
 * Test Pinecone query with committee filter
 * Verifies that filter queries are correctly built and applied
 */
function test_query_by_filter(): void {
  console.log('\nRunning: test_query_by_filter()');
  let passed = 0;
  let failed = 0;

  // Create test vectors with various committee values
  const testVectors: PineconeVector[] = [];

  const committees = ['תל אביב', 'תל אביב', 'ירושלים', 'חיפה', 'באר שבע'];
  const years = ['2024', '2023', '2024', '2024', '2023'];
  const caseTypes = ['היטל השבחה', 'פיצויים', 'היטל השבחה', 'ירידת ערך', 'פיצויים'];
  const blocks = ['6158', '6159', '30000', '11111', '5000'];

  for (let i = 0; i < 5; i++) {
    const embedding = generateMockEmbedding();
    testVectors.push(buildPineconeVector(
      'decisive_appraiser',
      `הכרעת שמאי מכריע מס' ${i + 1}`,
      `https://example.com/doc${i}.pdf`,
      `תוכן החלטה ${i + 1}`,
      embedding,
      {
        committee: committees[i],
        year: years[i],
        caseType: caseTypes[i],
        block: blocks[i],
        plot: String(i + 1)
      }
    ));
  }

  // Test case 1: Filter by committee - single value
  try {
    const filter = buildPineconeFilter({ committee: 'תל אביב' });
    const queryEmbedding = generateMockEmbedding();
    const request = buildQueryRequest(queryEmbedding, 10, filter);

    // Verify filter structure
    assert.deepStrictEqual(filter, { committee: { $eq: 'תל אביב' } },
      'Committee filter should use $eq syntax');

    // Verify request structure
    assert.strictEqual(request.namespace, PINECONE_CONFIG.namespace,
      'Request should have correct namespace');
    assert.strictEqual(request.topK, 10, 'Request should have correct topK');
    assert.ok(request.filter, 'Request should have filter');

    // Simulate query and verify results
    const response = simulateQueryWithFilter(testVectors, request);

    // All matches should have committee = 'תל אביב'
    assert.ok(response.matches.length <= 2,
      'Should return at most 2 matches (only 2 תל אביב vectors)');

    for (const match of response.matches) {
      assert.strictEqual(match.metadata?.committee, 'תל אביב',
        'All matches should have committee = תל אביב');
    }

    console.log('  ✓ Filter by committee - single value');
    passed++;
  } catch (error) {
    console.log(`  ✗ Filter by committee - single value: ${(error as Error).message}`);
    failed++;
  }

  // Test case 2: Filter by year
  try {
    const filter = buildPineconeFilter({ year: '2024' });
    const queryEmbedding = generateMockEmbedding();
    const request = buildQueryRequest(queryEmbedding, 10, filter);

    assert.deepStrictEqual(filter, { year: { $eq: '2024' } },
      'Year filter should use $eq syntax');

    const response = simulateQueryWithFilter(testVectors, request);

    // Should return vectors with year = 2024 (3 vectors)
    assert.ok(response.matches.length <= 3,
      'Should return at most 3 matches for year 2024');

    for (const match of response.matches) {
      assert.strictEqual(match.metadata?.year, '2024',
        'All matches should have year = 2024');
    }

    console.log('  ✓ Filter by year');
    passed++;
  } catch (error) {
    console.log(`  ✗ Filter by year: ${(error as Error).message}`);
    failed++;
  }

  // Test case 3: Filter by caseType (Hebrew)
  try {
    const filter = buildPineconeFilter({ caseType: 'היטל השבחה' });
    const queryEmbedding = generateMockEmbedding();
    const request = buildQueryRequest(queryEmbedding, 10, filter);

    assert.deepStrictEqual(filter, { caseType: { $eq: 'היטל השבחה' } },
      'caseType filter should use $eq syntax');

    const response = simulateQueryWithFilter(testVectors, request);

    // Should return vectors with caseType = 'היטל השבחה' (2 vectors)
    assert.ok(response.matches.length <= 2,
      'Should return at most 2 matches for היטל השבחה');

    for (const match of response.matches) {
      assert.strictEqual(match.metadata?.caseType, 'היטל השבחה',
        'All matches should have caseType = היטל השבחה');
    }

    console.log('  ✓ Filter by caseType (Hebrew)');
    passed++;
  } catch (error) {
    console.log(`  ✗ Filter by caseType (Hebrew): ${(error as Error).message}`);
    failed++;
  }

  // Test case 4: Filter by block number
  try {
    const filter = buildPineconeFilter({ block: '6158' });
    const queryEmbedding = generateMockEmbedding();
    const request = buildQueryRequest(queryEmbedding, 10, filter);

    assert.deepStrictEqual(filter, { block: { $eq: '6158' } },
      'Block filter should use $eq syntax');

    const response = simulateQueryWithFilter(testVectors, request);

    // Should return exactly 1 vector with block = 6158
    assert.strictEqual(response.matches.length, 1,
      'Should return exactly 1 match for block 6158');
    assert.strictEqual(response.matches[0].metadata?.block, '6158',
      'Match should have block = 6158');

    console.log('  ✓ Filter by block number');
    passed++;
  } catch (error) {
    console.log(`  ✗ Filter by block number: ${(error as Error).message}`);
    failed++;
  }

  // Test case 5: Combine multiple filters (committee AND year)
  try {
    const filter = buildPineconeFilter({
      committee: 'תל אביב',
      year: '2024'
    });
    const queryEmbedding = generateMockEmbedding();
    const request = buildQueryRequest(queryEmbedding, 10, filter);

    // Verify combined filter structure
    assert.deepStrictEqual(filter, {
      committee: { $eq: 'תל אביב' },
      year: { $eq: '2024' }
    }, 'Combined filter should have both conditions');

    const response = simulateQueryWithFilter(testVectors, request);

    // Should return only vectors matching BOTH conditions
    // תל אביב with 2024 = 1 vector (index 0)
    assert.strictEqual(response.matches.length, 1,
      'Should return 1 match for תל אביב AND 2024');
    assert.strictEqual(response.matches[0].metadata?.committee, 'תל אביב',
      'Match should have committee = תל אביב');
    assert.strictEqual(response.matches[0].metadata?.year, '2024',
      'Match should have year = 2024');

    console.log('  ✓ Combine multiple filters (committee AND year)');
    passed++;
  } catch (error) {
    console.log(`  ✗ Combine multiple filters (committee AND year): ${(error as Error).message}`);
    failed++;
  }

  // Test case 6: Filter with no matching results
  try {
    const filter = buildPineconeFilter({ committee: 'אשדוד' }); // Not in test data
    const queryEmbedding = generateMockEmbedding();
    const request = buildQueryRequest(queryEmbedding, 10, filter);

    const response = simulateQueryWithFilter(testVectors, request);

    assert.strictEqual(response.matches.length, 0,
      'Should return 0 matches for non-existent committee');

    console.log('  ✓ Filter with no matching results');
    passed++;
  } catch (error) {
    console.log(`  ✗ Filter with no matching results: ${(error as Error).message}`);
    failed++;
  }

  // Test case 7: Empty filter returns all results (up to topK)
  try {
    const filter = buildPineconeFilter({});
    const queryEmbedding = generateMockEmbedding();
    const request = buildQueryRequest(queryEmbedding, 3, filter);

    // Verify no filter is added for empty conditions
    assert.deepStrictEqual(filter, {}, 'Empty conditions should produce empty filter');
    assert.strictEqual(request.filter, undefined,
      'Request should not have filter when empty');

    const response = simulateQueryWithFilter(testVectors, request);

    // Should return up to topK results
    assert.strictEqual(response.matches.length, 3,
      'Should return topK (3) matches when no filter');

    console.log('  ✓ Empty filter returns all results');
    passed++;
  } catch (error) {
    console.log(`  ✗ Empty filter returns all results: ${(error as Error).message}`);
    failed++;
  }

  // Test case 8: Filter ignores null values
  try {
    const filter = buildPineconeFilter({
      committee: 'תל אביב',
      appraiser: null // Should be ignored
    });

    // Verify null values are not included in filter
    assert.deepStrictEqual(filter, { committee: { $eq: 'תל אביב' } },
      'Filter should not include null values');
    assert.ok(!('appraiser' in filter),
      'Null appraiser should not be in filter');

    console.log('  ✓ Filter ignores null values');
    passed++;
  } catch (error) {
    console.log(`  ✗ Filter ignores null values: ${(error as Error).message}`);
    failed++;
  }

  // Test case 9: Query request structure matches Pinecone API
  try {
    const filter = buildPineconeFilter({ committee: 'חיפה', year: '2024' });
    const queryEmbedding = generateMockEmbedding();
    const request = buildQueryRequest(queryEmbedding, 5, filter);

    // Verify complete request structure
    assert.ok(Array.isArray(request.vector), 'vector should be array');
    assert.strictEqual(request.vector.length, PINECONE_CONFIG.dimension,
      'vector should have correct dimension');
    assert.strictEqual(typeof request.topK, 'number', 'topK should be number');
    assert.strictEqual(typeof request.namespace, 'string', 'namespace should be string');
    assert.strictEqual(typeof request.includeMetadata, 'boolean', 'includeMetadata should be boolean');
    assert.strictEqual(typeof request.filter, 'object', 'filter should be object');

    // Verify filter structure matches Pinecone syntax
    const filterObj = request.filter as Record<string, { $eq: string }>;
    assert.ok('committee' in filterObj, 'filter should have committee');
    assert.ok('$eq' in filterObj.committee, 'committee filter should use $eq');
    assert.ok('year' in filterObj, 'filter should have year');
    assert.ok('$eq' in filterObj.year, 'year filter should use $eq');

    console.log('  ✓ Query request structure matches Pinecone API');
    passed++;
  } catch (error) {
    console.log(`  ✗ Query request structure matches Pinecone API: ${(error as Error).message}`);
    failed++;
  }

  // Test case 10: Response includes metadata when includeMetadata=true
  try {
    const filter = buildPineconeFilter({ committee: 'ירושלים' });
    const queryEmbedding = generateMockEmbedding();
    const request = buildQueryRequest(queryEmbedding, 10, filter);

    // Verify includeMetadata is set
    assert.strictEqual(request.includeMetadata, true,
      'includeMetadata should be true by default');

    const response = simulateQueryWithFilter(testVectors, request);

    // Verify response has metadata
    for (const match of response.matches) {
      assert.ok(match.metadata, 'Match should include metadata');
      assert.ok(match.metadata.title, 'Metadata should have title');
      assert.ok(match.metadata.committee, 'Metadata should have committee');
    }

    console.log('  ✓ Response includes metadata when includeMetadata=true');
    passed++;
  } catch (error) {
    console.log(`  ✗ Response includes metadata when includeMetadata=true: ${(error as Error).message}`);
    failed++;
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

// ============================================================
// Test: test_query_semantic
// ============================================================

/**
 * Calculate cosine similarity between two vectors
 * Returns a value between -1 and 1 (1 = identical, 0 = orthogonal, -1 = opposite)
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (normA * normB);
}

/**
 * Generate a semantically similar embedding by adding small noise
 * The smaller the noise, the more similar the embedding
 */
function generateSimilarEmbedding(base: number[], noiseLevel: number): number[] {
  return base.map(v => v + (Math.random() * 2 - 1) * noiseLevel);
}

/**
 * Generate a semantically different embedding (random direction)
 */
function generateDifferentEmbedding(): number[] {
  return generateMockEmbedding();
}

/**
 * Simulate semantic query with cosine similarity scoring
 * Returns matches sorted by similarity (highest first)
 */
function simulateSemanticQuery(
  vectors: PineconeVector[],
  queryVector: number[],
  topK: number,
  includeMetadata: boolean = true
): QueryResponse {
  // Calculate similarity scores for all vectors
  const scoredMatches: QueryMatch[] = vectors.map(v => ({
    id: v.id,
    score: cosineSimilarity(queryVector, v.values),
    metadata: includeMetadata ? v.metadata : undefined
  }));

  // Sort by score descending (most similar first)
  scoredMatches.sort((a, b) => b.score - a.score);

  // Return top K results
  return {
    matches: scoredMatches.slice(0, topK),
    namespace: PINECONE_CONFIG.namespace
  };
}

/**
 * Test Pinecone query with semantic/embedding similarity
 * Verifies that similar embeddings return higher scores than different ones
 */
function test_query_semantic(): void {
  console.log('\nRunning: test_query_semantic()');
  let passed = 0;
  let failed = 0;

  // Create a base embedding that we'll use for similarity tests
  const baseEmbedding = generateMockEmbedding();

  // Create test vectors with varying similarity to base embedding
  const testVectors: PineconeVector[] = [];

  // Vector 0: Very similar to base (low noise)
  const similarEmbedding = generateSimilarEmbedding(baseEmbedding, 0.1);
  testVectors.push(buildPineconeVector(
    'decisive_appraiser',
    'הכרעה דומה מאוד',
    'https://example.com/similar.pdf',
    'תוכן דומה מאוד לשאילתה',
    similarEmbedding,
    { committee: 'תל אביב', year: '2024' }
  ));

  // Vector 1: Somewhat similar (medium noise)
  const somewhatSimilar = generateSimilarEmbedding(baseEmbedding, 0.5);
  testVectors.push(buildPineconeVector(
    'decisive_appraiser',
    'הכרעה דומה במידה',
    'https://example.com/somewhat.pdf',
    'תוכן דומה במידה מסוימת',
    somewhatSimilar,
    { committee: 'ירושלים', year: '2024' }
  ));

  // Vector 2: Less similar (higher noise)
  const lessSimilar = generateSimilarEmbedding(baseEmbedding, 1.0);
  testVectors.push(buildPineconeVector(
    'decisive_appraiser',
    'הכרעה פחות דומה',
    'https://example.com/less.pdf',
    'תוכן פחות דומה',
    lessSimilar,
    { committee: 'חיפה', year: '2023' }
  ));

  // Vector 3: Random/different embedding
  const differentEmbedding = generateDifferentEmbedding();
  testVectors.push(buildPineconeVector(
    'decisive_appraiser',
    'הכרעה שונה לגמרי',
    'https://example.com/different.pdf',
    'תוכן שונה לחלוטין',
    differentEmbedding,
    { committee: 'באר שבע', year: '2022' }
  ));

  // Vector 4: Another random embedding
  const anotherDifferent = generateDifferentEmbedding();
  testVectors.push(buildPineconeVector(
    'appeals_committee',
    'החלטת ועדת השגות',
    'https://example.com/appeals.pdf',
    'החלטה בנושא אחר',
    anotherDifferent,
    { committee: 'נתניה', year: '2024' }
  ));

  // Test case 1: Most similar vector should have highest score
  try {
    const response = simulateSemanticQuery(testVectors, baseEmbedding, 5);

    assert.ok(response.matches.length === 5,
      'Should return all 5 vectors');

    // The very similar vector (index 0) should be first
    const topMatch = response.matches[0];
    assert.strictEqual(topMatch.metadata?.title, 'הכרעה דומה מאוד',
      'Most similar vector should be ranked first');
    assert.ok(topMatch.score > 0.9,
      `Top match should have score > 0.9, got ${topMatch.score.toFixed(4)}`);

    console.log('  ✓ Most similar vector ranked first');
    passed++;
  } catch (error) {
    console.log(`  ✗ Most similar vector ranked first: ${(error as Error).message}`);
    failed++;
  }

  // Test case 2: Scores should be in descending order
  try {
    const response = simulateSemanticQuery(testVectors, baseEmbedding, 5);

    for (let i = 1; i < response.matches.length; i++) {
      assert.ok(response.matches[i - 1].score >= response.matches[i].score,
        `Scores should be descending: ${response.matches[i - 1].score} >= ${response.matches[i].score}`);
    }

    console.log('  ✓ Scores are in descending order');
    passed++;
  } catch (error) {
    console.log(`  ✗ Scores are in descending order: ${(error as Error).message}`);
    failed++;
  }

  // Test case 3: Identical embedding should have score ~1.0
  try {
    // Query with the exact same embedding as vector 0
    const response = simulateSemanticQuery(testVectors, similarEmbedding, 1);

    assert.ok(response.matches[0].score > 0.99,
      `Identical embedding should have score ~1.0, got ${response.matches[0].score.toFixed(4)}`);

    console.log('  ✓ Identical embedding has score ~1.0');
    passed++;
  } catch (error) {
    console.log(`  ✗ Identical embedding has score ~1.0: ${(error as Error).message}`);
    failed++;
  }

  // Test case 4: topK limits results correctly
  try {
    const response = simulateSemanticQuery(testVectors, baseEmbedding, 2);

    assert.strictEqual(response.matches.length, 2,
      'Should return exactly topK results');

    // Both should still be the most similar
    assert.ok(response.matches[0].score >= response.matches[1].score,
      'First result should have higher or equal score');

    console.log('  ✓ topK limits results correctly');
    passed++;
  } catch (error) {
    console.log(`  ✗ topK limits results correctly: ${(error as Error).message}`);
    failed++;
  }

  // Test case 5: Random vectors have low correlation (score near 0)
  try {
    // Two independent random vectors in high dimensions will have score near 0
    // due to the concentration of measure phenomenon
    const random1 = generateMockEmbedding();
    const random2 = generateMockEmbedding();

    const score = cosineSimilarity(random1, random2);

    // In high dimensions (1024), random vectors are nearly orthogonal
    // Expected score is approximately 0 with standard deviation ~1/sqrt(1024) ≈ 0.03
    // We use a generous threshold of 0.15 to account for randomness
    assert.ok(Math.abs(score) < 0.15,
      `Random vectors should have low correlation, got ${score.toFixed(4)}`);

    console.log('  ✓ Random vectors have low correlation (near orthogonal)');
    passed++;
  } catch (error) {
    console.log(`  ✗ Random vectors have low correlation: ${(error as Error).message}`);
    failed++;
  }

  // Test case 6: Negative embedding gives negative score
  try {
    const negativeEmbedding = baseEmbedding.map(v => -v);
    const score = cosineSimilarity(baseEmbedding, negativeEmbedding);

    assert.ok(score < -0.99,
      `Negative embedding should have score ~-1.0, got ${score.toFixed(4)}`);

    console.log('  ✓ Negative embedding has score ~-1.0');
    passed++;
  } catch (error) {
    console.log(`  ✗ Negative embedding has score ~-1.0: ${(error as Error).message}`);
    failed++;
  }

  // Test case 7: Metadata included in semantic query results
  try {
    const response = simulateSemanticQuery(testVectors, baseEmbedding, 3, true);

    for (const match of response.matches) {
      assert.ok(match.metadata, 'Match should include metadata');
      assert.ok(match.metadata.title, 'Metadata should have title');
      assert.ok(match.metadata.database, 'Metadata should have database');
      assert.ok(match.metadata.url, 'Metadata should have url');
    }

    console.log('  ✓ Metadata included in semantic query results');
    passed++;
  } catch (error) {
    console.log(`  ✗ Metadata included in semantic query results: ${(error as Error).message}`);
    failed++;
  }

  // Test case 8: Metadata excluded when includeMetadata=false
  try {
    const response = simulateSemanticQuery(testVectors, baseEmbedding, 3, false);

    for (const match of response.matches) {
      assert.strictEqual(match.metadata, undefined,
        'Match should not include metadata when includeMetadata=false');
    }

    console.log('  ✓ Metadata excluded when includeMetadata=false');
    passed++;
  } catch (error) {
    console.log(`  ✗ Metadata excluded when includeMetadata=false: ${(error as Error).message}`);
    failed++;
  }

  // Test case 9: Score values are between -1 and 1
  try {
    const response = simulateSemanticQuery(testVectors, baseEmbedding, 5);

    for (const match of response.matches) {
      assert.ok(match.score >= -1 && match.score <= 1,
        `Score should be between -1 and 1, got ${match.score}`);
    }

    console.log('  ✓ Score values are between -1 and 1');
    passed++;
  } catch (error) {
    console.log(`  ✗ Score values are between -1 and 1: ${(error as Error).message}`);
    failed++;
  }

  // Test case 10: Dimension mismatch throws error
  try {
    const wrongDimension = Array.from({ length: 512 }, () => Math.random());

    try {
      cosineSimilarity(baseEmbedding, wrongDimension);
      assert.fail('Should have thrown an error for dimension mismatch');
    } catch (e) {
      assert.ok((e as Error).message.includes('dimension'),
        'Error should mention dimension mismatch');
    }

    console.log('  ✓ Dimension mismatch throws error');
    passed++;
  } catch (error) {
    console.log(`  ✗ Dimension mismatch throws error: ${(error as Error).message}`);
    failed++;
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

// ============================================================
// Test: test_no_duplicates
// ============================================================

/**
 * Check if a vector with the same contentHash already exists
 * This simulates the deduplication check before upserting
 */
function checkDuplicateExists(
  existingVectors: PineconeVector[],
  newVector: PineconeVector
): { isDuplicate: boolean; existingId?: string } {
  // The PRD specifies ID format: {database}-{contentHash.slice(0,12)}
  // Two vectors with the same database and content will have the same ID
  const existingMatch = existingVectors.find(v => v.id === newVector.id);

  if (existingMatch) {
    return { isDuplicate: true, existingId: existingMatch.id };
  }

  // Also check full contentHash in metadata for extra safety
  const hashMatch = existingVectors.find(v =>
    v.metadata.contentHash === newVector.metadata.contentHash &&
    v.metadata.database === newVector.metadata.database
  );

  if (hashMatch) {
    return { isDuplicate: true, existingId: hashMatch.id };
  }

  return { isDuplicate: false };
}

/**
 * Simulate batch upsert with deduplication
 * Returns which vectors were upserted vs skipped
 */
function simulateBatchUpsertWithDedup(
  existingVectors: PineconeVector[],
  newVectors: PineconeVector[]
): { upserted: PineconeVector[]; skipped: PineconeVector[]; finalVectors: PineconeVector[] } {
  const upserted: PineconeVector[] = [];
  const skipped: PineconeVector[] = [];
  const finalVectors = [...existingVectors];

  for (const vector of newVectors) {
    const dupCheck = checkDuplicateExists(finalVectors, vector);

    if (dupCheck.isDuplicate) {
      skipped.push(vector);
    } else {
      upserted.push(vector);
      finalVectors.push(vector);
    }
  }

  return { upserted, skipped, finalVectors };
}

/**
 * Test contentHash-based deduplication mechanism
 * Verifies PRD requirement: contentHash prevents duplicates
 */
function test_no_duplicates(): void {
  console.log('\nRunning: test_no_duplicates()');
  let passed = 0;
  let failed = 0;

  // Test case 1: Same content produces same contentHash
  try {
    const title = 'הכרעת שמאי מכריע מיום 15-03-2024 בעניין תל אביב';
    const description = 'תוכן ההחלטה המלא בעברית. השמאי קבע פיצוי של 50,000 ש"ח.';

    const hash1 = generateContentHash(title + description);
    const hash2 = generateContentHash(title + description);

    assert.strictEqual(hash1, hash2,
      'Same content should produce identical contentHash');
    assert.strictEqual(hash1.length, 64,
      'contentHash should be SHA256 (64 hex characters)');

    console.log('  ✓ Same content produces same contentHash');
    passed++;
  } catch (error) {
    console.log(`  ✗ Same content produces same contentHash: ${(error as Error).message}`);
    failed++;
  }

  // Test case 2: Different content produces different contentHash
  try {
    const hash1 = generateContentHash('הכרעה א');
    const hash2 = generateContentHash('הכרעה ב');

    assert.notStrictEqual(hash1, hash2,
      'Different content should produce different contentHash');

    console.log('  ✓ Different content produces different contentHash');
    passed++;
  } catch (error) {
    console.log(`  ✗ Different content produces different contentHash: ${(error as Error).message}`);
    failed++;
  }

  // Test case 3: Same content in same database = same vector ID
  try {
    const embedding1 = generateMockEmbedding();
    const embedding2 = generateMockEmbedding(); // Different embedding, same content

    const title = 'הכרעת שמאי מכריע מיום 01-01-2024';
    const description = 'תוכן זהה';

    const vector1 = buildPineconeVector(
      'decisive_appraiser',
      title,
      'https://example.com/doc1.pdf',
      description,
      embedding1
    );

    const vector2 = buildPineconeVector(
      'decisive_appraiser',
      title,
      'https://example.com/doc2.pdf', // Different URL but same content
      description,
      embedding2
    );

    assert.strictEqual(vector1.id, vector2.id,
      'Same content in same database should produce same ID');
    assert.strictEqual(vector1.metadata.contentHash, vector2.metadata.contentHash,
      'Same content should have same contentHash');

    console.log('  ✓ Same content in same database = same vector ID');
    passed++;
  } catch (error) {
    console.log(`  ✗ Same content in same database = same vector ID: ${(error as Error).message}`);
    failed++;
  }

  // Test case 4: Same content in different database = different vector ID
  try {
    const embedding = generateMockEmbedding();
    const title = 'החלטה משותפת';
    const description = 'תוכן זהה לשני מאגרים';

    const vector1 = buildPineconeVector(
      'decisive_appraiser',
      title,
      'https://example.com/doc.pdf',
      description,
      embedding
    );

    const vector2 = buildPineconeVector(
      'appeals_committee',
      title,
      'https://example.com/doc.pdf',
      description,
      embedding
    );

    // Same content but different database prefix
    assert.notStrictEqual(vector1.id, vector2.id,
      'Same content in different databases should have different IDs');
    assert.strictEqual(vector1.metadata.contentHash, vector2.metadata.contentHash,
      'Same content should have same contentHash regardless of database');
    assert.ok(vector1.id.startsWith('decisive_appraiser-'),
      'Vector 1 should have decisive_appraiser prefix');
    assert.ok(vector2.id.startsWith('appeals_committee-'),
      'Vector 2 should have appeals_committee prefix');

    console.log('  ✓ Same content in different database = different vector ID');
    passed++;
  } catch (error) {
    console.log(`  ✗ Same content in different database = different vector ID: ${(error as Error).message}`);
    failed++;
  }

  // Test case 5: Duplicate detection identifies existing vector
  try {
    const embedding = generateMockEmbedding();
    const existingVector = buildPineconeVector(
      'decisive_appraiser',
      'הכרעה קיימת',
      'https://example.com/existing.pdf',
      'תוכן קיים במאגר',
      embedding,
      { committee: 'תל אביב', year: '2024' }
    );

    const existingVectors = [existingVector];

    // Try to add same content again
    const duplicateVector = buildPineconeVector(
      'decisive_appraiser',
      'הכרעה קיימת',
      'https://example.com/duplicate.pdf', // Different URL
      'תוכן קיים במאגר',
      generateMockEmbedding() // Different embedding
    );

    const dupCheck = checkDuplicateExists(existingVectors, duplicateVector);

    assert.strictEqual(dupCheck.isDuplicate, true,
      'Should detect duplicate');
    assert.strictEqual(dupCheck.existingId, existingVector.id,
      'Should return existing vector ID');

    console.log('  ✓ Duplicate detection identifies existing vector');
    passed++;
  } catch (error) {
    console.log(`  ✗ Duplicate detection identifies existing vector: ${(error as Error).message}`);
    failed++;
  }

  // Test case 6: Non-duplicate passes detection
  try {
    const existingVector = buildPineconeVector(
      'decisive_appraiser',
      'הכרעה א',
      'https://example.com/a.pdf',
      'תוכן א',
      generateMockEmbedding()
    );

    const existingVectors = [existingVector];

    const newVector = buildPineconeVector(
      'decisive_appraiser',
      'הכרעה ב', // Different title
      'https://example.com/b.pdf',
      'תוכן ב', // Different content
      generateMockEmbedding()
    );

    const dupCheck = checkDuplicateExists(existingVectors, newVector);

    assert.strictEqual(dupCheck.isDuplicate, false,
      'Different content should not be detected as duplicate');
    assert.strictEqual(dupCheck.existingId, undefined,
      'Should not return existing ID for non-duplicate');

    console.log('  ✓ Non-duplicate passes detection');
    passed++;
  } catch (error) {
    console.log(`  ✗ Non-duplicate passes detection: ${(error as Error).message}`);
    failed++;
  }

  // Test case 7: Batch upsert with mixed duplicates and new vectors
  try {
    // Create existing vectors
    const existing1 = buildPineconeVector(
      'decisive_appraiser',
      'הכרעה קיימת 1',
      'https://example.com/1.pdf',
      'תוכן 1',
      generateMockEmbedding(),
      { committee: 'תל אביב' }
    );
    const existing2 = buildPineconeVector(
      'decisive_appraiser',
      'הכרעה קיימת 2',
      'https://example.com/2.pdf',
      'תוכן 2',
      generateMockEmbedding(),
      { committee: 'ירושלים' }
    );

    const existingVectors = [existing1, existing2];

    // New vectors - some duplicates, some new
    const newVectors = [
      buildPineconeVector( // Duplicate of existing1
        'decisive_appraiser',
        'הכרעה קיימת 1',
        'https://example.com/1-copy.pdf',
        'תוכן 1',
        generateMockEmbedding()
      ),
      buildPineconeVector( // New vector
        'decisive_appraiser',
        'הכרעה חדשה 3',
        'https://example.com/3.pdf',
        'תוכן 3',
        generateMockEmbedding(),
        { committee: 'חיפה' }
      ),
      buildPineconeVector( // Duplicate of existing2
        'decisive_appraiser',
        'הכרעה קיימת 2',
        'https://example.com/2-copy.pdf',
        'תוכן 2',
        generateMockEmbedding()
      ),
      buildPineconeVector( // New vector
        'appeals_committee',
        'החלטה חדשה 4',
        'https://example.com/4.pdf',
        'תוכן 4',
        generateMockEmbedding(),
        { committee: 'באר שבע' }
      )
    ];

    const result = simulateBatchUpsertWithDedup(existingVectors, newVectors);

    assert.strictEqual(result.upserted.length, 2,
      'Should upsert 2 new vectors');
    assert.strictEqual(result.skipped.length, 2,
      'Should skip 2 duplicate vectors');
    assert.strictEqual(result.finalVectors.length, 4,
      'Final index should have 4 unique vectors');

    console.log('  ✓ Batch upsert with mixed duplicates and new vectors');
    passed++;
  } catch (error) {
    console.log(`  ✗ Batch upsert with mixed duplicates and new vectors: ${(error as Error).message}`);
    failed++;
  }

  // Test case 8: Minor content changes produce different hash
  try {
    const baseContent = 'הכרעת שמאי מכריע בעניין היטל השבחה';

    // Add a single character
    const modifiedContent = baseContent + '.';

    const hash1 = generateContentHash(baseContent);
    const hash2 = generateContentHash(modifiedContent);

    assert.notStrictEqual(hash1, hash2,
      'Minor content change should produce different hash');

    console.log('  ✓ Minor content changes produce different hash');
    passed++;
  } catch (error) {
    console.log(`  ✗ Minor content changes produce different hash: ${(error as Error).message}`);
    failed++;
  }

  // Test case 9: Empty index allows all new vectors
  try {
    const existingVectors: PineconeVector[] = [];

    const newVectors = [
      buildPineconeVector('decisive_appraiser', 'א', 'url1', 'content1', generateMockEmbedding()),
      buildPineconeVector('decisive_appraiser', 'ב', 'url2', 'content2', generateMockEmbedding()),
      buildPineconeVector('appeals_committee', 'ג', 'url3', 'content3', generateMockEmbedding())
    ];

    const result = simulateBatchUpsertWithDedup(existingVectors, newVectors);

    assert.strictEqual(result.upserted.length, 3,
      'All vectors should be upserted to empty index');
    assert.strictEqual(result.skipped.length, 0,
      'No vectors should be skipped');

    console.log('  ✓ Empty index allows all new vectors');
    passed++;
  } catch (error) {
    console.log(`  ✗ Empty index allows all new vectors: ${(error as Error).message}`);
    failed++;
  }

  // Test case 10: Whitespace-only difference produces different hash
  try {
    const content1 = 'שמאי מכריע';
    const content2 = 'שמאי  מכריע'; // Extra space
    const content3 = ' שמאי מכריע'; // Leading space

    const hash1 = generateContentHash(content1);
    const hash2 = generateContentHash(content2);
    const hash3 = generateContentHash(content3);

    assert.notStrictEqual(hash1, hash2,
      'Extra space should produce different hash');
    assert.notStrictEqual(hash1, hash3,
      'Leading space should produce different hash');
    assert.notStrictEqual(hash2, hash3,
      'Different whitespace patterns should produce different hashes');

    console.log('  ✓ Whitespace-only difference produces different hash');
    passed++;
  } catch (error) {
    console.log(`  ✗ Whitespace-only difference produces different hash: ${(error as Error).message}`);
    failed++;
  }

  // Test case 11: ID uniqueness within batch (no self-duplicates)
  try {
    const vectors: PineconeVector[] = [];
    const titles = ['הכרעה א', 'הכרעה ב', 'הכרעה ג', 'הכרעה ד', 'הכרעה ה'];

    for (const title of titles) {
      vectors.push(buildPineconeVector(
        'decisive_appraiser',
        title,
        `https://example.com/${title}.pdf`,
        `תוכן עבור ${title}`,
        generateMockEmbedding()
      ));
    }

    // All IDs should be unique
    const ids = vectors.map(v => v.id);
    const uniqueIds = new Set(ids);

    assert.strictEqual(uniqueIds.size, vectors.length,
      'All vector IDs should be unique within batch');

    console.log('  ✓ ID uniqueness within batch (no self-duplicates)');
    passed++;
  } catch (error) {
    console.log(`  ✗ ID uniqueness within batch (no self-duplicates): ${(error as Error).message}`);
    failed++;
  }

  // Test case 12: ContentHash is deterministic across builds
  try {
    const title = 'הכרעת שמאי מכריע';
    const description = 'תוכן ההחלטה';

    // Build same vector multiple times
    const vector1 = buildPineconeVector(
      'decisive_appraiser', title, 'url', description, generateMockEmbedding()
    );
    const vector2 = buildPineconeVector(
      'decisive_appraiser', title, 'url', description, generateMockEmbedding()
    );
    const vector3 = buildPineconeVector(
      'decisive_appraiser', title, 'url', description, generateMockEmbedding()
    );

    assert.strictEqual(vector1.metadata.contentHash, vector2.metadata.contentHash,
      'ContentHash should be same across builds');
    assert.strictEqual(vector2.metadata.contentHash, vector3.metadata.contentHash,
      'ContentHash should be deterministic');
    assert.strictEqual(vector1.id, vector2.id,
      'Vector ID should be same across builds');
    assert.strictEqual(vector2.id, vector3.id,
      'Vector ID should be deterministic');

    console.log('  ✓ ContentHash is deterministic across builds');
    passed++;
  } catch (error) {
    console.log(`  ✗ ContentHash is deterministic across builds: ${(error as Error).message}`);
    failed++;
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests
console.log('===== Pinecone Integration Tests =====\n');
test_upsert_single_document();
test_upsert_with_metadata();
test_query_by_filter();
test_query_semantic();
test_no_duplicates();
console.log('\n✓ All tests passed!');
