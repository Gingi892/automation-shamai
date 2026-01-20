/**
 * SQLite Database Manager for Gov.il Land Appraisal Decisions
 * Uses better-sqlite3 with FTS5 extension for Hebrew text search
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  Decision,
  DecisionRow,
  DatabaseType,
  SearchParams,
  SearchResult,
  IndexerStats,
  rowToDecision
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class DecisionDatabase {
  private db: Database.Database | null = null;
  private dbPath: string;
  private initialized = false;

  constructor(dbPath?: string) {
    // Default to ~/.gov-il-mcp/decisions.db as specified in PRD
    this.dbPath = dbPath || path.join(os.homedir(), '.gov-il-mcp', 'decisions.db');
  }

  /**
   * Initialize the database (must be called before use)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Open or create database
    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrent access
    this.db.pragma('journal_mode = WAL');

    this.createSchema();
    this.initialized = true;
  }

  /**
   * Create database schema with FTS5 virtual table
   */
  private createSchema(): void {
    if (!this.db) throw new Error('Database not initialized');

    // Main decisions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        database TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        block TEXT,
        plot TEXT,
        committee TEXT,
        appraiser TEXT,
        case_type TEXT,
        decision_date TEXT,
        publish_date TEXT,
        content_hash TEXT NOT NULL,
        pdf_text TEXT,
        indexed_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Create indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_database ON decisions(database)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_committee ON decisions(committee)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_block_plot ON decisions(block, plot)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_appraiser ON decisions(appraiser)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_case_type ON decisions(case_type)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_date ON decisions(decision_date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_content_hash ON decisions(content_hash)`);

    // Create FTS5 virtual table for Hebrew full-text search
    // Uses unicode61 tokenizer which handles Hebrew text well
    // content= specifies external content mode (saves space by not duplicating data)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
        title,
        committee,
        appraiser,
        case_type,
        content='decisions',
        content_rowid='rowid',
        tokenize='unicode61'
      )
    `);

    // Create triggers to keep FTS5 index synchronized with main table
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
        INSERT INTO decisions_fts(rowid, title, committee, appraiser, case_type)
        VALUES (new.rowid, new.title, new.committee, new.appraiser, new.case_type);
      END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, title, committee, appraiser, case_type)
        VALUES ('delete', old.rowid, old.title, old.committee, old.appraiser, old.case_type);
      END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, title, committee, appraiser, case_type)
        VALUES ('delete', old.rowid, old.title, old.committee, old.appraiser, old.case_type);
        INSERT INTO decisions_fts(rowid, title, committee, appraiser, case_type)
        VALUES (new.rowid, new.title, new.committee, new.appraiser, new.case_type);
      END
    `);

    // Indexer progress tracking table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS indexer_progress (
        database TEXT PRIMARY KEY,
        current_page INTEGER DEFAULT 0,
        total_pages INTEGER,
        documents_indexed INTEGER DEFAULT 0,
        start_time TEXT,
        status TEXT DEFAULT 'pending',
        error TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Metadata table for stats
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  /**
   * Rebuild FTS5 index from existing data
   * Call this after migrating from old database or if index is corrupted
   */
  rebuildFtsIndex(): void {
    if (!this.db) throw new Error('Database not initialized');

    console.error('[Database] Rebuilding FTS5 index...');

    // Delete all FTS data
    this.db.exec(`DELETE FROM decisions_fts`);

    // Repopulate from main table
    this.db.exec(`
      INSERT INTO decisions_fts(rowid, title, committee, appraiser, case_type)
      SELECT rowid, title, committee, appraiser, case_type FROM decisions
    `);

    console.error('[Database] FTS5 index rebuilt successfully');
  }

  /**
   * Insert or update a decision
   */
  insertDecision(decision: Omit<Decision, 'indexedAt'>): boolean {
    if (!this.db) throw new Error('Database not initialized');

    // Check if exists with same hash
    const existing = this.db.prepare(
      `SELECT 1 FROM decisions WHERE id = ? AND content_hash = ?`
    ).get(decision.id, decision.contentHash);

    if (existing) {
      return false; // Already exists with same hash
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO decisions
      (id, database, title, url, block, plot, committee, appraiser, case_type, decision_date, publish_date, content_hash, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    stmt.run(
      decision.id,
      decision.database,
      decision.title,
      decision.url,
      decision.block,
      decision.plot,
      decision.committee,
      decision.appraiser,
      decision.caseType,
      decision.decisionDate,
      decision.publishDate,
      decision.contentHash
    );

    return true;
  }

  /**
   * Batch insert decisions (uses transaction for efficiency)
   */
  insertDecisions(decisions: Omit<Decision, 'indexedAt'>[]): number {
    if (!this.db) throw new Error('Database not initialized');

    let inserted = 0;

    const checkStmt = this.db.prepare(
      `SELECT 1 FROM decisions WHERE id = ? AND content_hash = ?`
    );

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO decisions
      (id, database, title, url, block, plot, committee, appraiser, case_type, decision_date, publish_date, content_hash, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const transaction = this.db.transaction((decisions: Omit<Decision, 'indexedAt'>[]) => {
      for (const decision of decisions) {
        const existing = checkStmt.get(decision.id, decision.contentHash);
        if (!existing) {
          insertStmt.run(
            decision.id,
            decision.database,
            decision.title,
            decision.url,
            decision.block,
            decision.plot,
            decision.committee,
            decision.appraiser,
            decision.caseType,
            decision.decisionDate,
            decision.publishDate,
            decision.contentHash
          );
          inserted++;
        }
      }
    });

    transaction(decisions);
    return inserted;
  }

  /**
   * Get a decision by ID
   */
  getDecision(id: string): Decision | null {
    if (!this.db) throw new Error('Database not initialized');

    const row = this.db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as DecisionRow | undefined;

    if (!row) {
      return null;
    }

    return rowToDecision(row);
  }

  /**
   * Check if a decision exists by content hash
   */
  existsByHash(contentHash: string): boolean {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.prepare(
      `SELECT 1 FROM decisions WHERE content_hash = ?`
    ).get(contentHash);

    return !!result;
  }

  /**
   * Search decisions with various filters and FTS5 full-text search
   * Returns results with relevance ranking when using text search
   */
  search(params: SearchParams): SearchResult {
    if (!this.db) throw new Error('Database not initialized');

    const conditions: string[] = ['1=1'];
    const values: (string | number)[] = [];
    let useFts = false;
    let ftsQuery = '';

    // Database filter
    if (params.database) {
      conditions.push('d.database = ?');
      values.push(params.database);
    }

    // Committee filter
    if (params.committee) {
      conditions.push('d.committee LIKE ?');
      values.push(`%${params.committee}%`);
    }

    // Block/plot filter
    if (params.block) {
      conditions.push('d.block = ?');
      values.push(params.block);
    }
    if (params.plot) {
      conditions.push('d.plot = ?');
      values.push(params.plot);
    }

    // Appraiser filter
    if (params.appraiser) {
      conditions.push('d.appraiser LIKE ?');
      values.push(`%${params.appraiser}%`);
    }

    // Case type filter
    if (params.caseType) {
      conditions.push('d.case_type LIKE ?');
      values.push(`%${params.caseType}%`);
    }

    // Date range filter
    if (params.fromDate) {
      conditions.push('d.decision_date >= ?');
      values.push(params.fromDate);
    }
    if (params.toDate) {
      conditions.push('d.decision_date <= ?');
      values.push(params.toDate);
    }

    // Text search query - use FTS5 for relevance ranking
    if (params.query) {
      useFts = true;
      // Escape special FTS5 characters and wrap terms for prefix matching
      ftsQuery = this.escapeFtsQuery(params.query);
    }

    const limit = params.limit || 50;
    const offset = params.offset || 0;

    let decisions: Decision[];
    let totalCount: number;

    if (useFts && ftsQuery) {
      // FTS5 query with relevance ranking using bm25()
      const countSql = `
        SELECT COUNT(*) as count
        FROM decisions d
        INNER JOIN decisions_fts fts ON d.rowid = fts.rowid
        WHERE decisions_fts MATCH ?
        AND ${conditions.join(' AND ')}
      `;
      const countRow = this.db.prepare(countSql).get(ftsQuery, ...values) as { count: number };
      totalCount = countRow?.count || 0;

      // bm25() returns negative scores (more negative = more relevant)
      // So we order by bm25() ASC to get most relevant first
      const searchSql = `
        SELECT d.*, bm25(decisions_fts) as relevance_score
        FROM decisions d
        INNER JOIN decisions_fts fts ON d.rowid = fts.rowid
        WHERE decisions_fts MATCH ?
        AND ${conditions.join(' AND ')}
        ORDER BY bm25(decisions_fts), d.decision_date DESC
        LIMIT ? OFFSET ?
      `;

      const rows = this.db.prepare(searchSql).all(ftsQuery, ...values, limit + 1, offset) as (DecisionRow & { relevance_score: number })[];
      decisions = rows.slice(0, limit).map(row => rowToDecision(row));

    } else {
      // Standard query without FTS
      const countSql = `
        SELECT COUNT(*) as count FROM decisions d WHERE ${conditions.join(' AND ')}
      `;
      const countRow = this.db.prepare(countSql).get(...values) as { count: number };
      totalCount = countRow?.count || 0;

      const searchSql = `
        SELECT d.* FROM decisions d
        WHERE ${conditions.join(' AND ')}
        ORDER BY d.decision_date DESC, d.indexed_at DESC
        LIMIT ? OFFSET ?
      `;

      const rows = this.db.prepare(searchSql).all(...values, limit + 1, offset) as DecisionRow[];
      decisions = rows.slice(0, limit).map(row => rowToDecision(row));
    }

    const hasMore = decisions.length > limit || (offset + limit) < totalCount;

    return {
      decisions,
      totalCount,
      hasMore,
      query: params
    };
  }

  /**
   * Escape and prepare query string for FTS5
   * Handles Hebrew text and special characters
   */
  private escapeFtsQuery(query: string): string {
    // Remove FTS5 special operators that might cause syntax errors
    // but preserve the search terms
    let escaped = query
      .replace(/["\-*()^:]/g, ' ')  // Remove special chars
      .replace(/\s+/g, ' ')          // Normalize whitespace
      .trim();

    // Split into terms and wrap each with quotes for exact matching
    // This handles Hebrew text better
    const terms = escaped.split(' ').filter(t => t.length > 0);

    if (terms.length === 0) {
      return '';
    }

    // Use OR between terms for broader matching
    // Each term is quoted to handle Hebrew properly
    return terms.map(t => `"${t}"`).join(' OR ');
  }

  /**
   * Get statistics about the indexed data
   */
  getStats(): IndexerStats {
    if (!this.db) throw new Error('Database not initialized');

    const totalRow = this.db.prepare('SELECT COUNT(*) as count FROM decisions').get() as { count: number };
    const totalDocuments = totalRow?.count || 0;

    const byDbRows = this.db.prepare(`
      SELECT database, COUNT(*) as count FROM decisions GROUP BY database
    `).all() as { database: string; count: number }[];

    const byDatabase: Record<DatabaseType, number> = {
      decisive_appraiser: 0,
      appeals_committee: 0,
      appeals_board: 0
    };

    for (const row of byDbRows) {
      byDatabase[row.database as DatabaseType] = row.count;
    }

    const lastIndexedRow = this.db.prepare(`SELECT MAX(indexed_at) as last FROM decisions`).get() as { last: string | null };
    const lastIndexedAt = lastIndexedRow?.last || null;

    const lastUpdateRow = this.db.prepare(`SELECT value FROM metadata WHERE key = 'last_update'`).get() as { value: string } | undefined;
    const lastUpdateAt = lastUpdateRow?.value || null;

    return {
      totalDocuments,
      byDatabase,
      lastIndexedAt,
      lastUpdateAt
    };
  }

  /**
   * Get distinct values for a column (for autocomplete)
   */
  getDistinctValues(column: 'committee' | 'appraiser' | 'case_type', limit = 100): string[] {
    if (!this.db) throw new Error('Database not initialized');

    const rows = this.db.prepare(`
      SELECT DISTINCT ${column} as value
      FROM decisions
      WHERE ${column} IS NOT NULL AND ${column} != ''
      ORDER BY value
      LIMIT ?
    `).all(limit) as { value: string }[];

    return rows.map(row => row.value);
  }

  /**
   * Save indexer progress
   */
  saveProgress(database: DatabaseType, page: number, totalPages: number | null, documentsIndexed: number, status: string, error?: string): void {
    if (!this.db) throw new Error('Database not initialized');

    this.db.prepare(`
      INSERT OR REPLACE INTO indexer_progress
      (database, current_page, total_pages, documents_indexed, status, error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(database, page, totalPages, documentsIndexed, status, error || null);
  }

  /**
   * Get indexer progress
   */
  getProgress(database: DatabaseType): { currentPage: number; totalPages: number | null; documentsIndexed: number; status: string } | null {
    if (!this.db) throw new Error('Database not initialized');

    const row = this.db.prepare(
      'SELECT current_page, total_pages, documents_indexed, status FROM indexer_progress WHERE database = ?'
    ).get(database) as { current_page: number; total_pages: number | null; documents_indexed: number; status: string } | undefined;

    if (!row) {
      return null;
    }

    return {
      currentPage: row.current_page,
      totalPages: row.total_pages,
      documentsIndexed: row.documents_indexed,
      status: row.status
    };
  }

  /**
   * Update metadata
   */
  setMetadata(key: string, value: string): void {
    if (!this.db) throw new Error('Database not initialized');

    this.db.prepare(`
      INSERT OR REPLACE INTO metadata (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
    `).run(key, value);
  }

  /**
   * Get metadata
   */
  getMetadata(key: string): string | null {
    if (!this.db) throw new Error('Database not initialized');

    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined;

    return row?.value || null;
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }

  /**
   * Get database path
   */
  getDbPath(): string {
    return this.dbPath;
  }
}

// Singleton instance
let instance: DecisionDatabase | null = null;

export async function getDatabase(dbPath?: string): Promise<DecisionDatabase> {
  if (!instance) {
    instance = new DecisionDatabase(dbPath);
    await instance.initialize();
  }
  return instance;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
