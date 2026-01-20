#!/usr/bin/env tsx
/**
 * Full Index Script
 * Scrapes ALL decisions from gov.il and populates the SQLite database
 *
 * Usage:
 *   $env:SCRAPER_API_KEY="your_key"; npx tsx scripts/index-all.ts
 *
 * Options:
 *   --max-pages=N     Maximum pages to scrape per database (default: 1000)
 *   --delay=N         Delay in ms between requests (default: 1000)
 *   --database=NAME   Only index specific database (decisive_appraiser, appeals_committee, appeals_board)
 */

import { createIndexer } from '../src/indexer.js';
import { getDatabase, closeDatabase } from '../src/database.js';
import { DatabaseType, DATABASE_CONFIG } from '../src/types.js';

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    maxPages: 1000,
    delay: 1000,
    database: null as DatabaseType | null
  };

  for (const arg of args) {
    if (arg.startsWith('--max-pages=')) {
      options.maxPages = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--delay=')) {
      options.delay = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--database=')) {
      options.database = arg.split('=')[1] as DatabaseType;
    }
  }

  return options;
}

async function main() {
  const apiKey = process.env.SCRAPER_API_KEY;

  if (!apiKey) {
    console.error('Error: SCRAPER_API_KEY environment variable is required');
    console.error('');
    console.error('PowerShell usage:');
    console.error('  $env:SCRAPER_API_KEY="your_key"; npx tsx scripts/index-all.ts');
    console.error('');
    console.error('CMD usage:');
    console.error('  set SCRAPER_API_KEY=your_key && npx tsx scripts/index-all.ts');
    process.exit(1);
  }

  const options = parseArgs();

  console.log('='.repeat(60));
  console.log('Gov.il Land Appraisal Full Index');
  console.log('='.repeat(60));
  console.log(`Max pages per database: ${options.maxPages}`);
  console.log(`Delay between requests: ${options.delay}ms`);
  if (options.database) {
    console.log(`Database filter: ${options.database}`);
  }
  console.log('='.repeat(60));

  // Initialize database
  const db = await getDatabase();
  console.log('\nDatabase initialized');

  // Create indexer
  const indexer = createIndexer({
    scraperApiKey: apiKey,
    maxPages: options.maxPages,
    delayMs: options.delay,
    continueOnError: true,
    onProgress: (progress) => {
      const pctStr = progress.totalPages
        ? `${Math.round((progress.currentPage / progress.totalPages) * 100)}%`
        : '?%';
      process.stdout.write(
        `\r[${DATABASE_CONFIG[progress.database].name}] ` +
        `Page ${progress.currentPage}/${progress.totalPages || '?'} (${pctStr}) - ` +
        `${progress.documentsIndexed} indexed`
      );
    },
    onError: (error, database, page) => {
      console.error(`\n[ERROR] ${database} page ${page}: ${error.message}`);
    }
  });

  const startTime = Date.now();

  try {
    await indexer.initialize();

    // Index SQLite
    if (options.database) {
      console.log(`\nIndexing ${DATABASE_CONFIG[options.database].name}...`);
      await indexer.indexDatabase(options.database);
    } else {
      console.log('\nIndexing all databases...');
      await indexer.indexAll();
    }

    console.log('\n');

    // Get SQLite stats
    const stats = indexer.getStats();
    console.log('\nSQLite Index Complete:');
    console.log(`  Total documents: ${stats.totalDocuments}`);
    for (const [dbType, count] of Object.entries(stats.byDatabase)) {
      console.log(`  - ${DATABASE_CONFIG[dbType as DatabaseType].name}: ${count}`);
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;

    console.log('\n' + '='.repeat(60));
    console.log('Indexing Complete!');
    console.log(`Duration: ${minutes}m ${seconds}s`);
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\nFatal error during indexing:', error);
    process.exit(1);
  } finally {
    closeDatabase();
  }
}

main();
