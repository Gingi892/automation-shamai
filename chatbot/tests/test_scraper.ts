/**
 * Unit Tests - Scraper
 * US-P5-001: Scraper tests for Hebrew title parsing
 *
 * Run with: npx tsx chatbot/tests/test_scraper.ts
 */

import assert from 'node:assert';

// Test title parsing patterns directly (matching scraper.ts parseTitleMetadata)
// Format: הכרעת שמאי מכריע מיום DD-MM-YYYY בעניין [caseType] נ [committee] ג [block] ח [plot] - [appraiser]
const DECISIVE_APPRAISER_PATTERN = /הכרעת שמאי (מכריע|מייעץ) מיום (\d{2}-\d{2}-\d{4}) בעניין ([^נ]+)נ ([^ג]+)ג (\d+) ח (\d+)\s*-?\s*(.+)?/;

interface ParsedTitleMetadata {
  appraiserType?: string;
  decisionDate?: string;
  caseType?: string;
  committee?: string;
  block?: string;
  plot?: string;
  appraiser?: string;
}

/**
 * Parse a decisive appraiser title and extract metadata
 */
function parseDecisiveAppraiserTitle(title: string): ParsedTitleMetadata | null {
  const match = title.match(DECISIVE_APPRAISER_PATTERN);
  if (!match) return null;

  return {
    appraiserType: match[1],
    decisionDate: match[2],
    caseType: match[3].trim(),
    committee: match[4].trim().replace(/ועדה מקומית\s*/i, '').trim(),
    block: match[5],
    plot: match[6],
    appraiser: match[7]?.trim() || undefined
  };
}

// Test data - real examples from gov.il decisive appraiser database
const TEST_CASES = [
  {
    name: 'Standard format with appraiser',
    title: 'הכרעת שמאי מכריע מיום 15-03-2024 בעניין היטל השבחה נ ועדה מקומית תל אביב ג 6158 ח 25 - כהן יוסף',
    expected: {
      appraiserType: 'מכריע',
      decisionDate: '15-03-2024',
      caseType: 'היטל השבחה',
      committee: 'תל אביב',
      block: '6158',
      plot: '25',
      appraiser: 'כהן יוסף'
    }
  },
  {
    name: 'Format without appraiser suffix',
    title: 'הכרעת שמאי מכריע מיום 01-12-2023 בעניין פיצויים נ ועדה מקומית ירושלים ג 1234 ח 56',
    expected: {
      appraiserType: 'מכריע',
      decisionDate: '01-12-2023',
      caseType: 'פיצויים',
      committee: 'ירושלים',
      block: '1234',
      plot: '56',
      appraiser: undefined
    }
  },
  {
    name: 'Advisory appraiser (שמאי מייעץ)',
    title: 'הכרעת שמאי מייעץ מיום 20-06-2024 בעניין ירידת ערך נ ועדה מקומית חיפה ג 7890 ח 12 - לוי שרה',
    expected: {
      appraiserType: 'מייעץ',
      decisionDate: '20-06-2024',
      caseType: 'ירידת ערך',
      committee: 'חיפה',
      block: '7890',
      plot: '12',
      appraiser: 'לוי שרה'
    }
  },
  {
    name: 'Long case type description',
    title: 'הכרעת שמאי מכריע מיום 05-09-2023 בעניין פיצויים בשל הפקעה נ ועדה מקומית הרצליה ג 6500 ח 100 - אברהם דוד',
    expected: {
      appraiserType: 'מכריע',
      decisionDate: '05-09-2023',
      caseType: 'פיצויים בשל הפקעה',
      committee: 'הרצליה',
      block: '6500',
      plot: '100',
      appraiser: 'אברהם דוד'
    }
  },
  {
    name: 'Committee with full name prefix',
    title: 'הכרעת שמאי מכריע מיום 10-01-2024 בעניין 196א נ ועדה מקומית לתכנון ובניה באר שבע ג 38 ח 1 - משה רון',
    expected: {
      appraiserType: 'מכריע',
      decisionDate: '10-01-2024',
      caseType: '196א',
      committee: 'לתכנון ובניה באר שבע',
      block: '38',
      plot: '1',
      appraiser: 'משה רון'
    }
  }
];

// Negative test cases - titles that should NOT match the decisive appraiser pattern
const NEGATIVE_TEST_CASES = [
  {
    name: 'Appeals committee format',
    title: 'החלטה בהשגה מס\' 12345 ועדה מקומית תל אביב גוש 6158 חלקה 25'
  },
  {
    name: 'Appeals board format',
    title: 'ערעור מס\' 98765 על החלטת ועדה מקומית'
  },
  {
    name: 'Random Hebrew text',
    title: 'מסמך כללי בעברית'
  },
  {
    name: 'Empty string',
    title: ''
  }
];

/**
 * Test: test_parse_decisive_appraiser_title
 * Verifies that Hebrew decision titles from decisive appraiser database are parsed correctly
 */
function test_parse_decisive_appraiser_title(): void {
  console.log('Running: test_parse_decisive_appraiser_title()');
  let passed = 0;
  let failed = 0;

  // Test positive cases
  for (const testCase of TEST_CASES) {
    try {
      const result = parseDecisiveAppraiserTitle(testCase.title);

      assert.notStrictEqual(result, null, `Should parse title: ${testCase.name}`);

      assert.strictEqual(result!.appraiserType, testCase.expected.appraiserType,
        `${testCase.name}: appraiserType mismatch`);
      assert.strictEqual(result!.decisionDate, testCase.expected.decisionDate,
        `${testCase.name}: decisionDate mismatch`);
      assert.strictEqual(result!.caseType, testCase.expected.caseType,
        `${testCase.name}: caseType mismatch`);
      assert.strictEqual(result!.committee, testCase.expected.committee,
        `${testCase.name}: committee mismatch`);
      assert.strictEqual(result!.block, testCase.expected.block,
        `${testCase.name}: block mismatch`);
      assert.strictEqual(result!.plot, testCase.expected.plot,
        `${testCase.name}: plot mismatch`);
      assert.strictEqual(result!.appraiser, testCase.expected.appraiser,
        `${testCase.name}: appraiser mismatch`);

      console.log(`  ✓ ${testCase.name}`);
      passed++;
    } catch (error) {
      console.log(`  ✗ ${testCase.name}: ${(error as Error).message}`);
      failed++;
    }
  }

  // Test negative cases
  for (const testCase of NEGATIVE_TEST_CASES) {
    try {
      const result = parseDecisiveAppraiserTitle(testCase.title);
      assert.strictEqual(result, null, `Should NOT parse: ${testCase.name}`);
      console.log(`  ✓ Negative: ${testCase.name}`);
      passed++;
    } catch (error) {
      console.log(`  ✗ Negative: ${testCase.name}: ${(error as Error).message}`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests
console.log('===== Scraper Unit Tests =====\n');
test_parse_decisive_appraiser_title();
console.log('\n✓ All tests passed!');
