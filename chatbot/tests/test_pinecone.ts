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

// Run tests
console.log('===== Pinecone Integration Tests =====\n');
test_upsert_single_document();
console.log('\n✓ All tests passed!');
