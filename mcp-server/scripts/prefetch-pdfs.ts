#!/usr/bin/env tsx
/**
 * PDF Prefetch Script
 * Downloads all PDFs from decisions in the database to local cache
 * Enables offline access and eliminates ScraperAPI latency for repeat reads
 *
 * US-PDF-009: Create prefetch script
 *
 * Usage:
 *   $env:SCRAPER_API_KEY="your_key"; npx tsx scripts/prefetch-pdfs.ts
 *
 * Options:
 *   --limit=N         Maximum number of PDFs to download (default: unlimited)
 *   --delay=N         Delay in ms between requests (default: 2000)
 *   --database=TYPE   Limit to specific database (decisive_appraiser, appeals_committee, appeals_board)
 *   --skip-cached     Skip PDFs already in file cache (default: true)
 *   --dry-run         Show what would be downloaded without downloading
 */

import { getDatabase, closeDatabase } from '../src/database.js';
import { PdfCache, getPdfCache } from '../src/pdf-cache.js';
import { createPdfExtractor } from '../src/pdf-extractor.js';
import { DatabaseType } from '../src/types.js';

interface PrefetchOptions {
  limit: number;
  delay: number;
  database?: DatabaseType;
  skipCached: boolean;
  dryRun: boolean;
}

function parseArgs(): PrefetchOptions {
  const args = process.argv.slice(2);
  const options: PrefetchOptions = {
    limit: 0,  // 0 = unlimited
    delay: 2000,  // 2 seconds between requests to avoid rate limiting
    skipCached: true,
    dryRun: false
  };

  for (const arg of args) {
    if (arg.startsWith('--limit=')) {
      options.limit = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--delay=')) {
      options.delay = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--database=')) {
      const db = arg.split('=')[1];
      if (['decisive_appraiser', 'appeals_committee', 'appeals_board'].includes(db)) {
        options.database = db as DatabaseType;
      } else {
        console.error(`Invalid database: ${db}. Valid options: decisive_appraiser, appeals_committee, appeals_board`);
        process.exit(1);
      }
    } else if (arg === '--skip-cached' || arg === '--skip-cached=true') {
      options.skipCached = true;
    } else if (arg === '--no-skip-cached' || arg === '--skip-cached=false') {
      options.skipCached = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
PDF Prefetch Script - Download all PDFs to local cache

Usage:
  $env:SCRAPER_API_KEY="your_key"; npx tsx scripts/prefetch-pdfs.ts [options]

Options:
  --limit=N         Maximum PDFs to download (default: unlimited)
  --delay=N         Delay in ms between requests (default: 2000)
  --database=TYPE   Limit to database: decisive_appraiser, appeals_committee, appeals_board
  --skip-cached     Skip PDFs already cached (default)
  --no-skip-cached  Re-download all PDFs
  --dry-run         Show what would be downloaded without downloading
  --help, -h        Show this help message

Examples:
  # Prefetch all PDFs (skip already cached)
  npx tsx scripts/prefetch-pdfs.ts

  # Prefetch first 100 PDFs from decisive_appraiser
  npx tsx scripts/prefetch-pdfs.ts --limit=100 --database=decisive_appraiser

  # See what would be downloaded
  npx tsx scripts/prefetch-pdfs.ts --dry-run
`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

async function main() {
  const apiKey = process.env.SCRAPER_API_KEY;

  if (!apiKey) {
    console.error('Error: SCRAPER_API_KEY environment variable is required');
    console.error('');
    console.error('PowerShell usage:');
    console.error('  $env:SCRAPER_API_KEY="your_key"; npx tsx scripts/prefetch-pdfs.ts');
    process.exit(1);
  }

  const options = parseArgs();
  const timestamp = new Date().toISOString();

  console.log('='.repeat(60));
  console.log(`PDF Prefetch Script - ${timestamp}`);
  console.log('='.repeat(60));
  console.log(`Options:`);
  console.log(`  Limit: ${options.limit || 'unlimited'}`);
  console.log(`  Delay: ${options.delay}ms`);
  console.log(`  Database: ${options.database || 'all'}`);
  console.log(`  Skip cached: ${options.skipCached}`);
  console.log(`  Dry run: ${options.dryRun}`);
  console.log('='.repeat(60));

  // Initialize database
  const db = await getDatabase();
  const pdfCache = getPdfCache();

  // Get initial cache stats
  const statsBefore = await pdfCache.getStats();
  console.log(`\nCache before: ${statsBefore.totalFiles} files (${formatBytes(statsBefore.totalSizeBytes)})`);

  // Build query to get decisions with URLs
  const databases: DatabaseType[] = options.database
    ? [options.database]
    : ['decisive_appraiser', 'appeals_committee', 'appeals_board'];

  // Collect all decisions with URLs
  const decisionsToFetch: Array<{
    id: string;
    url: string;
    database: DatabaseType;
  }> = [];

  for (const dbType of databases) {
    // Search for decisions with URLs (use large limit to get all)
    const result = db.search({
      database: dbType,
      limit: options.limit || 100000,
      offset: 0
    });

    for (const decision of result.decisions) {
      if (decision.url) {
        // Check if already cached
        if (options.skipCached && pdfCache.isCached(decision.id, dbType)) {
          continue;
        }

        decisionsToFetch.push({
          id: decision.id,
          url: decision.url,
          database: dbType
        });

        // Respect limit
        if (options.limit && decisionsToFetch.length >= options.limit) {
          break;
        }
      }
    }

    if (options.limit && decisionsToFetch.length >= options.limit) {
      break;
    }
  }

  console.log(`\nFound ${decisionsToFetch.length} PDFs to download`);

  if (options.dryRun) {
    console.log('\n--- DRY RUN - No downloads will be performed ---');
    console.log('\nFirst 20 decisions that would be downloaded:');
    for (const d of decisionsToFetch.slice(0, 20)) {
      console.log(`  [${d.database}] ${d.id}`);
    }
    if (decisionsToFetch.length > 20) {
      console.log(`  ... and ${decisionsToFetch.length - 20} more`);
    }
    closeDatabase();
    return;
  }

  if (decisionsToFetch.length === 0) {
    console.log('\nNo PDFs to download. All PDFs are already cached.');
    closeDatabase();
    return;
  }

  // Create PDF extractor
  const pdfExtractor = createPdfExtractor({
    apiKey,
    database: db,
    pdfCache
  });

  // Progress tracking
  const startTime = Date.now();
  let downloaded = 0;
  let failed = 0;
  let totalBytes = 0;

  console.log('\nStarting download...\n');

  for (let i = 0; i < decisionsToFetch.length; i++) {
    const decision = decisionsToFetch[i];
    const progress = `[${i + 1}/${decisionsToFetch.length}]`;

    try {
      console.log(`${progress} Downloading: ${decision.id} (${decision.database})`);

      // Download PDF
      const buffer = await pdfExtractor.downloadPdf(decision.url);

      // Save to cache
      const cacheInfo = await pdfCache.savePdf(decision.id, decision.database, buffer);

      // Track in database
      db.recordPdfCache(
        decision.id,
        cacheInfo.filePath,
        cacheInfo.fileSize,
        cacheInfo.fileHash,
        'pending'  // Will be 'extracted' after text extraction
      );

      downloaded++;
      totalBytes += buffer.length;

      console.log(`${progress} ✓ Saved ${formatBytes(buffer.length)}`);

    } catch (error) {
      failed++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`${progress} ✗ Failed: ${errorMsg}`);
    }

    // Delay between requests (except after last one)
    if (i < decisionsToFetch.length - 1) {
      await sleep(options.delay);
    }
  }

  // Final stats
  const duration = Date.now() - startTime;
  const statsAfter = await pdfCache.getStats();

  console.log('\n' + '='.repeat(60));
  console.log('Prefetch Complete!');
  console.log('='.repeat(60));
  console.log(`  Downloaded: ${downloaded}/${decisionsToFetch.length}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total downloaded: ${formatBytes(totalBytes)}`);
  console.log(`  Duration: ${formatDuration(duration)}`);
  console.log(`  Avg speed: ${(downloaded / (duration / 1000)).toFixed(2)} PDFs/sec`);
  console.log('');
  console.log(`Cache after: ${statsAfter.totalFiles} files (${formatBytes(statsAfter.totalSizeBytes)})`);
  console.log('='.repeat(60));

  // Log JSON for automation
  const logEntry = {
    timestamp,
    downloaded,
    failed,
    totalBytes,
    durationMs: duration,
    cacheFiles: statsAfter.totalFiles,
    cacheSizeBytes: statsAfter.totalSizeBytes
  };
  console.log('\nJSON Log:', JSON.stringify(logEntry));

  closeDatabase();
}

main().catch(error => {
  console.error('Fatal error:', error);
  closeDatabase();
  process.exit(1);
});
