#!/usr/bin/env tsx
/**
 * Daily Update Script
 * Checks recent pages of gov.il for new decisions and adds them to the index
 *
 * Usage:
 *   $env:SCRAPER_API_KEY="your_key"; npx tsx scripts/daily-update.ts
 *
 * Options:
 *   --pages=N         Number of recent pages to check per database (default: 5)
 *   --delay=N         Delay in ms between requests (default: 1000)
 */

import { createIndexer } from '../src/indexer.js';
import { getDatabase, closeDatabase } from '../src/database.js';
import { DATABASE_CONFIG, DatabaseType } from '../src/types.js';

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    pages: 5,
    delay: 1000
  };

  for (const arg of args) {
    if (arg.startsWith('--pages=')) {
      options.pages = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--delay=')) {
      options.delay = parseInt(arg.split('=')[1], 10);
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
    console.error('  $env:SCRAPER_API_KEY="your_key"; npx tsx scripts/daily-update.ts');
    process.exit(1);
  }

  const options = parseArgs();
  const timestamp = new Date().toISOString();

  console.log('='.repeat(60));
  console.log(`Gov.il Daily Update - ${timestamp}`);
  console.log('='.repeat(60));
  console.log(`Checking ${options.pages} recent pages per database`);
  console.log('='.repeat(60));

  // Initialize
  const db = await getDatabase();

  // Get current stats
  const statsBefore = db.getStats();
  console.log(`\nCurrent index: ${statsBefore.totalDocuments} documents`);
  console.log(`Last update: ${statsBefore.lastUpdateAt || 'never'}`);

  // Create indexer
  const indexer = createIndexer({
    scraperApiKey: apiKey,
    delayMs: options.delay,
    continueOnError: true
  });

  const startTime = Date.now();

  try {
    await indexer.initialize();

    // Run update
    console.log('\nChecking for new decisions...');
    const results = await indexer.updateRecent(options.pages);

    // Summarize results
    let totalNew = 0;
    console.log('\nResults by database:');
    for (const [dbType, count] of results) {
      console.log(`  ${DATABASE_CONFIG[dbType].name}: ${count} new`);
      totalNew += count;
    }

    // Final stats
    const statsAfter = db.getStats();
    const duration = Math.round((Date.now() - startTime) / 1000);

    console.log('\n' + '='.repeat(60));
    console.log('Update Complete!');
    console.log(`  New documents found: ${totalNew}`);
    console.log(`  Total documents now: ${statsAfter.totalDocuments}`);
    console.log(`  Duration: ${duration}s`);
    console.log('='.repeat(60));

    // Log to file for monitoring
    const logEntry = {
      timestamp,
      newDocuments: totalNew,
      byDatabase: Object.fromEntries(results),
      totalDocuments: statsAfter.totalDocuments,
      durationSeconds: duration
    };
    console.log('\nJSON Log:', JSON.stringify(logEntry));

  } catch (error) {
    console.error('\nError during update:', error);
    process.exit(1);
  } finally {
    closeDatabase();
  }
}

main();
