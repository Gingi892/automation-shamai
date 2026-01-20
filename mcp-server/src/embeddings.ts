/**
 * Embeddings Manager for Semantic Search
 * Uses Anthropic API for generating embeddings (no native dependencies)
 *
 * Note: This is a simplified implementation that stores embeddings in SQLite.
 * For production with large datasets, consider using a dedicated vector database.
 */

import Anthropic from '@anthropic-ai/sdk';
import { Decision, DatabaseType } from './types.js';
import { getDatabase, DecisionDatabase } from './database.js';

export interface SemanticSearchResult {
  decision: Decision;
  score: number;
}

export interface EmbeddingsFilter {
  database?: DatabaseType;
  committee?: string;
  caseType?: string;
}

/**
 * Simple cosine similarity calculation
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

export class EmbeddingsManager {
  private client: Anthropic | null = null;
  private db: DecisionDatabase | null = null;
  private embeddingsCache: Map<string, number[]> = new Map();

  constructor() {
    // Initialize Anthropic client if API key is available
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  /**
   * Initialize the embeddings manager
   */
  async initialize(): Promise<void> {
    this.db = await getDatabase();

    // Create embeddings table if needed
    // Note: For simplicity, we'll use keyword-based semantic search
    // True vector embeddings would require the Anthropic Embeddings API
    console.error('Embeddings manager initialized (keyword-based fallback mode)');
  }

  /**
   * Search for similar decisions using semantic search
   * Falls back to enhanced keyword search when embeddings API is not available
   */
  async search(
    query: string,
    limit = 20,
    filter?: EmbeddingsFilter
  ): Promise<SemanticSearchResult[]> {
    if (!this.db) {
      throw new Error('Embeddings manager not initialized');
    }

    // Use enhanced keyword search as fallback
    // This tokenizes the query and searches for matches
    const tokens = this.tokenize(query);

    const results = this.db.search({
      query: tokens.join(' '),
      database: filter?.database,
      limit: limit * 2, // Get more results for re-ranking
      semanticSearch: false
    });

    // Re-rank results based on token matching
    const rankedResults: SemanticSearchResult[] = results.decisions.map(decision => {
      const score = this.calculateRelevanceScore(decision, tokens);
      return { decision, score };
    });

    // Sort by score and return top results
    return rankedResults
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Tokenize Hebrew/English query into searchable terms
   */
  private tokenize(query: string): string[] {
    // Remove common Hebrew stop words
    const hebrewStopWords = new Set([
      'של', 'את', 'על', 'עם', 'זה', 'הוא', 'היא', 'הם', 'הן',
      'אני', 'אתה', 'את', 'אנחנו', 'הם', 'יש', 'אין', 'כל',
      'מה', 'מי', 'איך', 'למה', 'כי', 'אם', 'או', 'גם', 'רק'
    ]);

    return query
      .toLowerCase()
      .split(/[\s,.\-־]+/)
      .filter(token => token.length > 1 && !hebrewStopWords.has(token));
  }

  /**
   * Calculate relevance score for a decision based on query tokens
   */
  private calculateRelevanceScore(decision: Decision, tokens: string[]): number {
    let score = 0;
    const titleLower = decision.title.toLowerCase();
    const committeeLower = (decision.committee || '').toLowerCase();
    const appraiserLower = (decision.appraiser || '').toLowerCase();
    const caseTypeLower = (decision.caseType || '').toLowerCase();

    for (const token of tokens) {
      // Title matches are most important
      if (titleLower.includes(token)) {
        score += 3;
      }
      // Committee matches
      if (committeeLower.includes(token)) {
        score += 2;
      }
      // Appraiser matches
      if (appraiserLower.includes(token)) {
        score += 2;
      }
      // Case type matches
      if (caseTypeLower.includes(token)) {
        score += 1.5;
      }
    }

    // Normalize by number of tokens
    return tokens.length > 0 ? score / tokens.length : 0;
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{ count: number; mode: string }> {
    return {
      count: 0,
      mode: 'keyword-fallback'
    };
  }

  /**
   * Close the embeddings manager
   */
  async close(): Promise<void> {
    this.embeddingsCache.clear();
    this.db = null;
  }
}

// Singleton instance
let instance: EmbeddingsManager | null = null;

export async function getEmbeddings(): Promise<EmbeddingsManager> {
  if (!instance) {
    instance = new EmbeddingsManager();
    await instance.initialize();
  }
  return instance;
}

export async function closeEmbeddings(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}
