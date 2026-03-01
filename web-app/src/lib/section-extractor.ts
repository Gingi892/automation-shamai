/**
 * Section extractor for Hebrew appraisal decision documents.
 * Extracts Party A/B claims, final ruling, comparison transactions,
 * and betterment calculation sections from pdf_text.
 */

import type {
  SectionType,
  ExtractedSection,
  ExtractedValue,
  DocumentExtraction,
} from '@/types/api';

// Inlined from shared/extraction-patterns.ts to avoid Turbopack cross-root import issues

/**
 * Normalize text before pattern matching:
 * - Strip zero-width / invisible Unicode chars
 * - Normalize Hebrew quotes and dashes
 * - Collapse whitespace (preserve newlines)
 */
function normalizeText(text: string): string {
  return text
    // Strip zero-width chars
    .replace(/[\u200B\u200C\u200D\uFEFF\u200E\u200F]/g, '')
    // Normalize Hebrew quotes: ״ → ", ׳ → '
    .replace(/\u05F4/g, '"')
    .replace(/\u05F3/g, "'")
    // Normalize dashes: en-dash/em-dash → -
    .replace(/[–—]/g, '-')
    // Collapse \r\n → \n
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Collapse multiple spaces (not newlines) → single space
    .replace(/[^\S\n]+/g, ' ');
}

function parseHebrewNumber(raw: string): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d{1,3}(,\d{3})+$/.test(trimmed)) return parseFloat(trimmed.replace(/,/g, ''));
  if (/^\d+,\d{1,2}$/.test(trimmed)) return parseFloat(trimmed.replace(',', '.'));
  return parseFloat(trimmed.replace(/,/g, ''));
}

function estimatePage(charIndex: number, totalLength: number, charsPerPage: number = 3000): number {
  if (charIndex < 0 || totalLength <= 0) return 1;
  const estimatedTotalPages = Math.max(1, Math.ceil(totalLength / charsPerPage));
  return Math.min(estimatedTotalPages, Math.max(1, Math.ceil(((charIndex + 1) / totalLength) * estimatedTotalPages)));
}

const VALUE_RANGES: Record<string, { min: number; max: number }> = {
  'מקדם': { min: 0.01, max: 2.5 },
  'אחוז': { min: 0, max: 100 },
  'שיעור': { min: 0, max: 100 },
};

function getValueRange(searchTerm: string): { min: number; max: number } | null {
  for (const [keyword, range] of Object.entries(VALUE_RANGES)) {
    if (searchTerm.includes(keyword)) return range;
  }
  return null;
}

function hasHebrewWordsBeforeNumber(windowText: string, numberIndex: number): boolean {
  const textBefore = windowText.substring(0, numberIndex);
  const hebrewWords = textBefore.match(/[\u0590-\u05FF]+/g);
  return hebrewWords !== null && hebrewWords.length >= 3;
}

function extractValuesNearSearchTerm(text: string, searchTerm: string, windowChars: number = 100): number[] {
  if (!text || !searchTerm) return [];
  const values: number[] = [];
  const lowerText = text.toLowerCase();
  const lowerSearch = searchTerm.toLowerCase();
  let startIdx = 0;
  while (true) {
    const idx = lowerText.indexOf(lowerSearch, startIdx);
    if (idx === -1) break;
    const windowStart = idx + searchTerm.length;
    const windowEnd = Math.min(text.length, windowStart + windowChars);
    let window = text.substring(windowStart, windowEnd);
    window = window.replace(/(\d)\s+,\s*(\d)/g, '$1,$2');
    window = window.replace(/(\d)\s*,\s+(\d)/g, '$1,$2');
    const numberPattern = /(\d+(?:[.,]\d+)*)/g;
    const range = getValueRange(searchTerm);
    let match;
    while ((match = numberPattern.exec(window)) !== null) {
      const raw = match[1];
      if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(raw)) continue;
      const afterMatch = window.substring(match.index + raw.length);
      if (/^\.\d{4}/.test(afterMatch)) continue;
      const parsed = parseHebrewNumber(raw);
      if (parsed !== null && !isNaN(parsed) && parsed > 0) {
        if (range && (parsed < range.min || parsed > range.max)) continue;
        if (hasHebrewWordsBeforeNumber(window, match.index)) continue;
        values.push(parsed);
        break;
      }
    }
    startIdx = idx + 1;
  }
  return values;
}

/**
 * Section header patterns validated against 31K documents.
 * Each section type has multiple possible Hebrew headers.
 * Order matters: more specific patterns first.
 */
const SECTION_PATTERNS: Record<SectionType, string[]> = {
  partyA: [
    // "Claims of appraiser" forms (most specific first)
    'עיקר טענות שמאית המבקשת',
    'עיקר טענות שמאי המבקשים',
    'עיקר טענות שמאי המבקש',
    'טענות שמאי המבקשים',
    'טענות שמאי המבקש',
    'טענות שמאית המבקשת',
    'טענות שמאי המבקשת',
    'טענות שמאי המערער',
    'טענות שמאי המערערים',
    'טענות שמאית המערערת',
    'טענות שמאי המערערת',
    'טענות שמאי העורר',
    'טענות שמאי העוררים',
    'טענות שמאית העוררת',
    'טענות שמאי העוררת',
    // "Assessment" forms (שומת = the appraiser's valuation report)
    'שומת בעלי הזכויות בנכס',
    'שומת בעלי הזכויות',
    'שומת שמאי המבקשים',
    'שומת שמאי המבקש',
    'שומת שמאית המבקשת',
    'שומת המבקשים',
    'שומת המבקש',
    'שומת המבקשת',
    'שומת המערערים',
    'שומת המערער',
    'שומת בעל הנכס',
    'שומת הבעלים',
    // General party "claims" forms
    'טענות המבקשים',
    'טענות המבקש',
    'טענות המבקשת',
    'טענות המערערים',
    'טענות המערער',
    'טענות המערערת',
    'טענות העוררים',
    'טענות העורר',
    'טענות העוררת',
    'טענות בעל הנכס',
    'טענות הבעלים',
    // "Position" forms
    'עמדת שמאי המבקשים',
    'עמדת שמאי המבקש',
    'עמדת שמאית המבקשת',
    'עמדת שמאי המבקשת',
    'עמדת המבקשים',
    'עמדת המבקש',
    'עמדת המבקשת',
    'עמדת המערערים',
    'עמדת המערער',
    'עמדת העוררים',
    'עמדת העורר',
    'עמדת בעל הנכס',
    'עמדת שמאי הבעלים',
    'עמדת שמאית הבעלים',
  ],
  partyB: [
    // "Claims of appraiser" forms (most specific first)
    'עיקר טענות שמאי המשיבה',
    'עיקר טענות שמאי הוועדה',
    'עיקר טענות שמאי הועדה',
    'טענות שמאי המשיבה',
    'טענות שמאי המשיבים',
    'טענות שמאי הוועדה',
    'טענות שמאי הועדה',
    'טענות שמאי הרשות',
    // "Assessment" forms
    'שומת הועדה המקומית',
    'שומת הוועדה המקומית',
    'שומת שמאי המשיבה',
    'שומת שמאי הוועדה',
    'שומת שמאי הועדה',
    'שומת המשיבה',
    'שומת המשיבים',
    'שומת הועדה',
    'שומת הוועדה',
    'שומת הרשות',
    // General party "claims" forms
    'טענות המשיבה',
    'טענות המשיבים',
    'טענות הרשות',
    'טענות הועדה המקומית',
    'טענות הוועדה המקומית',
    // "Position" forms
    'עמדת שמאי המשיבה',
    'עמדת שמאי הוועדה',
    'עמדת שמאי הועדה',
    'עמדת המשיבה',
    'עמדת המשיבים',
    'עמדת הועדה',
    'עמדת הוועדה',
    'עמדת הועדה המקומית',
    'עמדת הוועדה המקומית',
    'עמדת הרשות',
  ],
  partiesClaims: [
    'עיקרי טיעוני הצדדים',
    'תמצית שומות הצדדים',
    'סיכום ממצאי שומות הצדדים',
    'ממצאי שומות הצדדים',
    'שומות הצדדים',
    'טענות הצדדים',
    'עמדות הצדדים',
    'טענות הצדדים בתמצית',
    'תמצית טענות הצדדים',
  ],
  ruling: [
    // Specific (longer) patterns first
    'הכרעת השמאי המכריע',
    'קביעת השמאי המכריע',
    'החלטת השמאי המכריע',
    'מסקנות השמאי המכריע',
    'הכרעת השמאית המכריעה',
    // Shorter ruling patterns
    'הכרעת השמאי',
    'קביעת השמאי',
    'החלטת השמאי',
    'הכרעת השמאית',
    // Compound ruling headers
    'עיקרי טיעוני הצדדים והכרעה',
    'התייחסות ומסקנות',
    'מסקנות והכרעה',
    'סיכום והכרעה',
    'דיון והכרעה',
    'ממצאים והכרעה',
    'ניתוח והכרעה',
    // Single-word/short forms
    'הכרעה',
    'קביעה',
    'החלטה',
    'סיכום',
    'מסקנות',
  ],
  comparisons: [
    'עסקאות השוואה',
    'עסקאות ההשוואה',
    'נתוני השוואה',
    'נתוני ההשוואה',
    'נתוני שוק',
    'עסקאות להשוואה',
  ],
  calculation: [
    'תחשיב השבחה',
    'תחשיב ההשבחה',
    'חישוב ההשבחה',
    'חישוב השבחה',
    'חישוב היטל ההשבחה',
    'חישוב היטל השבחה',
  ],
};

/**
 * Patterns for extracting monetary values and measurements from section text.
 */
const VALUE_PATTERNS: RegExp[] = [
  // "100,000 ₪/דונם" or "100,000 ש"ח לדונם"
  /([\d,]+(?:\.\d+)?)\s*(?:₪|ש"ח|שח)\s*[/\\]?\s*(?:דונם|מ"ר|מטר|למ"ר|למטר|לדונם|יח'|יח"ד)/g,
  // "₪ 100,000" or "ש"ח 100,000"
  /(?:₪|ש"ח|שח)\s*([\d,]+(?:\.\d+)?)/g,
  // "100,000 ₪" (amount followed by currency)
  /([\d,]+(?:\.\d+)?)\s*(?:₪|ש"ח)/g,
  // Coefficients: "מקדם X: 0.85"
  /מקדם\s+[\u0590-\u05FF]+(?:\s+[\u0590-\u05FF]+)*\s*[:=\-]?\s*([\d]+[.,][\d]+)/g,
  // Percentages: "15%", "שיעור 15%"
  /([\d.,]+)\s*%/g,
  // Price per sqm: "X למ"ר"
  /([\d,]+(?:\.\d+)?)\s*(?:למ"ר|למטר|לדונם|למ״ר)/g,
];

/**
 * Detect unit from surrounding text context.
 */
function detectUnit(context: string): string | null {
  if (/₪\s*[/\\]?\s*דונם|לדונם/.test(context)) return '₪/דונם';
  if (/₪\s*[/\\]?\s*(?:מ"ר|מטר)|למ"ר|למטר|למ״ר/.test(context)) return '₪/מ"ר';
  if (/₪\s*[/\\]?\s*(?:יח'|יח"ד)/.test(context)) return '₪/יח\'';
  if (/%/.test(context)) return '%';
  if (/מקדם/.test(context)) return 'מקדם';
  if (/₪|ש"ח|שח/.test(context)) return '₪';
  return null;
}

/**
 * Extract monetary/numeric values from a section of text.
 */
function extractValues(sectionText: string, sectionCharIndex: number): ExtractedValue[] {
  const values: ExtractedValue[] = [];
  const seen = new Set<string>();

  for (const pattern of VALUE_PATTERNS) {
    // Reset regex state
    const re = new RegExp(pattern.source, pattern.flags);
    let match;

    while ((match = re.exec(sectionText)) !== null) {
      const raw = match[0];
      const numStr = match[1];

      if (!numStr) continue;

      // Skip dates
      if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(numStr)) continue;

      const numeric = parseHebrewNumber(numStr);
      if (numeric === null || isNaN(numeric) || numeric === 0) continue;

      // Dedup by numeric value + position
      const key = `${numeric}-${match.index}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Get context around the match
      const ctxStart = Math.max(0, match.index - 40);
      const ctxEnd = Math.min(sectionText.length, match.index + raw.length + 40);
      const context = sectionText.substring(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();

      values.push({
        raw,
        numeric,
        unit: detectUnit(context),
        context,
        charIndex: sectionCharIndex + match.index,
      });
    }
  }

  return values;
}

/**
 * Find section boundaries in the document text.
 * Returns the start index and the text of each section.
 */
function findSection(
  pdfText: string,
  sectionType: SectionType
): { title: string; text: string; charIndex: number } | null {
  const patterns = SECTION_PATTERNS[sectionType];
  if (!patterns) return null;

  let bestMatch: { title: string; index: number } | null = null;

  // Numbering prefix: "3." | "3.1" | "3.1.2" | "11 ." | "א." | "א'" | "(2)" | "(א)" | bullet
  // Allow optional space before dot to handle OCR artifacts like "11 ."
  const numberingPrefix = '(?:\\d+(?:\\s?\\.\\d+)*\\s?\\.?|[א-ת][\'׳"]?\\s?\\.?|\\(\\d+\\)|\\([א-ת]\\))';
  // Allow 0-3 extra Hebrew words between numbering and pattern (e.g., "ממצאי", "עיקרי", "תמצית")
  const extraWords = '(?:[\\u0590-\\u05FF"]+\\s+){0,3}';

  for (const pattern of patterns) {
    // Search for the pattern as a section header
    // Anchored after newline or double-space (some PDFs use double-space instead of newline)
    const regex = new RegExp(
      `(?:^|\\n|  )\\s*(?:${numberingPrefix}\\s+)?(?:[\\-•]\\s*)?${extraWords}${escapeRegex(pattern)}\\s*[:.]?`,
      'gm'
    );

    const match = regex.exec(pdfText);
    if (match) {
      // Prefer earlier, more specific matches (pattern order = priority)
      if (!bestMatch || patterns.indexOf(pattern) < patterns.indexOf(bestMatch.title)) {
        bestMatch = { title: pattern, index: match.index + match[0].indexOf(pattern) };
      }
    }
  }

  if (!bestMatch) return null;

  // Find section end: next section header or end of document
  const sectionStart = bestMatch.index + bestMatch.title.length;
  const sectionEnd = findNextSectionStart(pdfText, sectionStart);

  const text = pdfText.substring(sectionStart, sectionEnd).trim();

  // Skip empty sections
  if (text.length < 20) return null;

  return {
    title: bestMatch.title,
    text: text.substring(0, 8000), // Cap at 8000 chars per section
    charIndex: bestMatch.index,
  };
}

/**
 * Find where the next section starts after a given position.
 * Looks for known section headers or common structural markers.
 */
function findNextSectionStart(pdfText: string, fromIndex: number): number {
  const allHeaders = Object.values(SECTION_PATTERNS).flat();
  const numberingPrefix = '(?:\\d+(?:\\s?\\.\\d+)*\\s?\\.?|[א-ת][\'׳"]?\\s?\\.?|\\(\\d+\\)|\\([א-ת]\\))';
  const extraWords = '(?:[\\u0590-\\u05FF"]+\\s+){0,3}';

  let nearestEnd = pdfText.length;

  for (const header of allHeaders) {
    const regex = new RegExp(
      `(?:^|\\n|  )\\s*(?:${numberingPrefix}\\s+)?(?:[\\-•]\\s*)?${extraWords}${escapeRegex(header)}\\s*[:.]?`,
      'gm'
    );
    regex.lastIndex = fromIndex + 1; // +1 to avoid matching same section header

    const match = regex.exec(pdfText);
    if (match && match.index < nearestEnd) {
      nearestEnd = match.index;
    }
  }

  return nearestEnd;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Keyword fallback markers: inline phrases that indicate party claims
 * when formal section headers are absent.
 */
const KEYWORD_FALLBACKS: Record<string, string[]> = {
  partyA: [
    // "Assessment of" forms (found in real docs)
    'שומת בעלי הזכויות בנכס',
    'שומת בעלי הזכויות',
    'שומה מטעם המבקש',
    'שומה מטעם המבקשים',
    // "According to the claim of" forms
    'לטענת שמאי המבקש',
    'לטענת שמאי המבקשים',
    'לטענת שמאית המבקשת',
    'לטענת המבקש',
    'לטענת המבקשים',
    'לטענת המבקשת',
    'לטענת המערער',
    'לטענת המערערים',
    'לטענת העורר',
    'לטענת העוררים',
    // "Expert opinion of" forms
    'בחוות דעת שמאי המבקש',
    'בחוות דעת שמאי המבקשים',
    'בחוות דעת שמאית המבקשת',
    // "Position of" forms
    'עמדת שמאי הבעלים',
    'עמדת שמאית הבעלים',
    'עמדת שמאית המבקש',
    'עמדת שמאי המבקש',
  ],
  partyB: [
    // "Assessment of" forms (found in real docs)
    'שומת הועדה המקומית',
    'שומת הוועדה המקומית',
    'שומה מטעם המשיבה',
    'שומה מטעם הוועדה',
    // "According to the claim of" forms
    'לטענת שמאי המשיבה',
    'לטענת שמאי הוועדה',
    'לטענת שמאי הועדה',
    'לטענת המשיבה',
    'לטענת המשיבים',
    'לטענת הועדה',
    'לטענת הוועדה',
    'לטענת הרשות',
    // "Expert opinion of" forms
    'בחוות דעת שמאי המשיבה',
    'בחוות דעת שמאי הוועדה',
    // "Position of" forms
    'עמדת שמאי המשיבה',
    'עמדת שמאי הוועדה',
    'עמדת שמאי הועדה',
  ],
  ruling: [
    'לאחר ששקלתי',
    'לאחר שבחנתי',
    'לאחר עיון',
    'לאור כל האמור',
    'מכל האמור לעיל',
    'התייחסות ומסקנות',
    'סוף דבר',
    'אשר על כן',
    'לסיכום',
  ],
};

/**
 * Find a section by searching for inline keyword markers.
 * Returns ~3000 chars surrounding the first match.
 */
function findKeywordFallback(
  pdfText: string,
  keywords: string[]
): { keyword: string; text: string; charIndex: number } | null {
  // Search broadly — long docs may have sections deep in the text
  const searchText = pdfText.substring(0, 50000);

  for (const keyword of keywords) {
    const idx = searchText.indexOf(keyword);
    if (idx === -1) continue;

    // Extract ~3000 chars: 500 before, rest after
    const start = Math.max(0, idx - 500);
    const end = Math.min(pdfText.length, idx + 2500);
    const text = pdfText.substring(start, end).trim();

    if (text.length < 30) continue;

    return {
      keyword,
      text: text.substring(0, 8000),
      charIndex: idx,
    };
  }

  return null;
}

/**
 * Extract all sections from a document's pdf_text.
 */
export function extractSections(
  docId: string,
  pdfText: string,
  searchTerm?: string
): DocumentExtraction {
  const extraction: DocumentExtraction = {
    id: docId,
    partyA: null,
    partyB: null,
    ruling: null,
    comparisons: null,
    calculation: null,
    allValues: [],
  };

  if (!pdfText || pdfText.length < 100) return extraction;

  // Normalize text before any pattern matching
  pdfText = normalizeText(pdfText);

  // Try to find partiesClaims first (combined section)
  // If found and partyA/partyB aren't separate, we'll split it
  const partiesClaims = findSection(pdfText, 'partiesClaims');

  // Extract each section
  const sectionKeys: (keyof Pick<DocumentExtraction, 'partyA' | 'partyB' | 'ruling' | 'comparisons' | 'calculation'>)[] = [
    'partyA', 'partyB', 'ruling', 'comparisons', 'calculation',
  ];

  for (const key of sectionKeys) {
    const sectionType = key as SectionType;
    const section = findSection(pdfText, sectionType);

    if (section) {
      const values = extractValues(section.text, section.charIndex);

      extraction[key] = {
        type: sectionType,
        title: section.title,
        text: section.text,
        charIndex: section.charIndex,
        values,
      };

      extraction.allValues.push(...values);
    }
  }

  // If we found a combined "parties' claims" but no separate partyA/partyB,
  // use the combined section as partyA
  if (!extraction.partyA && !extraction.partyB && partiesClaims) {
    const values = extractValues(partiesClaims.text, partiesClaims.charIndex);
    extraction.partyA = {
      type: 'partiesClaims',
      title: partiesClaims.title,
      text: partiesClaims.text,
      charIndex: partiesClaims.charIndex,
      values,
    };
    extraction.allValues.push(...values);
  }

  // Keyword-based fallback: when regex section headers fail,
  // search for inline markers and extract surrounding text
  if (!extraction.partyA) {
    const fallback = findKeywordFallback(pdfText, KEYWORD_FALLBACKS.partyA);
    if (fallback) {
      const values = extractValues(fallback.text, fallback.charIndex);
      extraction.partyA = {
        type: 'partyA',
        title: fallback.keyword,
        text: fallback.text,
        charIndex: fallback.charIndex,
        values,
      };
      extraction.allValues.push(...values);
    }
  }
  if (!extraction.partyB) {
    const fallback = findKeywordFallback(pdfText, KEYWORD_FALLBACKS.partyB);
    if (fallback) {
      const values = extractValues(fallback.text, fallback.charIndex);
      extraction.partyB = {
        type: 'partyB',
        title: fallback.keyword,
        text: fallback.text,
        charIndex: fallback.charIndex,
        values,
      };
      extraction.allValues.push(...values);
    }
  }
  if (!extraction.ruling) {
    const fallback = findKeywordFallback(pdfText, KEYWORD_FALLBACKS.ruling);
    if (fallback) {
      const values = extractValues(fallback.text, fallback.charIndex);
      extraction.ruling = {
        type: 'ruling',
        title: fallback.keyword,
        text: fallback.text,
        charIndex: fallback.charIndex,
        values,
      };
      extraction.allValues.push(...values);
    }
  }

  // If a search term is provided, also extract values near that term from full text
  if (searchTerm) {
    const nearbyValues = extractValuesNearSearchTerm(pdfText, searchTerm);
    for (const numeric of nearbyValues) {
      // Check if we already have this value
      if (!extraction.allValues.some(v => v.numeric === numeric)) {
        const { snippet, charIndex } = getContextForValue(pdfText, searchTerm, numeric);
        extraction.allValues.push({
          raw: String(numeric),
          numeric,
          unit: detectUnit(snippet),
          context: snippet,
          charIndex,
        });
      }
    }
  }

  return extraction;
}

/**
 * Get context snippet for a specific numeric value near a search term.
 */
function getContextForValue(
  pdfText: string,
  searchTerm: string,
  value: number
): { snippet: string; charIndex: number } {
  const lowerText = pdfText.toLowerCase();
  const lowerSearch = searchTerm.toLowerCase();

  let idx = 0;
  while (true) {
    const found = lowerText.indexOf(lowerSearch, idx);
    if (found === -1) break;

    const windowStart = found;
    const windowEnd = Math.min(pdfText.length, found + searchTerm.length + 150);
    const window = pdfText.substring(windowStart, windowEnd);

    // Check if this value appears in this window
    const valueStr = String(value);
    if (window.includes(valueStr) || window.includes(valueStr.replace('.', ','))) {
      const snippet = window.replace(/\s+/g, ' ').trim().substring(0, 120);
      return { snippet, charIndex: found };
    }

    idx = found + 1;
  }

  return { snippet: '', charIndex: -1 };
}

/**
 * Get the primary value (typically a monetary amount) from a section.
 * Returns the first significant monetary value found.
 */
export function getPrimaryValue(section: ExtractedSection | null): ExtractedValue | null {
  if (!section || section.values.length === 0) return null;

  // Prefer values with monetary units
  const monetary = section.values.find(v => v.unit && (v.unit.includes('₪') || v.unit.includes('ש"ח')));
  if (monetary) return monetary;

  // Then coefficients
  const coefficient = section.values.find(v => v.unit === 'מקדם');
  if (coefficient) return coefficient;

  // Then percentages
  const percentage = section.values.find(v => v.unit === '%');
  if (percentage) return percentage;

  // Fallback to first value
  return section.values[0];
}

/**
 * Generate spelling variants for Hebrew search terms.
 * Handles common variations like דחייה/דחיה/דחי.
 */
function generateTermVariants(term: string): string[] {
  const variants = [term];

  // Handle ייה/יה variations (common in Hebrew: דחייה/דחיה)
  if (term.includes('ייה')) {
    variants.push(term.replace(/ייה/g, 'יה'));
  }
  if (term.includes('יה') && !term.includes('ייה')) {
    variants.push(term.replace(/יה/g, 'ייה'));
  }

  // Try truncating final ה from words ending in ייה/יה
  // This catches "דחי" matching both "דחייה" and "דחיה"
  const words = term.split(/\s+/);
  if (words.length >= 2) {
    const lastWord = words[words.length - 1];
    if (/יי?ה$/.test(lastWord)) {
      const truncated = lastWord.replace(/יי?ה$/, 'י');
      variants.push([...words.slice(0, -1), truncated].join(' '));
    }

    // Add variant with definite article ה before second word
    // "מקדם דחייה" → "מקדם הדחייה"
    const withH = [...words.slice(0, -1), 'ה' + lastWord].join(' ');
    variants.push(withH);
    // Also handle ייה/יה for the ה-prefixed variant
    if (lastWord.includes('ייה')) {
      variants.push([...words.slice(0, -1), 'ה' + lastWord.replace('ייה', 'יה')].join(' '));
    }
  }

  return [...new Set(variants)];
}

/**
 * Get the most relevant value from a section for a given search term.
 * Searches for the term within the section text and picks the nearest numeric value.
 * Falls back to getPrimaryValue() when no term-specific match is found.
 */
export function getSearchTermValue(
  section: ExtractedSection | null,
  searchTerm: string | undefined
): ExtractedValue | null {
  if (!section) return null;
  if (!searchTerm || searchTerm.trim().length === 0) return getPrimaryValue(section);

  const text = section.text;
  if (!text || text.length === 0) return getPrimaryValue(section);

  const variants = generateTermVariants(searchTerm.trim());
  const range = getValueRange(searchTerm);

  let bestCandidate: ExtractedValue | null = null;
  let bestDistance = Infinity;

  for (const variant of variants) {
    let searchIdx = 0;
    while (true) {
      const found = text.indexOf(variant, searchIdx);
      if (found === -1) break;

      // Look for numeric values within 150 chars after the term
      const windowStart = found + variant.length;
      const windowEnd = Math.min(text.length, windowStart + 150);
      const window = text.substring(windowStart, windowEnd);

      const numberPattern = /(\d+(?:[.,]\d+)*)/g;
      let match;
      while ((match = numberPattern.exec(window)) !== null) {
        const raw = match[1];

        // Skip dates
        if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(raw)) continue;
        const afterNum = window.substring(match.index + raw.length);
        if (/^\.\d{4}/.test(afterNum)) continue;

        // Skip numbers followed by "שנים"/"שנה" (year counts, not values)
        if (/^\s*שני[םה]?\b/.test(afterNum)) continue;
        // Skip numbers immediately followed by "%" (interest rates like "6%")
        if (/^\s*%/.test(afterNum)) continue;

        const parsed = parseHebrewNumber(raw);
        if (parsed === null || isNaN(parsed) || parsed <= 0) continue;

        // Apply range filter
        if (range && (parsed < range.min || parsed > range.max)) continue;

        // Skip paragraph/section numbers (preceded by many Hebrew words)
        if (hasHebrewWordsBeforeNumber(window, match.index)) continue;

        // Build context
        const ctxStart = Math.max(0, found - 20);
        const ctxEnd = Math.min(text.length, windowStart + match.index + raw.length + 30);
        const context = text.substring(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();

        if (match.index < bestDistance) {
          bestDistance = match.index;
          // When searching for a coefficient (מקדם), force unit to 'מקדם'
          // so values display as plain decimals, not "0.75%"
          const unit = range ? 'מקדם' : detectUnit(context);
          bestCandidate = {
            raw,
            numeric: parsed,
            unit,
            context: context.substring(0, 120),
            charIndex: section.charIndex + found,
          };
        }

        break; // Only take first valid number after each term occurrence
      }

      searchIdx = found + 1;
    }
  }

  if (bestCandidate) return bestCandidate;

  // When searching for a specific parameter type (מקדם, שיעור, etc.) that has
  // a value range, don't fall back to generic values — a blank cell is better
  // than showing an unrelated ₪ amount or percentage.
  if (range) return null;

  return getPrimaryValue(section);
}

/**
 * Extract a value from full document text by searching near the search term.
 * Used as a last-resort fallback when section-specific extraction finds nothing.
 * Places the result in the "ruling" column since we can't determine which party.
 */
export function extractValueFromFullText(
  pdfText: string,
  searchTerm: string
): ExtractedValue | null {
  if (!pdfText || !searchTerm) return null;

  const text = normalizeText(pdfText);
  const variants = generateTermVariants(searchTerm.trim());
  const range = getValueRange(searchTerm);

  // Collect all values near the term, pick the most common (mode)
  const allValues: { value: ExtractedValue; distance: number }[] = [];

  for (const variant of variants) {
    let idx = 0;
    let occurrences = 0;
    while (occurrences < 20) {
      const found = text.indexOf(variant, idx);
      if (found === -1) break;
      occurrences++;

      const windowStart = found + variant.length;
      const windowEnd = Math.min(text.length, windowStart + 150);
      const window = text.substring(windowStart, windowEnd);

      const numberPattern = /(\d+(?:[.,]\d+)*)/g;
      let match;
      while ((match = numberPattern.exec(window)) !== null) {
        const raw = match[1];
        if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(raw)) continue;
        const afterNum = window.substring(match.index + raw.length);
        if (/^\.\d{4}/.test(afterNum)) continue;
        // Skip year counts ("3 שנים") and interest rates ("6%")
        if (/^\s*שני[םה]?\b/.test(afterNum)) continue;
        if (/^\s*%/.test(afterNum)) continue;

        const parsed = parseHebrewNumber(raw);
        if (parsed === null || isNaN(parsed) || parsed <= 0) continue;
        if (range && (parsed < range.min || parsed > range.max)) continue;
        if (hasHebrewWordsBeforeNumber(window, match.index)) continue;

        const ctxStart = Math.max(0, found - 20);
        const ctxEnd = Math.min(text.length, windowStart + match.index + raw.length + 30);
        const context = text.substring(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();

        allValues.push({
          value: {
            raw,
            numeric: parsed,
            unit: range ? 'מקדם' : detectUnit(context),
            context: context.substring(0, 120),
            charIndex: found,
          },
          distance: match.index,
        });
        break;
      }

      idx = found + 1;
    }
  }

  if (allValues.length === 0) return null;

  // Return the value closest to any term occurrence
  allValues.sort((a, b) => a.distance - b.distance);
  return allValues[0].value;
}

/**
 * Format a value for display with its unit.
 */
export function formatExtractedValue(value: ExtractedValue): string {
  if (value.numeric === null) return value.raw;

  const formatted = value.numeric.toLocaleString('he-IL');

  if (value.unit === '₪/מ"ר') return `${formatted} ₪/מ"ר`;
  if (value.unit === '₪/דונם') return `${formatted} ₪/דונם`;
  if (value.unit === '₪/יח\'') return `${formatted} ₪/יח'`;
  if (value.unit === '₪') return `${formatted} ₪`;
  if (value.unit === '%') return `${formatted}%`;
  if (value.unit === 'מקדם') return formatted;

  return formatted;
}

/**
 * Estimate total pages and get page number for a char index.
 */
export function getPageNumber(charIndex: number, totalLength: number): number {
  return estimatePage(charIndex, totalLength);
}
