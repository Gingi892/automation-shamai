/**
 * Pinecone Client for Gov.il MCP Server
 *
 * Connects to Pinecone to query the 20K indexed documents.
 * Uses PINECONE_INDEX_HOST environment variable for the index endpoint.
 */

import { Pinecone, type RecordMetadata } from '@pinecone-database/pinecone';

export interface PineconeQueryResult {
  id: string;
  score: number;
  metadata: {
    title?: string;
    url?: string;
    committee?: string;
    decision_date?: string;
    block?: string;
    plot?: string;
    appraiser?: string;
    case_type?: string;
    database?: string;
    [key: string]: unknown;
  };
}

export interface PineconeClientOptions {
  apiKey?: string;
  indexHost?: string;
  namespace?: string;
}

export class PineconeClient {
  private client: Pinecone;
  private indexHost: string;
  private defaultNamespace: string;

  constructor(options: PineconeClientOptions = {}) {
    const apiKey = options.apiKey || process.env.PINECONE_API_KEY;
    this.indexHost = options.indexHost || process.env.PINECONE_INDEX_HOST || '';
    this.defaultNamespace = options.namespace || 'gov-il-decisions';

    if (!apiKey) {
      throw new Error('PINECONE_API_KEY environment variable is required');
    }

    if (!this.indexHost) {
      throw new Error('PINECONE_INDEX_HOST environment variable is required');
    }

    this.client = new Pinecone({ apiKey });
  }

  /**
   * Query Pinecone for similar documents
   * @param embedding - Query embedding vector (1024 dimensions for text-embedding-3-small)
   * @param topK - Number of results to return (default: 10)
   * @param namespace - Pinecone namespace (default: 'gov-il-decisions')
   * @returns Array of matching documents with scores and metadata
   */
  async query(
    embedding: number[],
    topK: number = 10,
    namespace?: string
  ): Promise<PineconeQueryResult[]> {
    const ns = namespace || this.defaultNamespace;

    // Get the index using the host URL
    const index = this.client.index(this.indexHost);

    const results = await index.namespace(ns).query({
      vector: embedding,
      topK,
      includeMetadata: true
    });

    if (!results.matches) {
      return [];
    }

    return results.matches.map((match) => ({
      id: match.id,
      score: match.score || 0,
      metadata: (match.metadata as PineconeQueryResult['metadata']) || {}
    }));
  }

  /**
   * Query by ID to get a specific document's metadata
   * @param id - Document ID
   * @param namespace - Pinecone namespace (default: 'gov-il-decisions')
   * @returns Document metadata or null if not found
   */
  async fetchById(
    id: string,
    namespace?: string
  ): Promise<PineconeQueryResult | null> {
    const ns = namespace || this.defaultNamespace;
    const index = this.client.index(this.indexHost);

    const result = await index.namespace(ns).fetch([id]);

    if (!result.records || !result.records[id]) {
      return null;
    }

    const record = result.records[id];
    return {
      id: record.id,
      score: 1.0, // Exact match
      metadata: (record.metadata as PineconeQueryResult['metadata']) || {}
    };
  }

  /**
   * Get namespace statistics
   * @param namespace - Pinecone namespace (default: 'gov-il-decisions')
   * @returns Object with vector count
   */
  async getStats(namespace?: string): Promise<{ vectorCount: number }> {
    const ns = namespace || this.defaultNamespace;
    const index = this.client.index(this.indexHost);

    const stats = await index.describeIndexStats();
    const nsStats = stats.namespaces?.[ns];

    return {
      vectorCount: nsStats?.recordCount || 0
    };
  }
}

// Singleton instance for reuse
let pineconeClientInstance: PineconeClient | null = null;

/**
 * Get or create the Pinecone client singleton
 * Returns null if required environment variables are not set
 */
export function getPineconeClient(): PineconeClient | null {
  if (pineconeClientInstance) {
    return pineconeClientInstance;
  }

  try {
    pineconeClientInstance = new PineconeClient();
    return pineconeClientInstance;
  } catch (error) {
    console.error('[PineconeClient] Failed to initialize:', error);
    return null;
  }
}
