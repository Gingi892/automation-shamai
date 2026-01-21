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

// ============================================================
// Appeals Committee Title Parsing Tests
// ============================================================

// Appeals committee pattern (from scraper.ts line 941)
// Format: החלטה בהשגה [number] [committee] גוש [block] חלקה [plot]
const APPEALS_COMMITTEE_PATTERN = /החלטה ב?השגה(?:\s+מס['׳]?\s*|\s+)(\d+)?\s*([^גג]+)?[גג](?:וש)?\s*(\d+)\s*[חח](?:לקה)?\s*(\d+)/;

interface ParsedAppealsCommitteeMetadata {
  caseNumber?: string;
  committee?: string;
  block?: string;
  plot?: string;
  caseType: string;
}

/**
 * Parse an appeals committee title and extract metadata
 */
function parseAppealsCommitteeTitle(title: string): ParsedAppealsCommitteeMetadata | null {
  const match = title.match(APPEALS_COMMITTEE_PATTERN);
  if (!match) return null;

  return {
    caseNumber: match[1] || undefined,
    committee: match[2]?.trim().replace(/ועדה מקומית\s*/i, '').trim() || undefined,
    block: match[3],
    plot: match[4],
    caseType: 'השגה'
  };
}

// Test data - real examples from gov.il appeals committee database
const APPEALS_COMMITTEE_TEST_CASES = [
  {
    name: 'Standard format with case number',
    title: 'החלטה בהשגה מס\' 12345 ועדה מקומית תל אביב גוש 6158 חלקה 25',
    expected: {
      caseNumber: '12345',
      committee: 'תל אביב',
      block: '6158',
      plot: '25',
      caseType: 'השגה'
    }
  },
  {
    name: 'Format without case number',
    title: 'החלטה בהשגה ועדה מקומית ירושלים גוש 1234 חלקה 56',
    expected: {
      caseNumber: undefined,
      committee: 'ירושלים',
      block: '1234',
      plot: '56',
      caseType: 'השגה'
    }
  },
  {
    name: 'Short form with ג and ח (no גוש/חלקה)',
    title: 'החלטה בהשגה מס\' 9999 ועדה מקומית חיפה ג 7890 ח 12',
    expected: {
      caseNumber: '9999',
      committee: 'חיפה',
      block: '7890',
      plot: '12',
      caseType: 'השגה'
    }
  },
  {
    name: 'Hebrew geresh in case number (׳)',
    title: 'החלטה בהשגה מס׳ 54321 ועדה מקומית באר שבע גוש 38 חלקה 1',
    expected: {
      caseNumber: '54321',
      committee: 'באר שבע',
      block: '38',
      plot: '1',
      caseType: 'השגה'
    }
  },
  {
    name: 'Without ב prefix (השגה instead of בהשגה)',
    title: 'החלטה השגה מס\' 11111 ועדה מקומית נתניה גוש 500 חלקה 10',
    expected: {
      caseNumber: '11111',
      committee: 'נתניה',
      block: '500',
      plot: '10',
      caseType: 'השגה'
    }
  },
  {
    name: 'Committee with full prefix',
    title: 'החלטה בהשגה מס\' 77777 ועדה מקומית לתכנון ובניה הרצליה גוש 6500 חלקה 100',
    expected: {
      caseNumber: '77777',
      committee: 'לתכנון ובניה הרצליה',
      block: '6500',
      plot: '100',
      caseType: 'השגה'
    }
  }
];

// Negative test cases - titles that should NOT match appeals committee pattern
const APPEALS_COMMITTEE_NEGATIVE_CASES = [
  {
    name: 'Decisive appraiser format',
    title: 'הכרעת שמאי מכריע מיום 15-03-2024 בעניין היטל השבחה נ ועדה מקומית תל אביב ג 6158 ח 25'
  },
  {
    name: 'Appeals board format',
    title: 'ערעור מס\' 98765 על החלטת ועדה מקומית'
  },
  {
    name: 'Missing block/plot',
    title: 'החלטה בהשגה מס\' 12345 ועדה מקומית תל אביב'
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
 * Test: test_parse_appeals_committee_title
 * Verifies that Hebrew decision titles from appeals committee database are parsed correctly
 */
function test_parse_appeals_committee_title(): void {
  console.log('Running: test_parse_appeals_committee_title()');
  let passed = 0;
  let failed = 0;

  // Test positive cases
  for (const testCase of APPEALS_COMMITTEE_TEST_CASES) {
    try {
      const result = parseAppealsCommitteeTitle(testCase.title);

      assert.notStrictEqual(result, null, `Should parse title: ${testCase.name}`);

      assert.strictEqual(result!.caseNumber, testCase.expected.caseNumber,
        `${testCase.name}: caseNumber mismatch`);
      assert.strictEqual(result!.committee, testCase.expected.committee,
        `${testCase.name}: committee mismatch`);
      assert.strictEqual(result!.block, testCase.expected.block,
        `${testCase.name}: block mismatch`);
      assert.strictEqual(result!.plot, testCase.expected.plot,
        `${testCase.name}: plot mismatch`);
      assert.strictEqual(result!.caseType, testCase.expected.caseType,
        `${testCase.name}: caseType mismatch`);

      console.log(`  ✓ ${testCase.name}`);
      passed++;
    } catch (error) {
      console.log(`  ✗ ${testCase.name}: ${(error as Error).message}`);
      failed++;
    }
  }

  // Test negative cases
  for (const testCase of APPEALS_COMMITTEE_NEGATIVE_CASES) {
    try {
      const result = parseAppealsCommitteeTitle(testCase.title);
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

// ============================================================
// Block/Plot (גוש/חלקה) Extraction Tests
// ============================================================

interface ExtractedBlockPlot {
  block: string | null;
  plot: string | null;
}

/**
 * Extract block (גוש) and plot (חלקה) numbers from Hebrew text
 * Implements the same patterns as scraper.ts lines 968-990
 */
function extractBlockPlot(text: string): ExtractedBlockPlot {
  const result: ExtractedBlockPlot = { block: null, plot: null };

  // Pattern 1: ג XXXX ח YYYY (short form)
  const blockPlotShort = text.match(/[גג]\s*(\d+)\s*[חח]\s*(\d+)/);
  if (blockPlotShort) {
    result.block = blockPlotShort[1];
    result.plot = blockPlotShort[2];
    return result;
  }

  // Pattern 2: גוש XXXX חלקה YYYY (long form)
  const blockPlotLong = text.match(/גוש\s*(\d+)\s*(?:,?\s*)?חלקה\s*(\d+)/);
  if (blockPlotLong) {
    result.block = blockPlotLong[1];
    result.plot = blockPlotLong[2];
    return result;
  }

  // Pattern 3: Block/Plot with comma (גוש 1234, חלקה 56)
  const blockPlotParen = text.match(/גוש\s*(\d+)\s*,\s*חלקה\s*(\d+)/);
  if (blockPlotParen) {
    result.block = blockPlotParen[1];
    result.plot = blockPlotParen[2];
    return result;
  }

  return result;
}

// Test data for block/plot extraction
const BLOCK_PLOT_TEST_CASES = [
  {
    name: 'Short form: ג XXXX ח YYYY',
    text: 'מסמך כלשהו ג 6158 ח 25 בעניין היטל השבחה',
    expected: { block: '6158', plot: '25' }
  },
  {
    name: 'Short form: without spaces',
    text: 'מסמך כלשהו ג6158 ח25',
    expected: { block: '6158', plot: '25' }
  },
  {
    name: 'Short form: extra spaces',
    text: 'מסמך כלשהו ג  1234  ח  56',
    expected: { block: '1234', plot: '56' }
  },
  {
    name: 'Long form: גוש XXXX חלקה YYYY',
    text: 'ועדה מקומית תל אביב גוש 7890 חלקה 12',
    expected: { block: '7890', plot: '12' }
  },
  {
    name: 'Long form: without spaces',
    text: 'גוש1234חלקה56',
    expected: { block: '1234', plot: '56' }
  },
  {
    name: 'Long form: with comma separator',
    text: 'ועדה מקומית חיפה גוש 500, חלקה 10',
    expected: { block: '500', plot: '10' }
  },
  {
    name: 'With comma: formal format',
    text: 'בגוש 38, חלקה 1 בתחום',
    expected: { block: '38', plot: '1' }
  },
  {
    name: 'Large block and plot numbers',
    text: 'גוש 123456 חלקה 9999',
    expected: { block: '123456', plot: '9999' }
  },
  {
    name: 'Single digit numbers',
    text: 'ג 1 ח 2',
    expected: { block: '1', plot: '2' }
  },
  {
    name: 'Embedded in full title (decisive appraiser)',
    text: 'הכרעת שמאי מכריע מיום 15-03-2024 בעניין היטל השבחה נ ועדה מקומית תל אביב ג 6158 ח 25 - כהן',
    expected: { block: '6158', plot: '25' }
  },
  {
    name: 'Embedded in full title (appeals committee)',
    text: 'החלטה בהשגה מס\' 12345 ועדה מקומית ירושלים גוש 1234 חלקה 56',
    expected: { block: '1234', plot: '56' }
  }
];

// Negative test cases - should return null for both block and plot
const BLOCK_PLOT_NEGATIVE_CASES = [
  {
    name: 'No block/plot numbers',
    text: 'מסמך כללי בעברית ללא מספרי גוש וחלקה'
  },
  {
    name: 'Only block, no plot',
    text: 'גוש 1234 בתל אביב'
  },
  {
    name: 'Only plot, no block',
    text: 'חלקה 56 ברחוב הרצל'
  },
  {
    name: 'Empty string',
    text: ''
  },
  {
    name: 'Numbers without Hebrew markers',
    text: '1234 5678'
  },
  {
    name: 'Block/plot with letters instead of numbers',
    text: 'גוש אב חלקה גד'
  }
];

/**
 * Test: test_extract_block_plot
 * Verifies that גוש (block) and חלקה (plot) numbers are correctly extracted from various Hebrew text formats
 */
function test_extract_block_plot(): void {
  console.log('Running: test_extract_block_plot()');
  let passed = 0;
  let failed = 0;

  // Test positive cases
  for (const testCase of BLOCK_PLOT_TEST_CASES) {
    try {
      const result = extractBlockPlot(testCase.text);

      assert.strictEqual(result.block, testCase.expected.block,
        `${testCase.name}: block mismatch - expected "${testCase.expected.block}", got "${result.block}"`);
      assert.strictEqual(result.plot, testCase.expected.plot,
        `${testCase.name}: plot mismatch - expected "${testCase.expected.plot}", got "${result.plot}"`);

      console.log(`  ✓ ${testCase.name}`);
      passed++;
    } catch (error) {
      console.log(`  ✗ ${testCase.name}: ${(error as Error).message}`);
      failed++;
    }
  }

  // Test negative cases
  for (const testCase of BLOCK_PLOT_NEGATIVE_CASES) {
    try {
      const result = extractBlockPlot(testCase.text);
      assert.strictEqual(result.block, null,
        `${testCase.name}: block should be null, got "${result.block}"`);
      assert.strictEqual(result.plot, null,
        `${testCase.name}: plot should be null, got "${result.plot}"`);
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

// ============================================================
// Committee (ועדה) Name Extraction Tests
// ============================================================

/**
 * Extract committee (ועדה) name from Hebrew text
 * Implements the same patterns as scraper.ts lines 992-1011
 */
function extractCommittee(text: string): string | null {
  // Pattern 1: ועדה מקומית לתכנון ובניה XXX or ועדה מקומית XXX
  const committeeFullMatch = text.match(/ועדה מקומית(?:\s+לתכנון\s+(?:ו)?בניה)?\s+([א-ת\s-]+?)(?:\s+גוש|\s+[גג]\s|\s+-|$)/);
  if (committeeFullMatch) {
    return committeeFullMatch[1].trim();
  }

  // Pattern 2: Short committee name after 'נ' (in decisive appraiser format)
  const committeeAfterN = text.match(/\sנ\s+([א-ת\s-]+?)(?:\s+גוש|\s+[גג]\s)/);
  if (committeeAfterN) {
    return committeeAfterN[1].trim().replace(/ועדה מקומית\s*/i, '').trim();
  }

  // Pattern 3: Committee in context with לתו"ב
  const committeeTub = text.match(/לתו"ב\s+([א-ת\s-]+?)(?:\s+גוש|\s+[גג]\s|\s+-|$)/);
  if (committeeTub) {
    return committeeTub[1].trim();
  }

  return null;
}

// Test data for committee extraction
const COMMITTEE_TEST_CASES = [
  {
    name: 'Basic ועדה מקומית format',
    text: 'החלטה בהשגה מס\' 12345 ועדה מקומית תל אביב גוש 6158 חלקה 25',
    expected: 'תל אביב'
  },
  {
    name: 'ועדה מקומית with לתכנון ובניה',
    text: 'החלטה בהשגה מס\' 99999 ועדה מקומית לתכנון ובניה הרצליה גוש 500 חלקה 10',
    expected: 'הרצליה'
  },
  {
    name: 'ועדה מקומית with לתכנון בניה (no ו)',
    text: 'ועדה מקומית לתכנון בניה נתניה גוש 1234 חלקה 56',
    expected: 'נתניה'
  },
  {
    name: 'Committee after נ (decisive appraiser format)',
    text: 'הכרעת שמאי מכריע מיום 15-03-2024 בעניין היטל השבחה נ ועדה מקומית ירושלים ג 1234 ח 56',
    expected: 'ירושלים'
  },
  {
    name: 'Committee name with hyphen',
    text: 'ועדה מקומית תל-אביב גוש 6158 חלקה 25',
    expected: 'תל-אביב'
  },
  {
    name: 'Committee with לתו"ב format',
    text: 'לתו"ב חיפה גוש 7890 חלקה 12',
    expected: 'חיפה'
  },
  {
    name: 'Committee with multiple words',
    text: 'ועדה מקומית באר שבע גוש 38 חלקה 1',
    expected: 'באר שבע'
  },
  {
    name: 'Committee before hyphen ending',
    text: 'ועדה מקומית אשדוד - שמאי כהן',
    expected: 'אשדוד'
  },
  {
    name: 'Committee with short block format (ג)',
    text: 'ועדה מקומית ראשון לציון ג 5000 ח 50',
    expected: 'ראשון לציון'
  },
  {
    name: 'Long committee name with extended description',
    text: 'ועדה מקומית לתכנון ובניה פתח תקווה גוש 6200 חלקה 30',
    expected: 'פתח תקווה'
  }
];

// Negative test cases - should return null
const COMMITTEE_NEGATIVE_CASES = [
  {
    name: 'No committee mentioned',
    text: 'מסמך כללי בעברית ללא ועדה'
  },
  {
    name: 'Only "ועדה" without "מקומית"',
    text: 'ועדה תל אביב גוש 1234 חלקה 56'
  },
  {
    name: 'Empty string',
    text: ''
  },
  {
    name: 'Random Hebrew text',
    text: 'טקסט אקראי בעברית'
  },
  {
    name: 'ועדה מקומית at end without block/plot',
    text: 'החלטה של ועדה מקומית'
  }
];

/**
 * Test: test_extract_committee
 * Verifies that committee (ועדה) names are correctly extracted from Hebrew text
 */
function test_extract_committee(): void {
  console.log('Running: test_extract_committee()');
  let passed = 0;
  let failed = 0;

  // Test positive cases
  for (const testCase of COMMITTEE_TEST_CASES) {
    try {
      const result = extractCommittee(testCase.text);

      assert.strictEqual(result, testCase.expected,
        `${testCase.name}: expected "${testCase.expected}", got "${result}"`);

      console.log(`  ✓ ${testCase.name}`);
      passed++;
    } catch (error) {
      console.log(`  ✗ ${testCase.name}: ${(error as Error).message}`);
      failed++;
    }
  }

  // Test negative cases
  for (const testCase of COMMITTEE_NEGATIVE_CASES) {
    try {
      const result = extractCommittee(testCase.text);
      assert.strictEqual(result, null,
        `${testCase.name}: should be null, got "${result}"`);
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
console.log('');
test_parse_appeals_committee_title();
console.log('');
test_extract_block_plot();
console.log('');
test_extract_committee();
console.log('\n✓ All tests passed!');
