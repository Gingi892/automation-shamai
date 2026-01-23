/**
 * PDF File Cache Module
 * Provides local file caching for PDFs to enable:
 * - Fast repeat access (no re-download)
 * - Offline PDF reading
 * - Reduced ScraperAPI usage
 *
 * US-PDF-003: Create PdfCache module
 */

import { promises as fs } from 'fs';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import type { DatabaseType } from './types.js';

/**
 * Information about a cached PDF file
 */
export interface CachedPdfInfo {
  decisionId: string;
  database: DatabaseType;
  filePath: string;
  fileSize: number;
  fileHash: string;
  cachedAt: Date;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  totalFiles: number;
  totalSizeBytes: number;
  byDatabase: Record<DatabaseType, { count: number; sizeBytes: number }>;
  cacheDir: string;
}

/**
 * PDF File Cache
 * Stores PDFs in ~/.gov-il-mcp/pdfs/{database}/{id}.pdf
 */
export class PdfCache {
  private baseDir: string;

  constructor(baseDir?: string) {
    // Default to ~/.gov-il-mcp/pdfs
    this.baseDir = baseDir ?? join(homedir(), '.gov-il-mcp', 'pdfs');
    this.ensureDirectories();
  }

  /**
   * Ensure cache directories exist
   */
  private ensureDirectories(): void {
    const databases: DatabaseType[] = ['decisive_appraiser', 'appeals_committee', 'appeals_board'];

    for (const db of databases) {
      const dbDir = join(this.baseDir, db);
      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
        console.error(`[PdfCache] Created cache directory: ${dbDir}`);
      }
    }
  }

  /**
   * Get the file path for a cached PDF
   */
  private getFilePath(decisionId: string, database: DatabaseType): string {
    // Sanitize decision ID for use in filename (remove special characters)
    const safeId = decisionId.replace(/[<>:"/\\|?*]/g, '_');
    return join(this.baseDir, database, `${safeId}.pdf`);
  }

  /**
   * Check if a PDF is cached
   */
  isCached(decisionId: string, database: DatabaseType): boolean {
    const filePath = this.getFilePath(decisionId, database);
    return existsSync(filePath);
  }

  /**
   * Load a PDF from cache
   * Returns null if not cached
   */
  async loadPdf(decisionId: string, database: DatabaseType): Promise<Buffer | null> {
    const filePath = this.getFilePath(decisionId, database);

    if (!existsSync(filePath)) {
      console.error(`[PdfCache] MISS: ${decisionId} (${database})`);
      return null;
    }

    try {
      const buffer = await fs.readFile(filePath);
      console.error(`[PdfCache] HIT: ${decisionId} (${database}) - ${buffer.length} bytes`);
      return buffer;
    } catch (error) {
      console.error(`[PdfCache] Error loading ${decisionId}:`, error);
      return null;
    }
  }

  /**
   * Save a PDF to cache
   * Returns information about the cached file
   */
  async savePdf(decisionId: string, database: DatabaseType, buffer: Buffer): Promise<CachedPdfInfo> {
    const filePath = this.getFilePath(decisionId, database);

    // Ensure parent directory exists
    const dirPath = join(this.baseDir, database);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }

    // Calculate hash for integrity verification
    const hash = createHash('sha256').update(buffer).digest('hex');

    // Write file
    await fs.writeFile(filePath, buffer);

    const info: CachedPdfInfo = {
      decisionId,
      database,
      filePath,
      fileSize: buffer.length,
      fileHash: hash,
      cachedAt: new Date()
    };

    console.error(`[PdfCache] SAVED: ${decisionId} (${database}) - ${buffer.length} bytes`);

    return info;
  }

  /**
   * Delete a PDF from cache
   * Returns true if deleted, false if didn't exist
   */
  async deletePdf(decisionId: string, database: DatabaseType): Promise<boolean> {
    const filePath = this.getFilePath(decisionId, database);

    if (!existsSync(filePath)) {
      return false;
    }

    try {
      await fs.unlink(filePath);
      console.error(`[PdfCache] DELETED: ${decisionId} (${database})`);
      return true;
    } catch (error) {
      console.error(`[PdfCache] Error deleting ${decisionId}:`, error);
      return false;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<CacheStats> {
    const databases: DatabaseType[] = ['decisive_appraiser', 'appeals_committee', 'appeals_board'];
    const byDatabase: Record<DatabaseType, { count: number; sizeBytes: number }> = {
      decisive_appraiser: { count: 0, sizeBytes: 0 },
      appeals_committee: { count: 0, sizeBytes: 0 },
      appeals_board: { count: 0, sizeBytes: 0 }
    };

    let totalFiles = 0;
    let totalSizeBytes = 0;

    for (const db of databases) {
      const dbDir = join(this.baseDir, db);

      if (!existsSync(dbDir)) {
        continue;
      }

      try {
        const files = await fs.readdir(dbDir);
        const pdfFiles = files.filter(f => f.endsWith('.pdf'));

        for (const file of pdfFiles) {
          const filePath = join(dbDir, file);
          const stats = await fs.stat(filePath);

          byDatabase[db].count++;
          byDatabase[db].sizeBytes += stats.size;
          totalFiles++;
          totalSizeBytes += stats.size;
        }
      } catch (error) {
        console.error(`[PdfCache] Error reading stats for ${db}:`, error);
      }
    }

    return {
      totalFiles,
      totalSizeBytes,
      byDatabase,
      cacheDir: this.baseDir
    };
  }

  /**
   * Format cache stats for display
   */
  formatStats(stats: CacheStats): string {
    const formatSize = (bytes: number): string => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    };

    const lines = [
      `PDF Cache Statistics`,
      `--------------------`,
      `Cache directory: ${stats.cacheDir}`,
      `Total files: ${stats.totalFiles}`,
      `Total size: ${formatSize(stats.totalSizeBytes)}`,
      ``,
      `By database:`
    ];

    for (const [db, data] of Object.entries(stats.byDatabase)) {
      lines.push(`  ${db}: ${data.count} files (${formatSize(data.sizeBytes)})`);
    }

    return lines.join('\n');
  }

  /**
   * Clean up old cached files using LRU strategy
   * @param maxSizeBytes Maximum cache size in bytes (default 5GB)
   * @returns Number of files deleted
   */
  async cleanup(maxSizeBytes: number = 5 * 1024 * 1024 * 1024): Promise<number> {
    const stats = await this.getStats();

    if (stats.totalSizeBytes <= maxSizeBytes) {
      console.error(`[PdfCache] Cache size (${stats.totalSizeBytes}) within limit (${maxSizeBytes})`);
      return 0;
    }

    const targetSize = maxSizeBytes * 0.8; // Clean to 80% of max
    const bytesToFree = stats.totalSizeBytes - targetSize;

    console.error(`[PdfCache] Cache cleanup needed: ${stats.totalSizeBytes} > ${maxSizeBytes}, freeing ${bytesToFree} bytes`);

    // Collect all files with their modification times
    const databases: DatabaseType[] = ['decisive_appraiser', 'appeals_committee', 'appeals_board'];
    const allFiles: { path: string; size: number; mtime: Date; database: DatabaseType; id: string }[] = [];

    for (const db of databases) {
      const dbDir = join(this.baseDir, db);

      if (!existsSync(dbDir)) continue;

      const files = await fs.readdir(dbDir);
      const pdfFiles = files.filter(f => f.endsWith('.pdf'));

      for (const file of pdfFiles) {
        const filePath = join(dbDir, file);
        const fileStats = await fs.stat(filePath);
        allFiles.push({
          path: filePath,
          size: fileStats.size,
          mtime: fileStats.mtime,
          database: db,
          id: file.replace('.pdf', '')
        });
      }
    }

    // Sort by modification time (oldest first - LRU)
    allFiles.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

    // Delete oldest files until we've freed enough space
    let freedBytes = 0;
    let deletedCount = 0;

    for (const file of allFiles) {
      if (freedBytes >= bytesToFree) break;

      try {
        await fs.unlink(file.path);
        freedBytes += file.size;
        deletedCount++;
        console.error(`[PdfCache] Deleted: ${file.id} (${file.database}) - ${file.size} bytes`);
      } catch (error) {
        console.error(`[PdfCache] Error deleting ${file.path}:`, error);
      }
    }

    console.error(`[PdfCache] Cleanup complete: deleted ${deletedCount} files, freed ${freedBytes} bytes`);
    return deletedCount;
  }

  /**
   * Get the base cache directory path
   */
  getCacheDir(): string {
    return this.baseDir;
  }
}

// Singleton instance
let pdfCacheInstance: PdfCache | null = null;

/**
 * Get the singleton PdfCache instance
 */
export function getPdfCache(): PdfCache {
  if (!pdfCacheInstance) {
    pdfCacheInstance = new PdfCache();
  }
  return pdfCacheInstance;
}

/**
 * Create a new PdfCache instance with custom base directory
 * (Use getPdfCache() for the singleton instance)
 */
export function createPdfCache(baseDir?: string): PdfCache {
  return new PdfCache(baseDir);
}
