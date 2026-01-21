/**
 * SQLite Database Manager for Gov.il Land Appraisal Decisions
 * Uses sql.js (pure JavaScript SQLite) for cross-platform compatibility
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
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
  private db: SqlJsDatabase | null = null;
  private dbPath: string;
  private initialized = false;
  private SQL: any = null;

  constructor(dbPath?: string) {
    // Default to ~/.gov-il-mcp/decisions.db as specified in PRD
    this.dbPath = dbPath || path.join(os.homedir(), '.gov-il-mcp', 'decisions.db');
  }

  /**
   * Initialize the database (must be called before use)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Initialize sql.js
    this.SQL = await initSqlJs();

    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Load existing database or create new one
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new this.SQL.Database(buffer);
    } else {
      this.db = new this.SQL.Database();
    }

    this.createSchema();
    this.initialized = true;
  }

  /**
   * Create database schema
   */
  private createSchema(): void {
    if (!this.db) throw new Error('Database not initialized');

    // Main decisions table
    this.db.run(`
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
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_database ON decisions(database)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_committee ON decisions(committee)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_block_plot ON decisions(block, plot)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_appraiser ON decisions(appraiser)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_case_type ON decisions(case_type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_decision_date ON decisions(decision_date)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_content_hash ON decisions(content_hash)`);

    // Metadata table for tracking
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Progress tracking table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS indexer_progress (
        database TEXT PRIMARY KEY,
        current_page INTEGER DEFAULT 0,
        total_pages INTEGER,
        documents_indexed INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        error TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.save();
  }

  /**
   * Save database to disk
   */
  private save(): void {
    if (!this.db) return;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  /**
   * Insert a single decision
   */
  insertDecision(decision: Omit<Decision, 'indexedAt'>): boolean {
    if (!this.db) throw new Error('Database not initialized');

    try {
      this.db.run(`
        INSERT OR REPLACE INTO decisions
        (id, database, title, url, block, plot, committee, appraiser, case_type, decision_date, publish_date, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
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
      ]);
      this.save();
      return true;
    } catch (error) {
      console.error('Error inserting decision:', error);
      return false;
    }
  }

  /**
   * Insert multiple decisions (batch)
   */
  insertDecisions(decisions: Omit<Decision, 'indexedAt'>[]): number {
    if (!this.db) throw new Error('Database not initialized');

    let inserted = 0;
    for (const decision of decisions) {
      try {
        // Check if already exists by hash
        const existing = this.db.exec(
          `SELECT 1 FROM decisions WHERE content_hash = ?`,
          [decision.contentHash]
        );

        if (existing.length === 0 || existing[0].values.length === 0) {
          this.db.run(`
            INSERT INTO decisions
            (id, database, title, url, block, plot, committee, appraiser, case_type, decision_date, publish_date, content_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
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
          ]);
          inserted++;
        }
      } catch (error) {
        console.error('Error inserting decision:', error);
      }
    }

    if (inserted > 0) {
      this.save();
    }
    return inserted;
  }

  /**
   * Check if a decision exists by content hash
   */
  existsByHash(contentHash: string): boolean {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.exec(
      `SELECT 1 FROM decisions WHERE content_hash = ?`,
      [contentHash]
    );
    return result.length > 0 && result[0].values.length > 0;
  }

  /**
   * Get a decision by ID
   */
  getById(id: string): Decision | null {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.exec(
      `SELECT * FROM decisions WHERE id = ?`,
      [id]
    );

    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }

    const columns = result[0].columns;
    const values = result[0].values[0];
    const row = this.columnsToRow(columns, values);
    return rowToDecision(row);
  }

  /**
   * Alias for getById - used by MCP handlers
   */
  getDecision(id: string): Decision | null {
    return this.getById(id);
  }

  /**
   * Get database file path
   */
  getDbPath(): string {
    return this.dbPath;
  }

  /**
   * Get distinct values for a column
   */
  getDistinctValues(column: string, limit: number = 100): string[] {
    if (!this.db) throw new Error('Database not initialized');

    // Validate column name to prevent SQL injection
    const allowedColumns = ['committee', 'appraiser', 'case_type', 'block'];
    if (!allowedColumns.includes(column)) {
      throw new Error(`Invalid column: ${column}`);
    }

    const result = this.db.exec(
      `SELECT DISTINCT ${column} FROM decisions WHERE ${column} IS NOT NULL AND ${column} != '' ORDER BY ${column} LIMIT ?`,
      [limit]
    );

    if (result.length === 0) return [];
    return result[0].values.map(v => String(v[0]));
  }

  /**
   * Get distinct values for a column with counts
   * US-005: Returns committee/appraiser names with decision counts, sorted alphabetically
   */
  getDistinctValuesWithCounts(column: string, limit: number = 100): Array<{ name: string; count: number }> {
    if (!this.db) throw new Error('Database not initialized');

    // Validate column name to prevent SQL injection
    const allowedColumns = ['committee', 'appraiser', 'case_type', 'block'];
    if (!allowedColumns.includes(column)) {
      throw new Error(`Invalid column: ${column}`);
    }

    const result = this.db.exec(
      `SELECT ${column}, COUNT(*) as count FROM decisions
       WHERE ${column} IS NOT NULL AND ${column} != ''
       GROUP BY ${column}
       ORDER BY ${column}
       LIMIT ?`,
      [limit]
    );

    if (result.length === 0) return [];
    return result[0].values.map(v => ({
      name: String(v[0]),
      count: Number(v[1])
    }));
  }

  /**
   * Search decisions with filtering
   */
  search(params: SearchParams): SearchResult {
    if (!this.db) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const values: any[] = [];

    // Build WHERE conditions
    if (params.database) {
      conditions.push('database = ?');
      values.push(params.database);
    }

    if (params.query) {
      // Use LIKE for text search (no FTS5 in sql.js)
      const searchTerms = params.query.split(/\s+/).filter(t => t.length > 0);
      const likeConditions = searchTerms.map(() =>
        '(title LIKE ? OR committee LIKE ? OR appraiser LIKE ? OR case_type LIKE ?)'
      );
      conditions.push(`(${likeConditions.join(' AND ')})`);
      for (const term of searchTerms) {
        const likeTerm = `%${term}%`;
        values.push(likeTerm, likeTerm, likeTerm, likeTerm);
      }
    }

    if (params.committee) {
      conditions.push('committee LIKE ?');
      values.push(`%${params.committee}%`);
    }

    if (params.block) {
      conditions.push('block = ?');
      values.push(params.block);
    }

    if (params.plot) {
      conditions.push('plot = ?');
      values.push(params.plot);
    }

    if (params.appraiser) {
      conditions.push('appraiser LIKE ?');
      values.push(`%${params.appraiser}%`);
    }

    if (params.caseType) {
      conditions.push('case_type LIKE ?');
      values.push(`%${params.caseType}%`);
    }

    if (params.fromDate) {
      conditions.push('decision_date >= ?');
      values.push(params.fromDate);
    }

    if (params.toDate) {
      conditions.push('decision_date <= ?');
      values.push(params.toDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    // Get total count
    const countResult = this.db.exec(
      `SELECT COUNT(*) as count FROM decisions ${whereClause}`,
      values
    );
    const totalCount = countResult.length > 0 ? Number(countResult[0].values[0][0]) : 0;

    // Get results
    const queryResult = this.db.exec(
      `SELECT * FROM decisions ${whereClause} ORDER BY indexed_at DESC LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );

    const decisions: Decision[] = [];
    if (queryResult.length > 0 && queryResult[0].values.length > 0) {
      const columns = queryResult[0].columns;
      for (const rowValues of queryResult[0].values) {
        const row = this.columnsToRow(columns, rowValues);
        decisions.push(rowToDecision(row));
      }
    }

    return {
      decisions,
      totalCount,
      hasMore: offset + decisions.length < totalCount,
      query: params
    };
  }

  /**
   * Convert columns and values arrays to row object
   */
  private columnsToRow(columns: string[], values: any[]): DecisionRow {
    const row: any = {};
    columns.forEach((col, idx) => {
      row[col] = values[idx];
    });
    return row as DecisionRow;
  }

  /**
   * Get all unique committees
   */
  getCommittees(): string[] {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.exec(
      `SELECT DISTINCT committee FROM decisions WHERE committee IS NOT NULL ORDER BY committee`
    );

    if (result.length === 0) return [];
    return result[0].values.map(v => String(v[0]));
  }

  /**
   * Get all unique appraisers
   */
  getAppraisers(): string[] {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.exec(
      `SELECT DISTINCT appraiser FROM decisions WHERE appraiser IS NOT NULL ORDER BY appraiser`
    );

    if (result.length === 0) return [];
    return result[0].values.map(v => String(v[0]));
  }

  /**
   * Extended statistics type for US-004 compliance
   */
  interface ExtendedStats extends IndexerStats {
    totalDecisions: number;
    recentDecisions?: number;
    oldestDecision?: string | null;
    newestDecision?: string | null;
    byCommittee?: Array<{ committee: string; count: number }>;
    byCaseType?: Array<{ caseType: string; count: number }>;
    byYear?: Array<{ year: string; count: number }>;
  }

  /**
   * Get database statistics
   * US-004: Returns total count, breakdown by committee/case type/year, date range
   */
  getStats(): ExtendedStats {
    if (!this.db) throw new Error('Database not initialized');

    const totalResult = this.db.exec(`SELECT COUNT(*) FROM decisions`);
    const totalDocuments = totalResult.length > 0 ? Number(totalResult[0].values[0][0]) : 0;

    const byDatabase: Record<DatabaseType, number> = {
      decisive_appraiser: 0,
      appeals_committee: 0,
      appeals_board: 0
    };

    const byDbResult = this.db.exec(
      `SELECT database, COUNT(*) as count FROM decisions GROUP BY database`
    );
    if (byDbResult.length > 0) {
      for (const row of byDbResult[0].values) {
        const dbType = row[0] as DatabaseType;
        const count = Number(row[1]);
        if (dbType in byDatabase) {
          byDatabase[dbType] = count;
        }
      }
    }

    const lastIndexResult = this.db.exec(
      `SELECT value FROM metadata WHERE key = 'last_full_index'`
    );
    const lastIndexedAt = lastIndexResult.length > 0 && lastIndexResult[0].values.length > 0
      ? String(lastIndexResult[0].values[0][0])
      : null;

    const lastUpdateResult = this.db.exec(
      `SELECT value FROM metadata WHERE key = 'last_update'`
    );
    const lastUpdateAt = lastUpdateResult.length > 0 && lastUpdateResult[0].values.length > 0
      ? String(lastUpdateResult[0].values[0][0])
      : null;

    // Get recent decisions count (last 30 days)
    const recentResult = this.db.exec(
      `SELECT COUNT(*) FROM decisions WHERE indexed_at >= datetime('now', '-30 days')`
    );
    const recentDecisions = recentResult.length > 0 ? Number(recentResult[0].values[0][0]) : 0;

    // Get oldest decision date (date range min)
    const oldestResult = this.db.exec(
      `SELECT MIN(decision_date) FROM decisions WHERE decision_date IS NOT NULL`
    );
    const oldestDecision = oldestResult.length > 0 && oldestResult[0].values[0][0]
      ? String(oldestResult[0].values[0][0])
      : null;

    // Get newest decision date (date range max)
    const newestResult = this.db.exec(
      `SELECT MAX(decision_date) FROM decisions WHERE decision_date IS NOT NULL`
    );
    const newestDecision = newestResult.length > 0 && newestResult[0].values[0][0]
      ? String(newestResult[0].values[0][0])
      : null;

    // Breakdown by committee (top 20)
    const byCommitteeResult = this.db.exec(
      `SELECT committee, COUNT(*) as count FROM decisions
       WHERE committee IS NOT NULL AND committee != ''
       GROUP BY committee ORDER BY count DESC LIMIT 20`
    );
    const byCommittee: Array<{ committee: string; count: number }> = [];
    if (byCommitteeResult.length > 0) {
      for (const row of byCommitteeResult[0].values) {
        byCommittee.push({
          committee: String(row[0]),
          count: Number(row[1])
        });
      }
    }

    // Breakdown by case type
    const byCaseTypeResult = this.db.exec(
      `SELECT case_type, COUNT(*) as count FROM decisions
       WHERE case_type IS NOT NULL AND case_type != ''
       GROUP BY case_type ORDER BY count DESC`
    );
    const byCaseType: Array<{ caseType: string; count: number }> = [];
    if (byCaseTypeResult.length > 0) {
      for (const row of byCaseTypeResult[0].values) {
        byCaseType.push({
          caseType: String(row[0]),
          count: Number(row[1])
        });
      }
    }

    // Breakdown by year (extracted from decision_date)
    const byYearResult = this.db.exec(
      `SELECT substr(decision_date, 7, 4) as year, COUNT(*) as count FROM decisions
       WHERE decision_date IS NOT NULL AND length(decision_date) >= 10
       GROUP BY year ORDER BY year DESC`
    );
    const byYear: Array<{ year: string; count: number }> = [];
    if (byYearResult.length > 0) {
      for (const row of byYearResult[0].values) {
        if (row[0]) {
          byYear.push({
            year: String(row[0]),
            count: Number(row[1])
          });
        }
      }
    }

    return {
      totalDocuments,
      totalDecisions: totalDocuments,  // Alias for compatibility
      byDatabase,
      lastIndexedAt,
      lastUpdateAt,
      recentDecisions,
      oldestDecision,
      newestDecision,
      byCommittee,
      byCaseType,
      byYear
    };
  }

  /**
   * Set metadata value
   */
  setMetadata(key: string, value: string): void {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run(`
      INSERT OR REPLACE INTO metadata (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
    `, [key, value]);
    this.save();
  }

  /**
   * Get metadata value
   */
  getMetadata(key: string): string | null {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.exec(
      `SELECT value FROM metadata WHERE key = ?`,
      [key]
    );
    return result.length > 0 && result[0].values.length > 0
      ? String(result[0].values[0][0])
      : null;
  }

  /**
   * Save indexer progress
   */
  saveProgress(
    database: DatabaseType,
    currentPage: number,
    totalPages: number | null,
    documentsIndexed: number,
    status: string,
    error?: string
  ): void {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run(`
      INSERT OR REPLACE INTO indexer_progress
      (database, current_page, total_pages, documents_indexed, status, error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `, [database, currentPage, totalPages, documentsIndexed, status, error || null]);
    this.save();
  }

  /**
   * Get indexer progress
   */
  getProgress(database: DatabaseType): { currentPage: number; totalPages: number | null; documentsIndexed: number; status: string } | null {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.exec(
      `SELECT current_page, total_pages, documents_indexed, status FROM indexer_progress WHERE database = ?`,
      [database]
    );

    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }

    const row = result[0].values[0];
    return {
      currentPage: Number(row[0]),
      totalPages: row[1] !== null ? Number(row[1]) : null,
      documentsIndexed: Number(row[2]),
      status: String(row[3])
    };
  }

  /**
   * Update PDF text for a decision
   */
  updatePdfText(id: string, pdfText: string): boolean {
    if (!this.db) throw new Error('Database not initialized');

    try {
      this.db.run(
        `UPDATE decisions SET pdf_text = ? WHERE id = ?`,
        [pdfText, id]
      );
      this.save();
      return true;
    } catch (error) {
      console.error('Error updating PDF text:', error);
      return false;
    }
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.save();
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }
}

// Singleton instance
let dbInstance: DecisionDatabase | null = null;

export async function getDatabase(dbPath?: string): Promise<DecisionDatabase> {
  if (!dbInstance) {
    dbInstance = new DecisionDatabase(dbPath);
    await dbInstance.initialize();
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
