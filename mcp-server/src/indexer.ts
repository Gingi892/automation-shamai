/**
 * Background Indexer for Gov.il Land Appraisal Decisions
 * Orchestrates scraping and database population
 */

import {
  DatabaseType,
  Decision,
  IndexerProgress,
  DATABASE_CONFIG
} from './types.js';
import { DecisionDatabase, getDatabase } from './database.js';
import { GovIlScraper, createScraper } from './scraper.js';

export interface IndexerOptions {
  scraperApiKey: string;
  maxPages?: number;
  delayMs?: number;
  continueOnError?: boolean;
  onProgress?: (progress: IndexerProgress) => void;
  onError?: (error: Error, database: DatabaseType, page: number) => void;
}

export class DecisionIndexer {
  private db: DecisionDatabase | null = null;
  private scraper: GovIlScraper;
  private maxPages: number;
  private continueOnError: boolean;
  private onProgress?: (progress: IndexerProgress) => void;
  private onError?: (error: Error, database: DatabaseType, page: number) => void;

  constructor(options: IndexerOptions) {
    this.scraper = createScraper(options.scraperApiKey, {
      delayMs: options.delayMs || 1000
    });
    this.maxPages = options.maxPages || 1000;
    this.continueOnError = options.continueOnError ?? true;
    this.onProgress = options.onProgress;
    this.onError = options.onError;
  }

  /**
   * Initialize the indexer (must be called before use)
   */
  async initialize(): Promise<void> {
    this.db = await getDatabase();
  }

  /**
   * Index all documents from all databases
   */
  async indexAll(): Promise<void> {
    if (!this.db) await this.initialize();

    const databases: DatabaseType[] = ['decisive_appraiser', 'appeals_committee', 'appeals_board'];

    for (const database of databases) {
      await this.indexDatabase(database);
    }

    // Update last full index timestamp
    this.db!.setMetadata('last_full_index', new Date().toISOString());
  }

  /**
   * Index all documents from a specific database
   */
  async indexDatabase(database: DatabaseType): Promise<number> {
    if (!this.db) await this.initialize();

    const startTime = new Date();
    let page = 0;
    let totalIndexed = 0;
    let hasMore = true;
    let totalPages: number | null = null;
    let consecutiveEmptyPages = 0;

    // Check for resume point
    const progress = this.db!.getProgress(database);
    if (progress && progress.status === 'running') {
      page = progress.currentPage;
      totalIndexed = progress.documentsIndexed;
      console.log(`Resuming ${database} from page ${page}`);
    }

    this.updateProgress(database, page, totalPages, totalIndexed, startTime, 'running');

    while (hasMore && page < this.maxPages) {
      try {
        console.log(`Fetching ${DATABASE_CONFIG[database].name} page ${page}...`);

        const html = await this.scraper.fetchPage(database, page);
        const parsed = this.scraper.parseDecisions(html, database);
        const decisions = parsed.map(p => this.scraper.toDecision(p, database));

        if (decisions.length === 0) {
          consecutiveEmptyPages++;
          if (consecutiveEmptyPages >= 3) {
            console.log(`No more results after ${consecutiveEmptyPages} empty pages`);
            hasMore = false;
          }
        } else {
          consecutiveEmptyPages = 0;
          const inserted = this.db!.insertDecisions(decisions);
          totalIndexed += inserted;
          console.log(`  Found ${decisions.length} decisions, inserted ${inserted} new`);
        }

        // Estimate total pages if not known
        if (totalPages === null) {
          totalPages = this.scraper.estimateTotalPages(html);
        }

        // Check for more results
        if (!this.scraper.hasMoreResults(html)) {
          hasMore = false;
        }

        page++;
        this.updateProgress(database, page, totalPages, totalIndexed, startTime, 'running');

        // Rate limiting delay
        await this.scraper.delay();

      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`Error on page ${page}: ${err.message}`);

        if (this.onError) {
          this.onError(err, database, page);
        }

        if (!this.continueOnError) {
          this.updateProgress(database, page, totalPages, totalIndexed, startTime, 'failed', err.message);
          throw error;
        }

        // Save progress and try next page
        this.db!.saveProgress(database, page, totalPages, totalIndexed, 'error', err.message);
        page++;
        await this.scraper.delay();
      }
    }

    this.updateProgress(database, page, totalPages, totalIndexed, startTime, 'completed');
    console.log(`Completed ${DATABASE_CONFIG[database].name}: ${totalIndexed} documents indexed`);

    return totalIndexed;
  }

  /**
   * Update only recent pages (for daily updates)
   */
  async updateRecent(pagesToCheck = 5): Promise<Map<DatabaseType, number>> {
    if (!this.db) await this.initialize();

    const databases: DatabaseType[] = ['decisive_appraiser', 'appeals_committee', 'appeals_board'];
    const results = new Map<DatabaseType, number>();

    for (const database of databases) {
      let totalNew = 0;

      for (let page = 0; page < pagesToCheck; page++) {
        try {
          const decisions = await this.scraper.fetchAndParse(database, page);
          let newCount = 0;

          for (const decision of decisions) {
            // Check if already exists
            if (!this.db!.existsByHash(decision.contentHash)) {
              this.db!.insertDecision(decision);
              newCount++;
            }
          }

          totalNew += newCount;
          console.log(`${DATABASE_CONFIG[database].name} page ${page}: ${newCount} new of ${decisions.length}`);

          // If no new documents on this page, likely no more new ones
          if (newCount === 0 && page > 0) {
            break;
          }

          await this.scraper.delay();

        } catch (error) {
          console.error(`Error updating ${database} page ${page}:`, error);
          if (!this.continueOnError) throw error;
        }
      }

      results.set(database, totalNew);
    }

    this.db!.setMetadata('last_update', new Date().toISOString());
    return results;
  }

  /**
   * Index a specific range of pages
   */
  async indexRange(database: DatabaseType, startPage: number, endPage: number): Promise<number> {
    if (!this.db) await this.initialize();

    let totalIndexed = 0;

    for (let page = startPage; page <= endPage; page++) {
      try {
        const decisions = await this.scraper.fetchAndParse(database, page);
        const inserted = this.db!.insertDecisions(decisions);
        totalIndexed += inserted;
        console.log(`Page ${page}: ${inserted} new of ${decisions.length}`);
        await this.scraper.delay();
      } catch (error) {
        console.error(`Error on page ${page}:`, error);
        if (!this.continueOnError) throw error;
      }
    }

    return totalIndexed;
  }

  /**
   * Update progress tracking
   */
  private updateProgress(
    database: DatabaseType,
    page: number,
    totalPages: number | null,
    documentsIndexed: number,
    startTime: Date,
    status: string,
    error?: string
  ): void {
    if (this.db) {
      this.db.saveProgress(database, page, totalPages, documentsIndexed, status, error);
    }

    if (this.onProgress) {
      this.onProgress({
        database,
        currentPage: page,
        totalPages,
        documentsIndexed,
        startTime,
        status: status as IndexerProgress['status'],
        error
      });
    }
  }

  /**
   * Get current indexing statistics
   */
  getStats() {
    if (!this.db) throw new Error('Indexer not initialized');
    return this.db.getStats();
  }

  /**
   * Reset progress for a database (to re-index from scratch)
   */
  resetProgress(database: DatabaseType): void {
    if (!this.db) throw new Error('Indexer not initialized');
    this.db.saveProgress(database, 0, null, 0, 'pending');
  }
}

// Factory function
export function createIndexer(options: IndexerOptions): DecisionIndexer {
  return new DecisionIndexer(options);
}

// CLI runner
export async function runIndexer(apiKey: string, options?: Partial<IndexerOptions>): Promise<void> {
  const indexer = createIndexer({
    scraperApiKey: apiKey,
    ...options,
    onProgress: (progress) => {
      const pct = progress.totalPages
        ? Math.round((progress.currentPage / progress.totalPages) * 100)
        : '?';
      console.log(`[${progress.database}] Page ${progress.currentPage}/${progress.totalPages || '?'} (${pct}%) - ${progress.documentsIndexed} indexed`);
    },
    onError: (error, database, page) => {
      console.error(`[${database}] Error on page ${page}: ${error.message}`);
    }
  });

  await indexer.initialize();
  await indexer.indexAll();
  console.log('\nIndexing complete!');
  console.log(indexer.getStats());
}
