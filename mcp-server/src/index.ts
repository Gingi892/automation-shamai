#!/usr/bin/env node
/**
 * Gov.il Land Appraisal MCP Server
 * Provides access to Israeli land appraisal decisions with full database access
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js';

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDatabase, closeDatabase, DecisionDatabase } from './database.js';
import { getEmbeddings, EmbeddingsManager, generateQueryEmbedding } from './embeddings.js';
import { closeEmbeddingsStore } from './embeddings-db.js';
import { getPineconeClient, PineconeClient, PineconeQueryResult } from './pinecone-client.js';
import { createIndexer } from './indexer.js';
import { createPdfExtractor, PdfExtractor, PdfExtractionResult } from './pdf-extractor.js';
import { getPdfCache } from './pdf-cache.js';
import { convertToImages, toMcpImageContent, ImageResult } from './pdf-to-image.js';
import {
  DatabaseType,
  SearchParams,
  DATABASE_CONFIG,
  MCPToolResult,
  AmbiguityType,
  ClarificationPrompt,
  ClarifyQueryInput,
  ClarifyQueryResult,
  Decision,
  ConfidenceLevel,
  CitedSource,
  CitedClaim,
  QuotedExcerpt,
  ConstructAnswerInput,
  ConstructAnswerResult,
  ParamType,
  ParameterFilter
} from './types.js';
import { extractParameters, extractParametersBatch } from './parameter-extractor.js';
import { SHAMAI_PROMPTS, getPromptMessages } from './shamai-knowledge/prompts.js';
import { SHAMAI_RESOURCES, getResourceContent } from './shamai-knowledge/resources.js';

// Configuration
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '';

// Context Overflow Prevention Constants
const MAX_OUTPUT_CHARS = 15000;      // ~3,750 tokens - safe for Claude context
const MAX_PDFTEXT_CHARS = 2000;      // Max chars for inline pdfText in responses
const MAX_EXCERPT_CHARS = 500;       // Short excerpt for summaries
const MAX_SEARCH_RESULTS = 50;       // Max documents in search results
const MAX_PDFTEXT_IN_SEARCH = 300;   // Truncated pdfText in search results

// Initialize database (nullable for graceful unavailability handling)
let db: DecisionDatabase | null = null;
let embeddings: EmbeddingsManager | null = null;

/**
 * Helper function to check if database is available and return appropriate error response.
 * Used by all handlers that require database access.
 * @returns Error response if database unavailable, null if database is available
 */
function checkDatabaseAvailable(): MCPToolResult | null {
  if (!db) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Database unavailable',
          errorHe: 'מסד הנתונים אינו זמין',
          suggestion: 'The database is not initialized or has been closed. Please restart the MCP server. If the problem persists, check that the database file exists at ~/.gov-il-mcp/decisions.db and has proper permissions.',
          suggestionHe: 'מסד הנתונים לא אותחל או נסגר. אנא הפעל מחדש את שרת ה-MCP. אם הבעיה נמשכת, בדוק שקובץ מסד הנתונים קיים ב-~/.gov-il-mcp/decisions.db ויש הרשאות מתאימות.',
          possibleCauses: [
            'Server startup failed to initialize database',
            'Database file is missing or corrupted',
            'Insufficient permissions to access database directory',
            'Disk space is full'
          ],
          possibleCausesHe: [
            'הפעלת השרת נכשלה באתחול מסד הנתונים',
            'קובץ מסד הנתונים חסר או פגום',
            'אין הרשאות מספיקות לגישה לתיקיית מסד הנתונים',
            'הדיסק מלא'
          ]
        })
      }],
      isError: true
    };
  }
  return null;
}

/**
 * Helper to execute raw SQL queries on the sql.js database
 * Returns array of objects with column names as keys
 * @param sql - SQL query with ? placeholders
 * @param params - Parameter values
 * @returns Array of row objects, or empty array if no results
 */
function executeRawQuery(sql: string, params: any[] = []): any[] {
  if (!db) return [];
  try {
    // Access the private sql.js database instance
    const sqlJsDb = (db as any).db;
    if (!sqlJsDb) return [];

    const result = sqlJsDb.exec(sql, params);
    if (!result || result.length === 0 || !result[0].values || result[0].values.length === 0) {
      return [];
    }

    // Convert sql.js result format to array of objects
    const columns = result[0].columns;
    const rows: any[] = [];
    for (const values of result[0].values) {
      const row: any = {};
      columns.forEach((col: string, idx: number) => {
        row[col] = values[idx];
      });
      rows.push(row);
    }
    return rows;
  } catch (error) {
    console.error('[executeRawQuery] Error:', error);
    return [];
  }
}

/**
 * Helper to execute raw SQL query that returns a single scalar value
 * @param sql - SQL query with ? placeholders
 * @param params - Parameter values
 * @returns The scalar value, or null if no results
 */
function executeScalarQuery(sql: string, params: any[] = []): any {
  if (!db) return null;
  try {
    const sqlJsDb = (db as any).db;
    if (!sqlJsDb) return null;

    const result = sqlJsDb.exec(sql, params);
    if (!result || result.length === 0 || !result[0].values || result[0].values.length === 0) {
      return null;
    }
    return result[0].values[0][0];
  } catch (error) {
    console.error('[executeScalarQuery] Error:', error);
    return null;
  }
}

/**
 * Value extraction patterns for Hebrew legal documents
 * Used by query_and_aggregate to extract key values from PDF text
 */
const EXTRACTION_PATTERNS: Record<string, RegExp[]> = {
  coefficient: [
    // "מקדם גודל 0.85", "מקדם דחייה 1.5", "מקדם היוון 0.92"
    /מקדם\s+[\u0590-\u05FF]+(?:\s+[\u0590-\u05FF]+)*\s*[:=\-]?\s*([\d]+[.,][\d]+)/gi,
    // "מקדם 0.85" (number right after)
    /מקדם\s*[:=\-]?\s*([\d]+[.,][\d]+)/gi,
    // "0.85 מקדם" (number before)
    /([\d]+[.,][\d]+)\s*מקדם/gi
  ],
  price_per_sqm: [
    /(?:שווי|מחיר|ערך)\s*(?:למ"ר|למטר|ל-מ"ר|למ״ר)?\s*[:=\-]?\s*(?:₪|ש"ח|שח)?\s*([\d,]+)/gi,
    /([\d,]+)\s*(?:₪|ש"ח)\s*(?:למ"ר|למטר|למ״ר)/gi,
    /(?:למ"ר|למטר)\s*[:=\-]?\s*(?:₪|ש"ח)?\s*([\d,]+)/gi
  ],
  percentage: [
    /([\d.,]+)\s*%/g,
    /(?:אחוז|שיעור)\s*[:=]?\s*([\d.,]+)/gi
  ],
  amount: [
    /(?:סכום|שווי|תשלום|פיצוי|היטל)\s*[:=\-]?\s*(?:₪|ש"ח)?\s*([\d,]+(?:,\d{3})*)/gi,
    /(?:₪|ש"ח)\s*([\d,]+(?:,\d{3})*)/gi
  ]
};

/**
 * Parse a number from Hebrew document context.
 * Hebrew convention:
 *   - Comma with exactly 3 trailing digits = thousands separator: 1,500 → 1500
 *   - Comma with 1-2 trailing digits = decimal: 0,85 → 0.85
 *   - Period = decimal: 0.85, 1.275
 */
function parseHebrewNumber(raw: string): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // Thousands separator: "1,500", "12,345,678"
  if (/^\d{1,3}(,\d{3})+$/.test(trimmed)) {
    return parseFloat(trimmed.replace(/,/g, ''));
  }

  // Hebrew/European decimal comma: "0,85", "1,275"
  if (/^\d+,\d{1,2}$/.test(trimmed)) {
    return parseFloat(trimmed.replace(',', '.'));
  }

  // Standard decimal or integer: "0.85", "1.275", "150"
  return parseFloat(trimmed.replace(/,/g, ''));
}

/**
 * Domain-specific value ranges for Israeli land appraisal terms.
 * Used to filter out impossible values (e.g., page numbers, table headers).
 */
const VALUE_RANGES: Record<string, { min: number; max: number }> = {
  'מקדם': { min: 0.01, max: 2.5 },
  'אחוז': { min: 0, max: 100 },
  'שיעור': { min: 0, max: 100 },
};

/**
 * Get the expected value range for a search term based on domain keywords.
 * Returns null if no range constraint applies.
 */
function getValueRange(searchTerm: string): { min: number; max: number } | null {
  for (const [keyword, range] of Object.entries(VALUE_RANGES)) {
    if (searchTerm.includes(keyword)) return range;
  }
  return null;
}

/**
 * Check if there are 3+ Hebrew words between the search term end and the number.
 * This indicates a table header or description row, not an actual value.
 */
function hasHebrewWordsBeforeNumber(windowText: string, numberIndex: number): boolean {
  const textBefore = windowText.substring(0, numberIndex);
  const hebrewWords = textBefore.match(/[\u0590-\u05FF]+/g);
  return hebrewWords !== null && hebrewWords.length >= 3;
}

/**
 * Extract numeric values found near each occurrence of the search term.
 * PRIMARY extraction method — search-term-aware, not pattern-rigid.
 *
 * Strategy: for every occurrence of searchTerm in text, grab a window
 * of characters after it and extract the first plausible number.
 */
function extractValuesNearSearchTerm(
  text: string,
  searchTerm: string,
  windowChars: number = 100
): number[] {
  if (!text || !searchTerm) return [];

  const values: number[] = [];
  const lowerText = text.toLowerCase();
  const lowerSearch = searchTerm.toLowerCase();

  let startIdx = 0;
  while (true) {
    const idx = lowerText.indexOf(lowerSearch, startIdx);
    if (idx === -1) break;

    // Window after the search term
    const windowStart = idx + searchTerm.length;
    const windowEnd = Math.min(text.length, windowStart + windowChars);
    let window = text.substring(windowStart, windowEnd);

    // Fix PDF text artifact: spaces within numbers ("22 ,000" → "22,000")
    window = window.replace(/(\d)\s+,\s*(\d)/g, '$1,$2');
    window = window.replace(/(\d)\s*,\s+(\d)/g, '$1,$2');

    // Find the first number in the window.
    // Matches: 0.85, 1.275, 1,500, 12345, 0,85
    const numberPattern = /(\d+(?:[.,]\d+)*)/g;
    const range = getValueRange(searchTerm);
    let match;
    while ((match = numberPattern.exec(window)) !== null) {
      const raw = match[1];
      // Skip dates: X.X.XXXX or XX.XX.XXXX patterns
      if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(raw)) continue;
      // Skip partial dates: just the "2.4" part of "2.4.2003"
      const afterMatch = window.substring(match.index + raw.length);
      if (/^\.\d{4}/.test(afterMatch)) continue;

      const parsed = parseHebrewNumber(raw);
      if (parsed !== null && !isNaN(parsed) && parsed > 0) {
        // Value range validation: skip numbers outside domain-specific range
        if (range && (parsed < range.min || parsed > range.max)) continue;

        // Table header detection: skip if 3+ Hebrew words appear before the number
        if (hasHebrewWordsBeforeNumber(window, match.index)) continue;

        values.push(parsed);
        break; // take only the FIRST number per occurrence
      }
    }

    startIdx = idx + 1;
  }

  return values;
}

/**
 * Extract values from PDF text using rigid patterns (fallback method).
 */
function extractValuesFromText(text: string, fields: string[]): Record<string, string | null> {
  const result: Record<string, string | null> = {};

  for (const field of fields) {
    const patterns = EXTRACTION_PATTERNS[field];
    if (!patterns) continue;

    for (const pattern of patterns) {
      // Reset regex state
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match && match[1]) {
        result[field] = match[1].trim();
        break;
      }
    }

    if (!result[field]) {
      result[field] = null;
    }
  }

  return result;
}

/**
 * Get context snippet around a search term
 */
function getContextSnippet(text: string, searchTerm: string, contextChars: number = 60): { snippet: string; charIndex: number } {
  if (!text || !searchTerm) return { snippet: '', charIndex: -1 };

  const lowerText = text.toLowerCase();
  const lowerSearch = searchTerm.toLowerCase();
  const idx = lowerText.indexOf(lowerSearch);

  if (idx === -1) return { snippet: '', charIndex: -1 };

  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + searchTerm.length + contextChars);

  let snippet = text.substring(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';

  return { snippet, charIndex: idx };
}

/**
 * Estimate page number from character position in concatenated PDF text.
 * Uses ~3000 chars/page heuristic (consistent with pdf-extractor).
 */
function estimatePage(charIndex: number, totalLength: number, charsPerPage: number = 3000): number {
  if (charIndex < 0 || totalLength <= 0) return 1;
  const estimatedTotalPages = Math.max(1, Math.ceil(totalLength / charsPerPage));
  return Math.min(estimatedTotalPages, Math.max(1, Math.ceil(((charIndex + 1) / totalLength) * estimatedTotalPages)));
}

/**
 * Extract key values from PDF text for summaries
 * Returns commonly needed values without returning full text
 */
function extractKeyValuesFromText(pdfText: string): Record<string, string | number | null> {
  const values: Record<string, string | number | null> = {};

  // Extract using existing patterns
  for (const [field, patterns] of Object.entries(EXTRACTION_PATTERNS)) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(pdfText);
      if (match && match[1]) {
        const rawValue = match[1].replace(/,/g, '').trim();
        const numValue = parseFloat(rawValue);
        values[field] = isNaN(numValue) ? rawValue : numValue;
        break;
      }
    }
  }

  return values;
}

/**
 * Safe output wrapper - prevents context overflow by enforcing size limits
 * All tool handlers should use this wrapper for their responses
 */
function safeOutput(data: any, options?: {
  maxChars?: number;
  allowTruncation?: boolean;
  suffix?: string;
}): MCPToolResult {
  const maxChars = options?.maxChars || MAX_OUTPUT_CHARS;
  const suffix = options?.suffix || '';
  const json = JSON.stringify(data, null, 2);

  if (json.length <= maxChars) {
    return { content: [{ type: 'text', text: json + suffix }] };
  }

  // Response too large - need to truncate intelligently
  console.error(`[safeOutput] Response too large: ${json.length} chars, max: ${maxChars}`);

  // If data has decisions array, reduce it
  if (Array.isArray(data.decisions)) {
    const reducedData = {
      ...data,
      _overflow_warning: true,
      _original_count: data.decisions.length,
      _truncated_to: Math.min(10, data.decisions.length),
      _original_chars: json.length,
      _suggestion: 'Use query_and_aggregate for analytical questions, or add filters to narrow results',
      _suggestionHe: 'השתמש ב-query_and_aggregate לשאלות אנליטיות, או הוסף פילטרים לצמצום התוצאות',
      decisions: data.decisions.slice(0, 10)
    };
    return { content: [{ type: 'text', text: JSON.stringify(reducedData, null, 2) + suffix }] };
  }

  // If data has results array, reduce it
  if (Array.isArray(data.results)) {
    const reducedData = {
      ...data,
      _overflow_warning: true,
      _original_count: data.results.length,
      _truncated_to: Math.min(10, data.results.length),
      _original_chars: json.length,
      _suggestion: 'Use more specific filters to narrow results',
      results: data.results.slice(0, 10)
    };
    return { content: [{ type: 'text', text: JSON.stringify(reducedData, null, 2) + suffix }] };
  }

  // If data has pdfText or fullText, truncate it
  if (data.pdfText || data.fullText) {
    const textField = data.pdfText ? 'pdfText' : 'fullText';
    const fullText = data[textField];
    const reducedData = {
      ...data,
      _overflow_warning: true,
      _text_truncated: true,
      _original_text_chars: fullText.length,
      [textField]: fullText.substring(0, MAX_PDFTEXT_CHARS) + '...',
      _suggestion: 'Use read_pdf with mode="excerpt" or mode="full" for more text',
      _suggestionHe: 'השתמש ב-read_pdf עם mode="excerpt" או mode="full" לטקסט נוסף'
    };
    return { content: [{ type: 'text', text: JSON.stringify(reducedData, null, 2) + suffix }] };
  }

  // Fallback: simple truncation with warning
  const truncatedData = {
    _overflow_warning: true,
    _original_chars: json.length,
    _truncated: true,
    _suggestion: 'Response too large. Use more specific query or query_and_aggregate tool.',
    data: JSON.parse(json.substring(0, maxChars - 200) + '"}')
  };

  try {
    return { content: [{ type: 'text', text: JSON.stringify(truncatedData, null, 2) }] };
  } catch {
    // If JSON parsing fails, return simple error
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          _overflow_error: true,
          _original_chars: json.length,
          _max_chars: maxChars,
          error: 'Response too large for context window',
          suggestion: 'Use query_and_aggregate tool for aggregate queries, or add filters to narrow results'
        }, null, 2)
      }]
    };
  }
}

/**
 * Get user-friendly message for extraction status
 */
function getExtractionNote(status: string | undefined): string | null {
  switch (status) {
    case 'success':
      return null;
    case 'scanned':
      return '📷 מסמך סרוק - הטקסט לא זמין לחיפוש, אך ניתן לצפות בתמונות המסמך באמצעות read_pdf';
    case 'corrupted':
      return '⚠️ קובץ PDF פגום - ניתן לנסות להוריד ישירות מהאתר';
    case 'download_failed':
      return '🔄 ההורדה נכשלה זמנית - נסה שוב מאוחר יותר';
    case 'empty':
      return '📄 המסמך ריק או ללא תוכן טקסטואלי';
    case 'pending':
    default:
      return '⏳ טרם עובד - הטקסט יהיה זמין בקרוב';
  }
}

/**
 * Get alternative access method based on extraction status
 */
function getAlternativeAccess(status: string | undefined, decision: { id: string; url?: string | null }): object | null {
  if (status === 'scanned') {
    return {
      type: 'view_images',
      action: `Use read_pdf with id="${decision.id}" to view document images`,
      actionHe: `השתמש ב-read_pdf עם id="${decision.id}" לצפייה בתמונות המסמך`
    };
  }
  if ((status === 'corrupted' || status === 'download_failed') && decision.url) {
    return {
      type: 'direct_download',
      url: decision.url,
      note: 'Direct PDF download link',
      noteHe: 'קישור ישיר להורדת PDF'
    };
  }
  return null;
}

/**
 * Get extraction status icon for display
 */
function getExtractionIcon(status: string | undefined): string {
  switch (status) {
    case 'success': return '✅';
    case 'scanned': return '📷';
    case 'corrupted': return '⚠️';
    case 'download_failed': return '🔄';
    case 'empty': return '📄';
    default: return '⏳';
  }
}

/**
 * Standard data-collector instructions appended to all search tool responses.
 * Ensures Claude presents raw facts with sources, never summaries or analysis.
 */
const DATA_COLLECTOR_INSTRUCTIONS = `\n\n_instructions:
- הצג כל תוצאה כשורה בטבלה עם: שמאי, גוש/חלקה, שנה, מה נמצא (ציטוט קצר), וקישור ישיר ל-PDF.
- אל תוסיף ממוצעים, סיכומים, פרשנות, או "עקרונות שעולים מההכרעות". כל ערך חייב להיות בר-מעקב למסמך ספציפי.
- אל תנרטב את תהליך החיפוש ("עכשיו אחפש...", "בוא אקרא...") — הצג ישר את הטבלה.
- אם לא נמצאו תוצאות — אמור "לא נמצאו תוצאות" בלבד. אל תציע חלופות.
- הטבלה חייבת להיות RTL. עמודת "מסמך" חייבת להופיע תמיד עם קישור לחיץ ל-PDF.
- **אסור לקרוא מסמכי PDF נוספים.** הצג מה שיש בתוצאות החיפוש. המשתמש יבקש לקרוא מסמך ספציפי אם הוא רוצה.`;

/**
 * Format results as CSV (29% fewer tokens than JSON)
 */
/** Hebrew labels for CSV column headers */
const HEBREW_COLUMN_LABELS: Record<string, string> = {
  decision_id: 'מזהה_החלטה',
  appraiser: 'שמאי',
  committee: 'ועדה',
  block: 'גוש',
  plot: 'חלקה',
  year: 'שנה',
  search_value: 'ערך_שנמצא',
  coefficient: 'מקדם',
  price_per_sqm: 'מחיר_למ"ר',
  percentage: 'אחוז',
  amount: 'סכום',
  context: 'הקשר',
  url: 'מסמך'
};

/** Hebrew labels for stat field names */
const HEBREW_FIELD_LABELS: Record<string, string> = {
  search_value: 'ערך שנמצא ליד מונח החיפוש',
  coefficient: 'מקדם',
  price_per_sqm: 'מחיר למ"ר',
  percentage: 'אחוז',
  amount: 'סכום'
};

function formatResultsAsCSV(
  rows: Array<Record<string, any>>,
  columns: string[],
  summary: Record<string, any>
): string {
  if (rows.length === 0) {
    return `לא נמצאו תוצאות.`;
  }

  // Formatting instructions for Claude Desktop
  let csv = `⚠️ הוראות תצוגה (MANDATORY):
1. הצג טבלה בעברית מימין לשמאל (RTL) — העמודה הראשונה מימין
2. כל שורה היא עובדה קונקרטית ממסמך ספציפי — הצג כמות שהיא
3. עמודת "מסמך" חייבת להופיע תמיד עם קישור לחיץ ל-PDF

`;

  // Header — Hebrew labels
  csv += columns.map(col => HEBREW_COLUMN_LABELS[col] || col).join(',') + '\n';

  // Data rows
  for (const row of rows) {
    const values = columns.map(col => {
      const val = row[col];
      if (val === null || val === undefined) return '';
      // Escape commas and quotes in CSV
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    });
    csv += values.join(',') + '\n';
  }

  // Summary section — counts only (no averages/statistics — the appraiser does their own analysis)
  csv += '\n---\n';
  csv += `סה"כ תוצאות: ${summary.total_matches}\n`;
  csv += `מוצגות: ${summary.showing}\n`;

  return csv;
}

/**
 * Compute summary statistics from all rows
 */
function computeSummaryStats(
  allRows: Array<Record<string, any>>,
  shownRows: number,
  extractFields: string[]
): Record<string, any> {
  const summary: Record<string, any> = {
    total_matches: allRows.length,
    showing: shownRows
  };

  // Compute statistics for numeric fields (with IQR outlier filtering)
  for (const field of extractFields) {
    const rawValues = allRows
      .map(r => r[field])
      .filter(v => v !== null && v !== undefined)
      .map(v => typeof v === 'number' ? v : (parseHebrewNumber(String(v)) ?? NaN))
      .filter(v => !isNaN(v) && v > 0);

    if (rawValues.length === 0) continue;

    // Sort for median/IQR
    const sorted = [...rawValues].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // IQR outlier removal (if >=5 values)
    let values = rawValues;
    let outliers = 0;
    if (sorted.length >= 5) {
      const q1 = sorted[Math.floor(sorted.length * 0.25)];
      const q3 = sorted[Math.floor(sorted.length * 0.75)];
      const iqr = q3 - q1;
      const lower = q1 - 1.5 * iqr;
      const upper = q3 + 1.5 * iqr;
      values = rawValues.filter(v => v >= lower && v <= upper);
      outliers = rawValues.length - values.length;
    }

    const avg = values.length > 0
      ? values.reduce((a, b) => a + b, 0) / values.length
      : rawValues.reduce((a, b) => a + b, 0) / rawValues.length;

    summary[`avg_${field}`] = avg.toFixed(2);
    summary[`median_${field}`] = median.toFixed(2);
    summary[`min_${field}`] = Math.min(...values).toFixed(2);
    summary[`max_${field}`] = Math.max(...values).toFixed(2);
    summary[`count_${field}`] = rawValues.length;
    if (outliers > 0) {
      summary[`outliers_removed_${field}`] = outliers;
    }
  }

  // Group by appraiser
  const byAppraiser: Record<string, number> = {};
  for (const row of allRows) {
    if (row.appraiser) {
      byAppraiser[row.appraiser] = (byAppraiser[row.appraiser] || 0) + 1;
    }
  }
  // Keep top 10
  const topAppraisers = Object.entries(byAppraiser)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (topAppraisers.length > 0) {
    summary.by_appraiser = Object.fromEntries(topAppraisers);
  }

  // Group by year
  const byYear: Record<string, number> = {};
  for (const row of allRows) {
    if (row.year) {
      byYear[row.year] = (byYear[row.year] || 0) + 1;
    }
  }
  if (Object.keys(byYear).length > 0) {
    summary.by_year = byYear;
  }

  return summary;
}

// Tool definitions
const TOOLS: Tool[] = [
  // ============================================================
  // AGGREGATION TOOL - FIRST for routing priority
  // Guaranteed no context overflow - returns pre-computed CSV tables
  // ============================================================
  {
    name: 'query_and_aggregate',
    description: `🎯 TABLE/AGGREGATION TOOL - חיפוש ואגרגציה / Query and aggregate - returns pre-computed CSV table.

## ⭐ USE THIS TOOL FOR TABLES, AGGREGATION, AND MULTI-DOCUMENT COMPARISONS
For natural language questions, prefer semantic_search first (uses real AI vector embeddings on 31K+ docs).
Use THIS tool when you need a structured table of values or statistics across many documents.

## זיהוי אוטומטי / Auto-Detection - Use this tool when user asks:
| Hebrew Pattern | Example |
|----------------|---------|
| "מה ה..." | "מה המקדם בתל אביב?" |
| "כמה..." | "כמה החלטות בנתניה?" |
| "מהו/מהי..." | "מהו השווי למ"ר?" |
| "תכין/צור טבלה" | "תכין טבלה של מקדמי דחייה" |
| "השווה..." | "השווה בין תל אביב לירושלים" |
| "רשימת/כל..." | "כל מקדמי הדחייה ב-2025" |
| Any question about values/prices/coefficients | Automatic |
| "מקדם גודל" / "מקדם דחייה" / "שווי" | Automatic |
| City name + topic (e.g., "ירושלים מקדם") | Automatic |

## CRITICAL: USE THIS TOOL FOR MULTI-DOCUMENT QUERIES
This tool is GUARANTEED to never overflow context because it:
1. Searches ALL matching documents server-side (including full PDF text)
2. Extracts key values (coefficients, prices, percentages)
3. Returns a CSV table (max 50 rows, ~1600 tokens)
4. Includes summary statistics for ALL matches

## מתי להשתמש / When to Use
- Questions about multiple documents ("כל מקדמי הדחייה בתל אביב")
- Requests for tables or comparisons
- Any query that might match 10+ documents
- Any question mentioning a city/committee and a topic

## דוגמאות / Examples
| Query | Parameters |
|-------|------------|
| "מקדמי דחייה בתל אביב 2025" | content_search: "מקדם דחייה", committee: "תל אביב", year: "2025" |
| "שווי למ"ר בנתניה" | content_search: "שווי למ"ר", committee: "נתניה" |
| "אחוזי פיצוי בירושלים" | content_search: "אחוז", committee: "ירושלים" |
| "מקדם גודל ממוצע לירושלים" | content_search: "מקדם גודל", committee: "ירושלים" |

## שאלות מורכבות / Complex Queries
Pass the FULL question as content_search. The tool automatically extracts
key appraisal terms and searches for all of them using OR logic.
DO NOT call multiple times with different phrasings — ONE call is enough.
Example: "מקדם שווי של קרקע ביעוד מגורים ללא זכויות בניה" → automatically splits into key terms.

## פלט / Output Format (CSV)
decision_id,appraiser,committee,block,plot,year,coefficient,price_per_sqm,context
dec_001,כהן,תל אביב,6142,23,2025,0.85,,מקדם דחייה 0.85...
dec_002,לוי,תל אביב,6188,45,2025,0.82,,מקדם 0.82...
---
total_matches: 127
showing: 50
avg_coefficient: 0.83`,
    inputSchema: {
      type: 'object',
      properties: {
        content_search: {
          type: 'string',
          description: 'מונח לחיפוש בתוך PDF (חובה) / Term to search within PDF content (required). Examples: מקדם דחייה, שווי למ"ר, אחוז פיצוי, מקדם גודל'
        },
        committee: {
          type: 'string',
          description: 'סינון לפי ועדה מקומית / Filter by local committee (e.g., תל אביב, נתניה, ירושלים)'
        },
        year: {
          type: 'string',
          description: 'סינון לפי שנה / Filter by year (e.g., 2024, 2025)'
        },
        database: {
          type: 'string',
          enum: ['decisive_appraiser', 'appeals_committee', 'appeals_board'],
          description: 'סינון לפי מאגר / Filter by database'
        },
        caseType: {
          type: 'string',
          description: 'סינון לפי סוג תיק / Filter by case type (e.g., פינוי בינוי, היטל השבחה)'
        },
        extract_fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'שדות לחילוץ / Fields to extract from PDF text',
          default: ['coefficient', 'price_per_sqm', 'percentage']
        },
        max_rows: {
          type: 'number',
          description: 'מקסימום שורות בטבלה / Max rows in output table (default: 50, max: 500). Use export_results for unlimited.',
          default: 50
        },
        param_filter: {
          type: 'object',
          description: 'סינון לפי פרמטרים מובנים (אופציונלי) / Optional pre-extracted parameter filter. Uses indexed parameters instead of runtime regex — faster and more accurate.',
          properties: {
            param_type: { type: 'string', description: 'Parameter type (e.g., coefficient, price_per_meter)' },
            param_subtype: { type: 'string', description: 'Parameter subtype (e.g., גודל, דחייה)' },
            value_min: { type: 'number', description: 'Minimum value' },
            value_max: { type: 'number', description: 'Maximum value' }
          }
        }
      },
      required: ['content_search']
    }
  },
  {
    name: 'search_decisions',
    description: `Search Israeli land appraisal decisions - returns document list.

## ⚠️ CONTEXT OVERFLOW PREVENTION
- Max 50 results per query (use offset for pagination)
- PDF text truncated to 300 chars (use read_pdf for full text)
- For aggregate analysis, use query_and_aggregate instead

## ⚠️ ROUTING GUIDE - READ FIRST
| User Question Type | Use This Tool Instead |
|--------------------|----------------------|
| "מה המקדם/שווי/אחוז ב..." (asking for VALUES) | → query_and_aggregate |
| "תכין טבלה של..." (asking for TABLE) | → query_and_aggregate |
| "כמה החלטות..." (asking for COUNTS) | → query_and_aggregate |
| "השווה בין..." (asking to COMPARE) | → query_and_aggregate |
| "הראה החלטות ב..." (asking for LIST) | ✓ THIS TOOL |
| "מצא החלטות של שמאי כהן" (specific SEARCH) | ✓ THIS TOOL |

## מאגרים / Databases
| Hebrew Keywords | Database ID | Description |
|-----------------|-------------|-------------|
| "שמאי מכריע", "הכרעה", "הכרעת שמאי" | decisive_appraiser | ~10,000+ הכרעות שמאי מכריע |
| "השגה", "ועדת השגות" | appeals_committee | ~5,000+ החלטות ועדת השגות |
| "ערעור", "ועדת ערעורים", "ערר" | appeals_board | ~5,000+ החלטות ועדת ערעורים |

**Default**: If database unclear from query, use decisive_appraiser (largest dataset).

## דוגמאות שאילתות / Query Examples
| User Query (Hebrew) | Expected Parameters |
|---------------------|---------------------|
| "החלטות בנתניה" | { committee: "נתניה" } |
| "גוש 6158 חלקה 25" | { block: "6158", plot: "25" } |
| "היטל השבחה תל אביב" | { caseType: "היטל השבחה", committee: "תל אביב" } |
| "ערעורים מ-2024" | { database: "appeals_board", year: "2024" } |
| "שמאי מכריע כהן" | { database: "decisive_appraiser", appraiser: "כהן" } |
| "פיצויים על הפקעה" | { caseType: "פיצויים" } |
| "החלטות השגה בירושלים 2023" | { database: "appeals_committee", committee: "ירושלים", year: "2023" } |
| "ירידת ערך רעננה" | { caseType: "ירידת ערך", committee: "רעננה" } |

## סוגי תיקים נפוצים / Common Case Types
| Case Type (Hebrew) | English | Description |
|-------------------|---------|-------------|
| היטל השבחה | Betterment Levy | Tax on property value increase due to planning changes |
| פיצויים | Compensation | Compensation for planning restrictions or damages |
| ירידת ערך | Depreciation | Claims for property value decrease due to planning |
| הפקעה | Expropriation | Land expropriation for public purposes |
| תכנית מתאר | Master Plan | Disputes related to master/outline plans |
| שינוי ייעוד | Zoning Change | Land use/zoning designation changes |
| היתר בניה | Building Permit | Building permit related disputes |
| תמ"א 38 | TAMA 38 | National earthquake reinforcement program disputes |
| פינוי בינוי | Urban Renewal | Urban renewal/evacuation-construction projects |
| תב"ע | Zoning Plan | Local zoning/building plan disputes |

**Mapping tip**: When user mentions these terms, use exact Hebrew value for caseType parameter.

## הנחיות חשובות / Important Guidelines (CRITICAL)
**אל תמציא פרמטרים שהמשתמש לא ציין / Don't invent parameters user didn't mention:**
- Extract ONLY parameters the user explicitly mentioned in their query
- Don't invent block/plot numbers if not stated - leave them empty
- Don't assume database if no keywords match the table above - use default
- Don't add caseType unless user mentioned a specific case type
- Don't guess committee/city names - only use what user wrote
- For date ranges, convert Hebrew years (תשפ"ד = 2024) to Gregorian
- When in doubt, use FEWER parameters rather than guessing

Returns results in <100ms from pre-indexed local database.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'שאילתת חיפוש חופשי (תומך בעברית) / Free text search query (Hebrew supported)'
        },
        database: {
          type: 'string',
          enum: ['decisive_appraiser', 'appeals_committee', 'appeals_board'],
          description: 'סינון לפי מאגר מסוים / Filter by specific database: decisive_appraiser=שמאי מכריע, appeals_committee=ועדת השגות, appeals_board=ועדת ערעורים'
        },
        committee: {
          type: 'string',
          description: 'סינון לפי ועדה מקומית (לדוגמה: תל אביב, ירושלים, חיפה) / Filter by local committee name'
        },
        block: {
          type: 'string',
          description: 'סינון לפי מספר גוש (לדוגמה: 6158) / Filter by block number'
        },
        plot: {
          type: 'string',
          description: 'סינון לפי מספר חלקה (לדוגמה: 25) / Filter by plot number'
        },
        appraiser: {
          type: 'string',
          description: 'סינון לפי שם השמאי (לדוגמה: כהן, לוי) / Filter by appraiser name'
        },
        caseType: {
          type: 'string',
          description: 'סינון לפי סוג תיק (לדוגמה: היטל השבחה, פיצויים, ירידת ערך) / Filter by case type'
        },
        year: {
          type: 'string',
          description: 'סינון לפי שנה (מומלץ!) / Filter by year (RECOMMENDED, e.g., "2024"). More reliable than date range.'
        },
        fromDate: {
          type: 'string',
          description: 'סינון מתאריך (פורמט: YYYY-MM-DD) / Filter from date. Note: year filter is more reliable.'
        },
        toDate: {
          type: 'string',
          description: 'סינון עד תאריך (פורמט: YYYY-MM-DD או DD-MM-YYYY) / Filter decisions until this date'
        },
        limit: {
          type: 'number',
          description: 'מספר תוצאות מקסימלי (ברירת מחדל: 50, מקסימום: 50) / Maximum results (max 50 to prevent context overflow)',
          default: 50
        },
        offset: {
          type: 'number',
          description: 'דילוג על תוצאות (לדפדוף) / Skip this many results (for pagination)',
          default: 0
        },
        semanticSearch: {
          type: 'boolean',
          description: 'חיפוש סמנטי/AI במקום חיפוש מילות מפתח / Use semantic/AI search instead of keyword search',
          default: false
        }
      }
    }
  },
  {
    name: 'get_decision',
    description: `קבלת פרטי החלטה מלאים לפי מזהה / Get complete details of a specific decision by its ID.

## מתי להשתמש / When to Use
- After search_decisions returns results, use this to get full details of a specific decision
- When user asks about a specific decision they already know
- To verify decision details before citing in an answer

## מידע מוחזר / Returned Information
| Field | Hebrew | Description |
|-------|--------|-------------|
| id | מזהה | Unique decision identifier |
| title | כותרת | Full decision title |
| url | קישור | Link to PDF document |
| database | מאגר | Source database (decisive_appraiser/appeals_committee/appeals_board) |
| block | גוש | Block number if available |
| plot | חלקה | Plot number if available |
| committee | ועדה | Local committee name |
| appraiser | שמאי | Appraiser name if available |
| caseType | סוג תיק | Case type (היטל השבחה, פיצויים, etc.) |
| decisionDate | תאריך החלטה | Date of the decision |
| publishDate | תאריך פרסום | Publication date |

## דוגמה / Example
Input: { "id": "decisive_appraiser_12345" }
Output: Full decision object with all available fields

## הערות / Notes
- Returns null/error if decision ID not found
- Use read_pdf to get the actual decision text content`,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'מזהה ההחלטה הייחודי / The unique decision ID (e.g., "decisive_appraiser_12345")'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'get_decision_pdf',
    description: `קבלת קישור ל-PDF של ההחלטה / Get the PDF URL for a specific decision document.

## מתי להשתמש / When to Use
- To provide user with direct link to the official decision document
- Before calling read_pdf to verify PDF is available
- When user wants to download or view the original document

## ההבדל בין get_decision_pdf ל-read_pdf / Difference from read_pdf
| Tool | Purpose | Returns |
|------|---------|---------|
| get_decision_pdf | Get link to PDF | URL only (fast, no API key needed) |
| read_pdf | Extract text from PDF | Full text content (requires SCRAPER_API_KEY) |

## פלט / Output
Returns JSON with:
- id: Decision identifier
- title: Decision title
- pdfUrl: Direct URL to PDF document (gov.il)
- database: Source database

## דוגמה / Example
Input: { "id": "decisive_appraiser_12345" }
Output: { "id": "...", "title": "...", "pdfUrl": "https://free-justice.openapi.gov.il/...", "database": "decisive_appraiser" }

## שגיאות אפשריות / Possible Errors
- Decision not found: Invalid ID
- No PDF URL available: Some decisions may not have PDF links`,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'מזהה ההחלטה הייחודי / The unique decision ID'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'read_pdf',
    description: `📄 קריאת PDF / Read PDF Content

## ⚠️ CONTEXT OVERFLOW PREVENTION
This tool uses smart modes to prevent context overflow:

| Mode | Output Size | Use Case |
|------|-------------|----------|
| **summary** (default) | ~500 chars | Quick overview, key values |
| **excerpt** | ~2000 chars | More detail, paginated |
| **full** | ~10000 chars/chunk | Complete text, paginated |

## 🎯 USE mode="summary" FIRST (DEFAULT)
Returns extracted key values + 500 char excerpt.
- coefficient (מקדם)
- price_per_sqm (מחיר למ"ר)
- percentage (%)
- amount (סכום)

## When to use each mode
- **summary**: First call, quick analysis, aggregate patterns
- **excerpt**: Need more context but not full document
- **full**: Deep dive into specific document, legal analysis

## Pagination (for excerpt/full modes)
Use offset parameter to get next chunk:
- First call: offset=0
- Response includes: has_more, next_offset
- Next call: offset=next_offset

## שימוש / Usage
1. First get decision ID from search_decisions
2. Call read_pdf with mode="summary" (default)
3. If more detail needed, use mode="excerpt" or mode="full" with pagination`,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'מזהה ההחלטה (ID) / The decision ID to read PDF from'
        },
        mode: {
          type: 'string',
          enum: ['summary', 'excerpt', 'full'],
          description: 'Output mode: summary (default, ~500 chars), excerpt (~2000 chars), full (paginated chunks)'
        },
        offset: {
          type: 'number',
          description: 'Character offset for pagination in excerpt/full modes (default: 0)'
        },
        chunk_size: {
          type: 'number',
          description: 'Characters per chunk for excerpt/full modes (default: 2000 for excerpt, 10000 for full)'
        },
        maxPages: {
          type: 'number',
          description: 'מספר עמודים מקסימלי לחילוץ (0 = הכל) / Maximum pages to extract from PDF (0 = all)'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'get_statistics',
    description: `קבלת סטטיסטיקות על מאגר ההחלטות / Get statistics about the indexed decisions database.

## מתי להשתמש / When to Use
- To provide user with overview of available data
- To check database health and recency
- When user asks "how many decisions" or "what's available"

## מידע מוחזר / Returned Information
| Field | Hebrew | Description |
|-------|--------|-------------|
| totalDocuments | סה"כ מסמכים | Total number of indexed decisions |
| byDatabase | לפי מאגר | Breakdown by database with Hebrew names |
| lastIndexedAt | אינדוקס אחרון | When the database was last fully indexed |
| lastUpdateAt | עדכון אחרון | When incremental update last ran |

## פירוט מאגרים / Database Breakdown
| Database ID | Hebrew Name | Est. Size |
|-------------|-------------|-----------|
| decisive_appraiser | שמאי מכריע | ~10,000+ |
| appeals_committee | ועדת השגות | ~5,000+ |
| appeals_board | ועדת ערעורים | ~5,000+ |

## דוגמת פלט / Example Output
{
  "totalDocuments": 20000,
  "byDatabase": [
    { "database": "decisive_appraiser", "name": "שמאי מכריע", "count": 10500 },
    { "database": "appeals_committee", "name": "ועדת השגות", "count": 5200 },
    { "database": "appeals_board", "name": "ועדת ערעורים", "count": 4300 }
  ],
  "lastIndexedAt": "2024-01-15T10:30:00Z",
  "lastUpdateAt": "2024-01-20T08:00:00Z"
}`,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  // get_extraction_stats - REMOVED (admin tool, confuses routing)
  {
    name: 'list_committees',
    description: `רשימת כל הוועדות המקומיות במאגר / List all local committees (ועדות מקומיות) that have decisions in the database.

## מתי להשתמש / When to Use
- To show user which cities/committees are available in the database
- To help user select a valid committee name for filtering
- When user asks "which areas have decisions" or "show me available cities"

## מידע מוחזר / Returned Information
- count: Total number of unique committees
- committees: Array of committee names (Hebrew strings)

## דוגמאות ועדות נפוצות / Common Committee Examples
| Hebrew | English |
|--------|---------|
| תל אביב יפו | Tel Aviv-Yafo |
| ירושלים | Jerusalem |
| חיפה | Haifa |
| באר שבע | Beer Sheva |
| נתניה | Netanya |
| ראשון לציון | Rishon LeZion |
| פתח תקווה | Petah Tikva |
| אשדוד | Ashdod |
| הרצליה | Herzliya |
| רעננה | Ra'anana |

## שימוש בתוצאות / Using Results
Use the returned committee name (exactly as spelled) in search_decisions committee parameter:
\`\`\`json
{ "committee": "תל אביב יפו" }
\`\`\`

## דוגמת פלט / Example Output
{
  "count": 150,
  "committees": ["תל אביב יפו", "ירושלים", "חיפה", ...]
}`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'מספר ועדות מקסימלי להחזרה (ברירת מחדל: 100) / Maximum number of committees to return',
          default: 100
        }
      }
    }
  },
  {
    name: 'list_appraisers',
    description: `רשימת כל השמאים במאגר / List all appraisers (שמאים) that have decisions in the database.

## מתי להשתמש / When to Use
- To show user which appraisers have decisions in the database
- To help user select a valid appraiser name for filtering
- When user asks "which appraisers are available" or wants to search by appraiser

## מידע מוחזר / Returned Information
- count: Total number of unique appraisers
- appraisers: Array of appraiser names (Hebrew strings)

## שימוש בתוצאות / Using Results
Use the returned appraiser name (exactly as spelled) in search_decisions appraiser parameter:
\`\`\`json
{ "appraiser": "כהן" }
\`\`\`

## הערה חשובה / Important Note
Appraiser names appear in the decisive_appraiser database primarily.
Appeals committee and appeals board decisions may not have appraiser information.

## דוגמת פלט / Example Output
{
  "count": 85,
  "appraisers": ["כהן יוסף", "לוי דוד", "גרוס משה", ...]
}

## טיפים לחיפוש / Search Tips
- Search by last name (שם משפחה) is more reliable: { "appraiser": "כהן" }
- Full name if known: { "appraiser": "כהן יוסף" }
- Partial matches work: "כהן" will find "כהן יוסף", "כהן דוד", etc.`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'מספר שמאים מקסימלי להחזרה (ברירת מחדל: 100) / Maximum number of appraisers to return',
          default: 100
        }
      }
    }
  },
  // compare_decisions - REMOVED (rarely used, can be done via query_and_aggregate)
  {
    name: 'semantic_search',
    description: `🔍 BEST FOR NATURAL LANGUAGE - חיפוש סמנטי עם AI embeddings / Semantic search powered by real vector embeddings (31K+ documents).

## ⭐ USE THIS TOOL FIRST when the user asks a conceptual or natural language question in Hebrew.
This tool uses OpenAI vector embeddings over 31,000+ documents for TRUE semantic understanding.
It finds relevant decisions even when exact keywords don't appear in the text.

## מתי להשתמש / When to Use THIS Tool
| Hebrew Pattern | Example |
|----------------|---------|
| Conceptual questions | "הגבהת בניין בקומות נוספות" |
| Natural language | "פיצויים על הפקעה ליד הים" |
| Topic exploration | "מה המגמה בפסיקות על היטל השבחה" |
| Finding similar cases | "תיקים דומים לשלי" |
| Value/coefficient questions | "מקדם דחייה באזור המרכז" |
| Any free-text Hebrew question | Understands meaning, not just keywords |

## מתי להשתמש ב-query_and_aggregate במקום / When to Use query_and_aggregate Instead
- When you need a CSV TABLE of values across many documents
- When aggregating statistics (averages, counts)
- When user explicitly asks for a table or comparison

## מתי להשתמש ב-search_decisions במקום / When to Use search_decisions Instead
- When exact block/plot numbers are given: "גוש 6158 חלקה 25"

## יתרונות / Advantages
- מבין עברית חופשית / Understands free Hebrew text
- מוצא דומיות מושגית / Finds conceptual similarity even without keyword match
- מדרג לפי רלוונטיות אמיתית / Ranks by true semantic relevance (0-1 score)
- מהיר: ~300ms לחיפוש ב-31K מסמכים / Fast: ~300ms for 31K documents

## פלט / Output
Results include relevanceScore (0-1) indicating semantic similarity to query.
Response includes source field: 'vector-embeddings' (real AI) or 'keyword-fallback'.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'שאילתת חיפוש בשפה טבעית (עברית מומלץ) / Natural language search query (Hebrew recommended)'
        },
        limit: {
          type: 'number',
          description: 'מספר תוצאות מקסימלי (ברירת מחדל: 20) / Maximum number of results',
          default: 20
        },
        database: {
          type: 'string',
          enum: ['decisive_appraiser', 'appeals_committee', 'appeals_board'],
          description: 'סינון לפי מאגר מסוים (אופציונלי) / Filter by specific database (optional): decisive_appraiser=שמאי מכריע, appeals_committee=ועדת השגות, appeals_board=ועדת ערעורים'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'trigger_update',
    description: `הפעלת עדכון לשליפת החלטות חדשות מ-gov.il / Trigger an incremental update to fetch new decisions from gov.il.

## מתי להשתמש / When to Use
- When user asks "check for new decisions"
- When database needs to be refreshed with latest data
- When user suspects missing recent decisions
- NOT for routine use - updates run automatically via cron

## דרישות / Requirements
- SCRAPER_API_KEY environment variable must be set
- Internet access to gov.il

## איך זה עובד / How It Works
1. Checks first N pages of each database (most recent decisions)
2. Compares content hash to detect new decisions
3. Adds only decisions not already in database
4. Updates lastUpdateAt timestamp

## פרמטרים / Parameters
| Parameter | Default | Description |
|-----------|---------|-------------|
| pagesToCheck | 5 | Number of recent pages to scan per database |

Pages × 10 items = decisions checked per database
Example: pagesToCheck=5 → ~50 recent decisions per database → ~150 total

## פלט / Output
{
  "success": true,
  "newDecisionsFound": 12,
  "byDatabase": {
    "decisive_appraiser": 5,
    "appeals_committee": 4,
    "appeals_board": 3
  },
  "timestamp": "2024-01-20T10:30:00Z"
}

## עדכון אוטומטי / Automatic Updates
Daily cron job runs: \`npm run daily-update\`
This tool is for manual/on-demand updates only.

## שגיאות אפשריות / Possible Errors
- Missing SCRAPER_API_KEY: Cannot fetch from gov.il
- Network error: gov.il unreachable
- Scraping blocked: ScraperAPI issue`,
    inputSchema: {
      type: 'object',
      properties: {
        pagesToCheck: {
          type: 'number',
          description: 'מספר עמודים אחרונים לבדוק להחלטות חדשות (ברירת מחדל: 5, מומלץ: 3-10) / Number of recent pages to check for new decisions (default: 5, recommended: 3-10)',
          default: 5
        }
      }
    }
  },
  // clarify_query - REMOVED (internal helper, confuses routing)
  // construct_answer - REMOVED (internal helper, confuses routing)
  {
    name: 'health_check',
    description: `בדיקת תקינות השרת והתקנה / Verify MCP server setup and health status.

## מתי להשתמש / When to Use
- After first installation to verify setup is complete
- When troubleshooting connection issues
- When Claude appears unable to access decisions
- To check if database is populated
- To verify SCRAPER_API_KEY is configured for live updates

## מה נבדק / What Is Checked
| Component | Check | Description |
|-----------|-------|-------------|
| Database | Connection | Can connect to SQLite database |
| Database | Populated | Has decisions indexed |
| Database | FTS5 | Full-text search working |
| API Key | Configured | SCRAPER_API_KEY set for updates |
| Embeddings | Available | ChromaDB/semantic search ready |

## פלט / Output Format
{
  "healthy": true,
  "status": {
    "database": { "connected": true, "decisionCount": 10500, "fts5Working": true },
    "scraperApi": { "configured": true },
    "embeddings": { "available": true },
    "server": { "version": "2.0.0", "uptime": "5m" }
  },
  "issues": [],
  "suggestions": []
}

## פלט עם בעיות / Output with Issues
{
  "healthy": false,
  "status": { ... },
  "issues": ["Database is empty - run npm run index-all"],
  "issuesHe": ["מסד הנתונים ריק - הרץ npm run index-all"],
  "suggestions": ["Set SCRAPER_API_KEY for live updates"],
  "suggestionsHe": ["הגדר SCRAPER_API_KEY לעדכונים חיים"]
}`,
    inputSchema: {
      type: 'object',
      properties: {
        verbose: {
          type: 'boolean',
          description: 'פירוט מלא כולל סטטיסטיקות לפי מאגר / Include detailed statistics per database',
          default: false
        }
      }
    }
  },
  {
    name: 'get_analytics',
    description: `שאילתות אנליטיות על מאגר ההחלטות / Run analytical queries on the decisions database.

## מתי להשתמש / When to Use
- To answer questions like "מי השמאי עם הכי הרבה החלטות?"
- For trend analysis: "כמה החלטות בשנה?"
- For comparative analysis: "באילו ועדות יש הכי הרבה תיקי היטל השבחה?"

## סוגי שאילתות / Query Types
| query_type | Hebrew | Description |
|------------|--------|-------------|
| decisions_by_committee | החלטות לפי ועדה | Count per local committee |
| decisions_by_year | החלטות לפי שנה | Count per year |
| decisions_by_appraiser | החלטות לפי שמאי | Count per appraiser |
| decisions_by_case_type | החלטות לפי סוג תיק | Count per case type |
| avg_decisions_per_month | ממוצע החלטות לחודש | Monthly average |

## דוגמאות שאילתות / Query Examples
| User Question | query_type |
|---------------|------------|
| "מי השמאי עם הכי הרבה החלטות?" | decisions_by_appraiser |
| "כמה החלטות היו בכל שנה?" | decisions_by_year |
| "באילו ועדות יש הכי הרבה היטל השבחה?" | decisions_by_committee (+ filter) |
| "מה הממוצע החודשי?" | avg_decisions_per_month |

## פלט / Output
Returns structured JSON with:
- query_type: The type of query executed
- results: Array of {name, count} or single value
- total: Total count across all results`,
    inputSchema: {
      type: 'object',
      properties: {
        query_type: {
          type: 'string',
          enum: ['decisions_by_committee', 'decisions_by_year', 'decisions_by_appraiser', 'decisions_by_case_type', 'avg_decisions_per_month'],
          description: 'סוג השאילתה האנליטית / Type of analytical query to run'
        },
        limit: {
          type: 'number',
          description: 'מספר תוצאות מקסימלי (ברירת מחדל: 50) / Maximum number of results',
          default: 50
        },
        database: {
          type: 'string',
          enum: ['decisive_appraiser', 'appeals_committee', 'appeals_board'],
          description: 'סינון לפי מאגר / Filter by specific database (optional)'
        }
      },
      required: ['query_type']
    }
  },
  // get_pdf_cache_stats - REMOVED (admin tool, not user-facing)
  // cleanup_pdf_cache - REMOVED (admin tool, not user-facing)
  {
    name: 'compare_committees',
    description: `השוואת סטטיסטיקות בין ועדות מקומיות / Compare statistics between local committees (cities).

## מתי להשתמש / When to Use - CRITICAL
**USE THIS TOOL** instead of search_decisions when user asks:
- "השווה בין תל אביב לירושלים" / Compare Tel Aviv to Jerusalem
- "כמה החלטות יש בכל עיר?" / How many decisions per city?
- "באיזו עיר יש הכי הרבה תיקים?" / Which city has the most cases?
- "מה ההבדל בין ועדות?" / What's the difference between committees?

**DO NOT** use search_decisions for comparative questions - it returns raw documents and overwhelms context!

## יתרונות / Advantages
- Returns COMPUTED STATISTICS, not raw documents
- Saves context window - returns ~200 bytes instead of ~50KB
- Instant response - no document scanning needed

## פלט לדוגמה / Example Output
{
  "committees": ["תל אביב", "ירושלים"],
  "comparison": [
    {"committee": "תל אביב", "total": 1250, "by_year": {"2024": 150, "2023": 200}, "by_case_type": {"היטל השבחה": 800}},
    {"committee": "ירושלים", "total": 980, "by_year": {"2024": 120, "2023": 180}, "by_case_type": {"היטל השבחה": 600}}
  ],
  "summary": "תל אביב has 27% more decisions than ירושלים"
}`,
    inputSchema: {
      type: 'object',
      properties: {
        committees: {
          type: 'array',
          items: { type: 'string' },
          description: 'רשימת ועדות להשוואה (2-5 מומלץ) / List of committees to compare (2-5 recommended). Example: ["תל אביב", "ירושלים"]'
        },
        database: {
          type: 'string',
          enum: ['decisive_appraiser', 'appeals_committee', 'appeals_board'],
          description: 'סינון לפי מאגר (אופציונלי) / Filter by database (optional)'
        },
        year: {
          type: 'string',
          description: 'סינון לפי שנה (אופציונלי) / Filter by year (optional)'
        },
        caseType: {
          type: 'string',
          description: 'סינון לפי סוג תיק (אופציונלי) / Filter by case type (optional)'
        }
      },
      required: ['committees']
    }
  },
  {
    name: 'get_summary_stats',
    description: `קבלת סטטיסטיקות מסכמות עם סינון / Get summary statistics with optional filters.

## מתי להשתמש / When to Use - CRITICAL
**USE THIS TOOL** instead of search_decisions when user asks:
- "כמה החלטות יש בתל אביב?" / How many decisions in Tel Aviv?
- "מה המגמה בשנים האחרונות?" / What's the trend in recent years?
- "כמה שמאים פעילים?" / How many active appraisers?
- "התפלגות לפי סוג תיק" / Distribution by case type

**This tool returns ONLY statistics, not documents!**

## פרמטרים / Parameters
All filters are optional - combine as needed:
- committee: Filter by city/committee
- database: Filter by database type
- year: Filter by specific year
- caseType: Filter by case type

## פלט לדוגמה / Example Output
{
  "filters_applied": {"committee": "תל אביב"},
  "total_decisions": 1250,
  "by_year": [{"year": "2024", "count": 150}, {"year": "2023", "count": 200}],
  "by_case_type": [{"type": "היטל השבחה", "count": 800}, {"type": "פיצויים", "count": 200}],
  "by_appraiser": [{"name": "כהן", "count": 50}, {"name": "לוי", "count": 45}],
  "unique_appraisers": 25,
  "date_range": {"earliest": "2018-01-15", "latest": "2024-12-01"}
}`,
    inputSchema: {
      type: 'object',
      properties: {
        committee: {
          type: 'string',
          description: 'סינון לפי ועדה מקומית / Filter by local committee'
        },
        database: {
          type: 'string',
          enum: ['decisive_appraiser', 'appeals_committee', 'appeals_board'],
          description: 'סינון לפי מאגר / Filter by database'
        },
        year: {
          type: 'string',
          description: 'סינון לפי שנה / Filter by year'
        },
        caseType: {
          type: 'string',
          description: 'סינון לפי סוג תיק / Filter by case type'
        },
        appraiser: {
          type: 'string',
          description: 'סינון לפי שמאי / Filter by appraiser'
        }
      }
    }
  },
  // search_and_extract - REMOVED (deprecated, superseded by query_and_aggregate)
  // smart_search - REMOVED (redundant with query_and_aggregate)
  // ============================================================
  // PROGRESSIVE DISCLOSURE TOOLS (Layer 1, 2, 3)
  // These tools implement the progressive disclosure pattern:
  // Layer 1: search_decisions_index - returns lightweight metadata
  // Layer 2: get_decision_summaries - returns summaries for specific IDs
  // Layer 3: get_decision_detail - returns full content for single ID
  // ============================================================
  {
    name: 'search_decisions_index',
    description: `חיפוש קל - לדפדוף בלבד / Lightweight search - for BROWSING only.

## ⚠️ FOR BROWSING, NOT ANALYSIS
Use query_and_aggregate for analytical questions (מה המקדם, כמה החלטות, etc.)
Use this tool ONLY to browse/list decisions without extracting values.

## Progressive Disclosure - Layer 1 (INDEX)
Returns lightweight metadata (~100 tokens per result). For browsing document lists.

## מה מוחזר / What's Returned
| Field | Tokens | Description |
|-------|--------|-------------|
| id | ~10 | Decision identifier |
| title | ~20 | Short title |
| date | ~5 | Decision date |
| committee | ~10 | Local committee |
| database | ~5 | Source database |
| relevance_score | ~5 | Match quality 0-1 |

## Typical Token Usage
- 50 results × ~50 tokens = ~2,500 tokens total
- Compare to search_decisions: 50 results × ~500 tokens = ~25,000 tokens!

## Workflow
1. **search_decisions_index** → See what exists (this tool)
2. **get_decision_summaries** → Get details for interesting IDs
3. **get_decision_detail** → Full content if needed

## דוגמה / Example
User: "החלטות בתל אביב 2024"
Tool returns: 50 results with IDs, titles, dates, scores
Then: Call get_decision_summaries for top 5-10 IDs`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'שאילתת חיפוש חופשי / Free text search query'
        },
        database: {
          type: 'string',
          enum: ['decisive_appraiser', 'appeals_committee', 'appeals_board'],
          description: 'סינון לפי מאגר / Filter by database'
        },
        committee: {
          type: 'string',
          description: 'סינון לפי ועדה מקומית / Filter by local committee'
        },
        block: {
          type: 'string',
          description: 'סינון לפי מספר גוש / Filter by block number'
        },
        plot: {
          type: 'string',
          description: 'סינון לפי מספר חלקה / Filter by plot number'
        },
        appraiser: {
          type: 'string',
          description: 'סינון לפי שם השמאי / Filter by appraiser'
        },
        caseType: {
          type: 'string',
          description: 'סינון לפי סוג תיק / Filter by case type'
        },
        year: {
          type: 'string',
          description: 'סינון לפי שנה / Filter by year'
        },
        limit: {
          type: 'number',
          description: 'מספר תוצאות מקסימלי (ברירת מחדל: 50) / Maximum results',
          default: 50
        },
        offset: {
          type: 'number',
          description: 'דילוג לדפדוף / Offset for pagination',
          default: 0
        }
      }
    }
  },
  {
    name: 'get_decision_summaries',
    description: `קבלת סיכומים למספר החלטות / Get summaries for multiple decisions.

## Progressive Disclosure - Layer 2 (SUMMARIES)
Use AFTER search_decisions_index to get more details for interesting results.

## מה מוחזר / What's Returned
| Field | Tokens | Description |
|-------|--------|-------------|
| id | ~10 | Decision identifier |
| title | ~30 | Full title |
| summary | ~100 | First 500 chars of PDF text |
| key_values | ~50 | Extracted coefficients, prices, percentages |
| committee | ~10 | Local committee |
| appraiser | ~10 | Appraiser name |
| caseType | ~10 | Case type |
| block/plot | ~10 | Property identifiers |

## Typical Token Usage
- 10 summaries × ~200 tokens = ~2,000 tokens total
- Enough to understand content without reading full PDFs

## Workflow
1. search_decisions_index → 50 results (~2,500 tokens)
2. **get_decision_summaries** → 10 summaries (~2,000 tokens) ← THIS TOOL
3. get_decision_detail → 1-2 full docs if needed

## דוגמה / Example
Input: { ids: ["decisive_appraiser_123", "decisive_appraiser_456", ...] }
Output: Summaries with key extracted values for each`,
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'רשימת מזהי החלטות (עד 20) / List of decision IDs (max 20)'
        }
      },
      required: ['ids']
    }
  },
  {
    name: 'get_decision_detail',
    description: `📋 פרטי החלטה / Decision Details

## ⚠️ CONTEXT OVERFLOW PREVENTION
By default returns METADATA + KEY VALUES + EXCERPT only.
Full PDF text NOT included by default to prevent overflow.

## Default Output (~500 tokens)
| Field | Description |
|-------|-------------|
| metadata | All fields (committee, appraiser, block, plot, etc.) |
| key_values | Extracted: coefficient, price_per_sqm, percentage, amount |
| excerpt | First 500 chars of PDF text |
| pdf_text_available | Whether full text exists |

## For Full PDF Text
Use read_pdf tool with the decision ID instead:
- read_pdf mode="summary" → Key values + 500 char excerpt
- read_pdf mode="excerpt" → 2000 chars, paginated
- read_pdf mode="full" → Full text, paginated

## When to Use This Tool
- Get complete metadata for a decision
- Quick overview without full text
- Check if PDF text is available

## דוגמה / Example
Input: { id: "decisive_appraiser_123" }
Output: Metadata + key_values + excerpt (NOT full text)`,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'מזהה ההחלטה הייחודי / The unique decision ID'
        },
        include_summary: {
          type: 'boolean',
          description: 'Include key_values and excerpt (default: true)',
          default: true
        },
        include_pdf_text: {
          type: 'boolean',
          description: '⚠️ Include full PDF text - may cause overflow! (default: FALSE)',
          default: false
        }
      },
      required: ['id']
    }
  },
  // ============================================================
  // EXPORT TOOL - For unlimited result sets
  // Writes ALL results to local CSV file
  // ============================================================
  {
    name: 'export_results',
    description: `📥 ייצוא כל התוצאות לאקסל / Export ALL results to Excel file (.xls)

Use when user wants ALL results (hundreds/thousands), not just top 50.
Writes Excel file (RTL, Hebrew headers, formatted table) and returns: file path + summary statistics.
No token limit — can export thousands of results.

## מתי להשתמש / When to Use
- User says "כל התוצאות", "הכל", "ALL results", "ייצוא", "אקסל", "טבלה לאקסל"
- User wants to analyze data in Excel
- query_and_aggregate shows total_matches >> showing
- User needs a complete dataset for external analysis

## דוגמה / Example
export_results(content_search="פינוי בינוי", committee="תל אביב")
→ Returns: { file: "~/.gov-il-mcp/exports/export_....xls", total: 347, summary: {...} }

## Output
Returns file path (opens in Excel with RTL Hebrew table) + summary statistics.
Does NOT return the data inline — it's written to a file.
Tell the user the file path so they can open it.`,
    inputSchema: {
      type: 'object',
      properties: {
        content_search: {
          type: 'string',
          description: 'מונח לחיפוש בתוך PDF (חובה) / Term to search within PDF content (required)'
        },
        committee: {
          type: 'string',
          description: 'סינון לפי ועדה מקומית / Filter by local committee'
        },
        year: {
          type: 'string',
          description: 'סינון לפי שנה / Filter by year'
        },
        database: {
          type: 'string',
          enum: ['decisive_appraiser', 'appeals_committee', 'appeals_board'],
          description: 'סינון לפי מאגר / Filter by database'
        },
        caseType: {
          type: 'string',
          description: 'סינון לפי סוג תיק / Filter by case type'
        },
        extract_fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'שדות לחילוץ / Fields to extract from PDF text',
          default: ['coefficient', 'price_per_sqm', 'percentage']
        }
      },
      required: ['content_search']
    }
  },
  // ============================================================
  // PARAMETER EXTRACTION TOOLS
  // ============================================================
  {
    name: 'search_by_parameters',
    description: `חיפוש לפי פרמטרים מובנים / Search by pre-extracted structured parameters.

## מתי להשתמש / When to Use
Use AFTER parameters have been extracted. Returns decisions filtered by pre-indexed values.
Faster and more accurate than runtime regex in query_and_aggregate.

## סוגי פרמטרים / Parameter Types
| param_type | Hebrew | Description |
|---|---|---|
| city | עיר | City name |
| neighborhood | שכונה | Neighborhood name |
| area_zone | אזור | Area/zone (industrial, etc.) |
| land_use | ייעוד | Land use: מגורים, תעשייה, מסחר, etc. |
| coefficient | מקדם | Coefficients (with subtype: גודל, דחייה, היוון, etc.) |
| price_per_meter | מחיר למ"ר | Price per sqm (subtype: אקוויולנטי, נטו, ברוטו) |
| land_value | שווי קרקע | Land value per dunam |
| building_rights_value | שווי זכויות בנייה | Building rights value |
| comparison_transaction | עסקת השוואה | Comparison transactions |
| tradability_fee | דמי סחירות | Tradability fee per sqm |
| sovereignty_rate | שיעור ריבון | Sovereignty rate (%) |
| building_plan | תוכנית בנייה | Building plan names |

## דוגמאות / Examples
| Query | Parameters |
|-------|-----------|
| "מקדמי גודל בתל אביב" | param_type: "coefficient", param_subtype: "גודל", committee: "תל אביב" |
| "שווי למ"ר נטו מעל 5000" | param_type: "price_per_meter", param_subtype: "נטו", value_min: 5000 |
| "החלטות עם ייעוד מגורים" | param_type: "land_use", value_text: "מגורים" |`,
    inputSchema: {
      type: 'object',
      properties: {
        param_type: {
          type: 'string',
          enum: ['city', 'neighborhood', 'area_zone', 'land_use', 'coefficient', 'price_per_meter', 'land_value', 'building_rights_value', 'comparison_transaction', 'tradability_fee', 'sovereignty_rate', 'building_plan'],
          description: 'סוג הפרמטר לחיפוש / Parameter type to search by'
        },
        param_subtype: {
          type: 'string',
          description: 'תת-סוג (למשל: גודל, דחייה למקדם) / Sub-type filter (e.g., גודל for coefficient)'
        },
        value_min: {
          type: 'number',
          description: 'ערך מינימלי (לפרמטרים מספריים) / Minimum numeric value'
        },
        value_max: {
          type: 'number',
          description: 'ערך מקסימלי (לפרמטרים מספריים) / Maximum numeric value'
        },
        value_text: {
          type: 'string',
          description: 'חיפוש טקסט (לפרמטרים טקסטואליים) / Text search for text-based parameters'
        },
        committee: {
          type: 'string',
          description: 'סינון לפי ועדה / Filter by committee'
        },
        year: {
          type: 'string',
          description: 'סינון לפי שנה / Filter by year'
        },
        database: {
          type: 'string',
          enum: ['decisive_appraiser', 'appeals_committee', 'appeals_board'],
          description: 'סינון לפי מאגר / Filter by database'
        },
        min_confidence: {
          type: 'number',
          description: 'רמת ביטחון מינימלית (0-1, ברירת מחדל: 0.5) / Minimum confidence (default: 0.5)'
        },
        limit: {
          type: 'number',
          description: 'מקסימום תוצאות (ברירת מחדל: 50) / Max results (default: 50)',
          default: 50
        }
      },
      required: ['param_type']
    }
  },
  {
    name: 'get_decision_parameters',
    description: `הצגת כל הפרמטרים המובנים של החלטה / View all extracted structured parameters for a specific decision.

## מתי להשתמש / When to Use
- After search returns a decision and you want to see ALL extracted values
- To verify what parameters were extracted from a specific document
- To check extraction quality and confidence scores

## פלט / Output
Returns all parameters grouped by type with confidence scores and context snippets.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'מזהה ההחלטה / Decision ID'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'extract_parameters',
    description: `הפעלת חילוץ פרמטרים / Trigger parameter extraction for decisions.

## מתי להשתמש / When to Use
- First time setup: extract parameters from all existing documents
- After new documents are indexed: extract from unprocessed docs
- Re-extract with LLM for better comparison transaction data

## מצבים / Modes
- batch_size=10: Quick test on 10 documents
- batch_size=100: Incremental batch
- use_llm=true: Include LLM extraction for comparison transactions (slower, costs ~$0.001/doc)`,
    inputSchema: {
      type: 'object',
      properties: {
        decision_id: {
          type: 'string',
          description: 'מזהה החלטה ספציפי (אופציונלי) / Specific decision ID to extract (optional)'
        },
        batch_size: {
          type: 'number',
          description: 'מספר מסמכים לעיבוד (ברירת מחדל: 50) / Number of documents to process (default: 50)',
          default: 50
        },
        use_llm: {
          type: 'boolean',
          description: 'שימוש ב-LLM לעסקאות השוואה / Use LLM for comparison transactions',
          default: false
        }
      }
    }
  }
];

// Tool handlers
async function handleSearchDecisions(params: SearchParams): Promise<MCPToolResult> {
  // Check database availability
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  // CHANGED: Max limit reduced from 500 to MAX_SEARCH_RESULTS (50) to prevent overflow
  const searchParams: SearchParams = {
    query: params.query,
    database: params.database,
    committee: params.committee,
    block: params.block,
    plot: params.plot,
    appraiser: params.appraiser,
    caseType: params.caseType,
    fromDate: params.fromDate,
    toDate: params.toDate,
    year: params.year,
    limit: Math.min(params.limit || 50, MAX_SEARCH_RESULTS),
    offset: params.offset || 0,
    semanticSearch: params.semanticSearch
  };

  // Use semantic search if requested and available
  if (searchParams.semanticSearch && searchParams.query && embeddings) {
    const semanticResults = await embeddings.search(
      searchParams.query,
      Math.min(searchParams.limit || 20, MAX_SEARCH_RESULTS),
      searchParams.database ? { database: searchParams.database } : undefined
    );

    return safeOutput({
      searchType: 'semantic',
      query: searchParams.query,
      totalCount: semanticResults.length,
      decisions: semanticResults.map(r => ({
        ...r.decision,
        // Truncate pdfText in semantic results too
        pdfText: r.decision.pdfText
          ? (r.decision.pdfText.length > MAX_PDFTEXT_IN_SEARCH
              ? r.decision.pdfText.substring(0, MAX_PDFTEXT_IN_SEARCH) + '... [use read_pdf for full]'
              : r.decision.pdfText)
          : null,
        relevanceScore: r.score,
        // Add extraction status info
        _status_icon: getExtractionIcon(r.decision.extractionStatus),
        _extraction_note: getExtractionNote(r.decision.extractionStatus),
        _alternative: getAlternativeAccess(r.decision.extractionStatus, r.decision)
      }))
    }, { suffix: DATA_COLLECTOR_INSTRUCTIONS });
  }

  // Regular search
  const result = db!.search(searchParams);

  // CHANGED: Truncate to MAX_PDFTEXT_IN_SEARCH (300) chars to prevent overflow
  // Also add extraction status info for user awareness
  const decisionsWithTruncatedText = result.decisions.map(d => ({
    ...d,
    pdfText: d.pdfText
      ? (d.pdfText.length > MAX_PDFTEXT_IN_SEARCH
          ? d.pdfText.substring(0, MAX_PDFTEXT_IN_SEARCH) + '... [use read_pdf for full]'
          : d.pdfText)
      : null,
    // Add extraction status info
    _status_icon: getExtractionIcon(d.extractionStatus),
    _extraction_note: getExtractionNote(d.extractionStatus),
    _alternative: getAlternativeAccess(d.extractionStatus, d)
  }));

  // Use safeOutput wrapper to guarantee no overflow
  return safeOutput({
    searchType: 'keyword',
    query: searchParams,
    totalCount: result.totalCount,
    showing: decisionsWithTruncatedText.length,
    offset: searchParams.offset || 0,
    hasMore: result.hasMore,
    next_offset: result.hasMore ? (searchParams.offset || 0) + decisionsWithTruncatedText.length : null,
    note: `PDF text truncated to ${MAX_PDFTEXT_IN_SEARCH} chars. Use read_pdf tool for full text.`,
    tip: 'For aggregate analysis across many documents, use query_and_aggregate tool instead.',
    decisions: decisionsWithTruncatedText
  }, { suffix: DATA_COLLECTOR_INSTRUCTIONS });
}

async function handleGetDecision(params: { id: string }): Promise<MCPToolResult> {
  // Check database availability
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const decision = db!.getDecision(params.id);

  if (!decision) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Decision not found',
          id: params.id,
          suggestion: 'Use search_decisions tool first to find valid decision IDs. Try searching by committee, block/plot, or case type.',
          suggestionHe: 'השתמש בכלי search_decisions כדי למצוא מזהי החלטות תקינים. נסה לחפש לפי ועדה, גוש/חלקה, או סוג תיק.'
        })
      }],
      isError: true
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(decision, null, 2)
    }]
  };
}

async function handleGetDecisionPdf(params: { id: string }): Promise<MCPToolResult> {
  // Check database availability
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const decision = db!.getDecision(params.id);

  if (!decision) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Decision not found',
          id: params.id,
          suggestion: 'Use search_decisions tool first to find valid decision IDs. Try searching by committee, block/plot, or case type.',
          suggestionHe: 'השתמש בכלי search_decisions כדי למצוא מזהי החלטות תקינים. נסה לחפש לפי ועדה, גוש/חלקה, או סוג תיק.'
        })
      }],
      isError: true
    };
  }

  if (!decision.url) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'No PDF URL available for this decision',
          id: params.id,
          title: decision.title,
          suggestion: 'This decision was indexed without a PDF link. Try get_decision to see available metadata, or search for similar decisions that may have PDFs.',
          suggestionHe: 'החלטה זו נוספה למאגר ללא קישור ל-PDF. נסה get_decision לראות מידע זמין, או חפש החלטות דומות שיש להן PDF.'
        })
      }],
      isError: true
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        id: decision.id,
        title: decision.title,
        pdfUrl: decision.url,
        database: decision.database
      }, null, 2)
    }]
  };
}

async function handleReadPdf(params: {
  id: string;
  maxPages?: number;
  mode?: 'summary' | 'excerpt' | 'full';  // NEW: Controls output size
  offset?: number;      // NEW: For pagination in 'full' mode
  chunk_size?: number;  // NEW: Chars per chunk (default 10000)
}): Promise<MCPToolResult> {
  // Mode determines output size:
  // - 'summary' (default): Key values + 500 char excerpt - ALWAYS fits in context
  // - 'excerpt': 2000 chars with pagination info
  // - 'full': Full text in paginated chunks

  const mode = params.mode || 'summary';
  const chunkSize = params.chunk_size || 10000;
  const offset = params.offset || 0;

  // Helper to format response based on mode
  function formatPdfResponse(
    pdfText: string,
    metadata: { id: string; title: string; database?: string; source: string; cached?: boolean }
  ): MCPToolResult {
    const totalChars = pdfText.length;

    if (mode === 'summary') {
      // Extract key values and short context - guaranteed to fit
      const keyValues = extractKeyValuesFromText(pdfText);
      const excerpt = pdfText.substring(0, MAX_EXCERPT_CHARS);

      return safeOutput({
        ...metadata,
        mode: 'summary',
        key_values: keyValues,
        excerpt: excerpt + (totalChars > MAX_EXCERPT_CHARS ? '...' : ''),
        total_chars: totalChars,
        has_extracted_values: Object.keys(keyValues).length > 0,
        next_step: totalChars > MAX_EXCERPT_CHARS
          ? 'Use mode="excerpt" for more text or mode="full" for complete document'
          : 'Full text shown above (document is short)'
      });
    }

    if (mode === 'excerpt') {
      // Return 2000 chars with pagination
      const excerptChars = params.chunk_size || MAX_PDFTEXT_CHARS;
      const text = pdfText.substring(offset, offset + excerptChars);

      return safeOutput({
        ...metadata,
        mode: 'excerpt',
        text: text,
        offset: offset,
        showing_chars: text.length,
        total_chars: totalChars,
        has_more: offset + excerptChars < totalChars,
        next_offset: offset + excerptChars < totalChars ? offset + excerptChars : null,
        progress: `${Math.min(offset + text.length, totalChars)}/${totalChars} chars`
      });
    }

    // mode === 'full' - Paginated full text
    const chunk = pdfText.substring(offset, offset + chunkSize);
    return safeOutput({
      ...metadata,
      mode: 'full',
      text: chunk,
      offset: offset,
      chunk_size: chunkSize,
      total_chars: totalChars,
      has_more: offset + chunkSize < totalChars,
      next_offset: offset + chunkSize < totalChars ? offset + chunkSize : null,
      progress: `${Math.min(offset + chunkSize, totalChars)}/${totalChars} chars`
    });
  }

  // Try to get decision from SQLite first - check for CACHED text before requiring network
  let decision: { id: string; title: string; url: string; database?: string; pdfText?: string | null } | null = null;
  let source: 'sqlite' | 'pinecone' = 'sqlite';

  // First try SQLite (for backwards compatibility and cached data)
  if (db) {
    const sqliteDecision = db.getDecision(params.id);
    if (sqliteDecision && sqliteDecision.url) {
      decision = {
        id: sqliteDecision.id,
        title: sqliteDecision.title,
        url: sqliteDecision.url,
        database: sqliteDecision.database,
        pdfText: sqliteDecision.pdfText  // Include cached text!
      };

      // If we have cached text, return formatted response based on mode
      if (sqliteDecision.pdfText && sqliteDecision.pdfText.length > 30) {
        return formatPdfResponse(sqliteDecision.pdfText, {
          id: sqliteDecision.id,
          title: sqliteDecision.title,
          database: sqliteDecision.database,
          source: 'sqlite',
          cached: true
        });
      }
    }
  }

  // If not found in SQLite, try Pinecone
  if (!decision) {
    const pinecone = getPineconeClient();
    if (pinecone) {
      try {
        const pineconeResult = await pinecone.fetchById(params.id);
        if (pineconeResult && pineconeResult.metadata.url) {
          const pdfText = (pineconeResult.metadata.description as string | undefined) || null;
          decision = {
            id: pineconeResult.id,
            title: pineconeResult.metadata.title || 'Unknown Title',
            url: pineconeResult.metadata.url,
            database: pineconeResult.metadata.database,
            pdfText: pdfText
          };
          source = 'pinecone';

          // If Pinecone has cached text, return formatted response based on mode
          if (pdfText && pdfText.length > 30) {
            return formatPdfResponse(pdfText, {
              id: pineconeResult.id,
              title: pineconeResult.metadata.title || 'Unknown Title',
              database: pineconeResult.metadata.database,
              source: 'pinecone',
              cached: true
            });
          }
        }
      } catch (error) {
        console.error('[handleReadPdf] Pinecone lookup failed:', error);
      }
    }
  }

  // If still not found, return error
  if (!decision) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Decision not found',
          id: params.id,
          suggestion: 'Use semantic_search or search_decisions tool first to find valid decision IDs. Try searching by committee, block/plot, or case type.',
          suggestionHe: 'השתמש בכלי semantic_search או search_decisions כדי למצוא מזהי החלטות תקינים. נסה לחפש לפי ועדה, גוש/חלקה, או סוג תיק.'
        })
      }],
      isError: true
    };
  }

  // Only require SCRAPER_API_KEY if we need to fetch from network (no cached text found)
  if (!SCRAPER_API_KEY) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'No cached text available and SCRAPER_API_KEY not set',
          id: params.id,
          suggestion: 'Set SCRAPER_API_KEY to enable PDF reading from gov.il, or sync from Pinecone using sync-pinecone-to-sqlite.mjs',
          suggestionHe: 'הגדר SCRAPER_API_KEY כדי לקרוא PDF מ-gov.il, או סנכרן מ-Pinecone'
        })
      }],
      isError: true
    };
  }

  try {
    // Create PDF extractor with database for text caching and file cache for PDFs
    const pdfExtractor = createPdfExtractor(SCRAPER_API_KEY, {
      maxPages: params.maxPages || 0,
      database: db || undefined,
      pdfCache: getPdfCache()  // Add file cache for offline access
    });

    // Determine database type for file cache organization
    const databaseType = (decision.database as DatabaseType) || 'decisive_appraiser';

    // Smart extraction: tries text first, indicates if document is scanned
    // Uses three-tier cache: text cache → file cache → network download
    // Threshold lowered to 30 chars for Hebrew (compact language, RTL processing removes chars)
    const extraction = await pdfExtractor.smartExtract(decision.id, decision.url, 30, databaseType);

    if (extraction.type === 'text') {
      // Text extraction successful - return formatted response based on mode
      const result = extraction.result;
      return formatPdfResponse(result.fullText, {
        id: decision.id,
        title: decision.title,
        database: decision.database,
        source, // 'sqlite' or 'pinecone' - indicates where decision was found
        cached: result.cached
      });
    } else {
      // Scanned document - convert to images for Claude's vision capabilities
      console.error(`[handleReadPdf] Converting scanned PDF to images for decision ${decision.id}`);

      try {
        // Convert PDF pages to images (first 3-5 pages)
        const images = await convertToImages(extraction.pdfBuffer, {
          maxPages: 5,
          scale: 1.5,
          jpegQuality: 80
        });

        if (images.length > 0) {
          // Return images in MCP format for Claude's vision
          const mcpImages = toMcpImageContent(images);

          // Create content array with metadata first, then images
          const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/jpeg' }> = [
            {
              type: 'text',
              text: JSON.stringify({
                id: decision.id,
                title: decision.title,
                database: decision.database,
                source, // 'sqlite' or 'pinecone' - indicates where decision was found
                extractionType: 'scanned_images',
                note: 'This PDF is a scanned document. The following images contain the document pages.',
                noteHe: 'המסמך סרוק. התמונות הבאות מכילות את דפי המסמך.',
                pagesConverted: images.length,
                imageSizes: images.map(img => ({
                  page: img.pageNumber,
                  width: img.width,
                  height: img.height,
                  sizeKB: Math.round(img.sizeBytes / 1024)
                })),
                instruction: 'Please read the Hebrew text from these images and extract the relevant information. The document is a land appraisal decision.',
                instructionHe: 'אנא קרא את הטקסט העברי מהתמונות וחלץ את המידע הרלוונטי. המסמך הוא החלטת שמאות מקרקעין.'
              }, null, 2)
            },
            ...mcpImages
          ];

          console.error(`[handleReadPdf] Returning ${images.length} images for scanned document`);

          return { content: content as any };
        }
      } catch (imageError) {
        console.error(`[handleReadPdf] Failed to convert PDF to images:`, imageError);
      }

      // Fallback if image conversion fails - return URL for manual viewing
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            id: decision.id,
            title: decision.title,
            database: decision.database,
            source, // 'sqlite' or 'pinecone' - indicates where decision was found
            extractionType: 'scanned',
            note: 'This PDF is a scanned document with no extractable text. Image conversion failed.',
            noteHe: 'המסמך סרוק ואינו מכיל טקסט שניתן לחילוץ. ההמרה לתמונות נכשלה.',
            pdfUrl: extraction.pdfUrl,
            suggestion: 'You can view the PDF directly using the URL above. Ask the user to describe what they see or provide specific quotes from the document.',
            suggestionHe: 'ניתן לצפות ב-PDF ישירות בקישור למעלה. בקש מהמשתמש לתאר מה הוא רואה או לספק ציטוטים ספציפיים מהמסמך.'
          }, null, 2)
        }]
      };
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Failed to read PDF',
          id: params.id,
          message: error instanceof Error ? error.message : String(error),
          suggestion: 'PDF extraction failed. Possible causes: (1) PDF is corrupted or password-protected, (2) Network timeout - try again, (3) gov.il server temporarily unavailable. Try get_decision_pdf to verify the URL is valid.',
          suggestionHe: 'חילוץ ה-PDF נכשל. סיבות אפשריות: (1) PDF פגום או מוגן בסיסמה, (2) פסק זמן ברשת - נסה שוב, (3) שרת gov.il אינו זמין זמנית. נסה get_decision_pdf לוודא שהכתובת תקינה.'
        })
      }],
      isError: true
    };
  }
}

async function handleGetStatistics(): Promise<MCPToolResult> {
  // Check database availability
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const stats = db!.getStats();

  const databaseNames: Record<DatabaseType, string> = {
    decisive_appraiser: 'שמאי מכריע',
    appeals_committee: 'ועדת השגות',
    appeals_board: 'ועדת ערעורים'
  };

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        totalDocuments: stats.totalDocuments,
        byDatabase: Object.entries(stats.byDatabase).map(([key, count]) => ({
          database: key,
          name: databaseNames[key as DatabaseType],
          count
        })),
        // US-004: Breakdown by committee (top 20)
        byCommittee: stats.byCommittee,
        // US-004: Breakdown by case type
        byCaseType: stats.byCaseType,
        // US-004: Breakdown by year
        byYear: stats.byYear,
        // US-004: Date range of indexed decisions
        dateRange: {
          oldest: stats.oldestDecision,
          newest: stats.newestDecision
        },
        lastIndexedAt: stats.lastIndexedAt,
        lastUpdateAt: stats.lastUpdateAt
      }, null, 2)
    }]
  };
}

async function handleGetExtractionStats(): Promise<MCPToolResult> {
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const stats = db!.getExtractionStats();
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  const processed = total - (stats.pending || 0);
  const extractionRate = total > 0 ? ((processed / total) * 100).toFixed(1) : '0';

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        total,
        ...stats,
        processed,
        extraction_rate: `${extractionRate}%`,
        summary: {
          success_rate: total > 0 ? `${((stats.success || 0) / total * 100).toFixed(1)}%` : '0%',
          scanned_note: 'מסמכים סרוקים - ניתן לצפות בתמונות באמצעות read_pdf',
          corrupted_note: 'קבצים פגומים - ניתן לנסות להוריד ישירות מ-gov.il',
          download_failed_note: 'הורדות שנכשלו - יתבצע ניסיון חוזר אוטומטי'
        }
      }, null, 2)
    }]
  };
}

async function handleListCommittees(params: { limit?: number }): Promise<MCPToolResult> {
  // Check database availability
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  // US-005: Returns committees with decision counts, sorted alphabetically
  const committees = db!.getDistinctValuesWithCounts('committee', params.limit || 100);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        count: committees.length,
        committees
      }, null, 2)
    }]
  };
}

async function handleListAppraisers(params: { limit?: number }): Promise<MCPToolResult> {
  // Check database availability
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const appraisers = db!.getDistinctValues('appraiser', params.limit || 100);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        count: appraisers.length,
        appraisers
      }, null, 2)
    }]
  };
}

async function handleCompareDecisions(params: { ids: string[] }): Promise<MCPToolResult> {
  // Check database availability
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const decisions = params.ids.map(id => db!.getDecision(id)).filter(d => d !== null);

  if (decisions.length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'No valid decisions found for the provided IDs',
          providedIds: params.ids,
          suggestion: 'None of the provided IDs exist in the database. Use search_decisions to find valid decision IDs first. Minimum 2 IDs required for comparison.',
          suggestionHe: 'אף אחד מהמזהים שסופקו לא קיים במאגר. השתמש ב-search_decisions כדי למצוא מזהי החלטות תקינים. נדרשים לפחות 2 מזהים להשוואה.'
        })
      }],
      isError: true
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        count: decisions.length,
        requestedIds: params.ids,
        foundIds: decisions.map(d => d!.id),
        decisions: decisions
      }, null, 2)
    }]
  };
}

async function handleSemanticSearch(params: { query: string; limit?: number; database?: DatabaseType }): Promise<MCPToolResult> {
  if (!embeddings) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Semantic search is not available.',
          errorHe: 'חיפוש סמנטי אינו זמין.',
          suggestion: 'Use regular search_decisions tool instead.',
          suggestionHe: 'השתמש בכלי search_decisions במקום.'
        })
      }],
      isError: true
    };
  }

  const stats = embeddings.getStats();
  const results = await embeddings.search(
    params.query,
    params.limit || 20,
    params.database ? { database: params.database } : undefined
  );

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        query: params.query,
        count: results.length,
        source: stats.mode,
        vectorCount: stats.count,
        results: results.map(r => {
          const { pdfText, contentHash, indexedAt, extractionStatus, extractionError, extractionAttempts, ...meta } = r.decision;
          return {
            ...meta,
            relevanceScore: r.score,
            pdfExcerpt: pdfText ? pdfText.substring(0, 1000) + (pdfText.length > 1000 ? '...' : '') : null
          };
        })
      }, null, 2) + DATA_COLLECTOR_INSTRUCTIONS
    }]
  };
}

async function handleTriggerUpdate(params: { pagesToCheck?: number }): Promise<MCPToolResult> {
  if (!SCRAPER_API_KEY) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'SCRAPER_API_KEY environment variable not set',
          suggestion: 'Set SCRAPER_API_KEY to enable live updates from gov.il'
        })
      }],
      isError: true
    };
  }

  try {
    const indexer = createIndexer({
      scraperApiKey: SCRAPER_API_KEY,
      continueOnError: true
    });

    await indexer.initialize();
    const results = await indexer.updateRecent(params.pagesToCheck || 5);

    const summary: Record<string, number> = {};
    let totalNew = 0;
    for (const [dbName, count] of results) {
      summary[dbName] = count;
      totalNew += count;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          newDecisionsFound: totalNew,
          byDatabase: summary,
          timestamp: new Date().toISOString()
        }, null, 2)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Failed to update',
          message: error instanceof Error ? error.message : String(error),
          suggestion: 'Update failed. Possible causes: (1) gov.il is temporarily unavailable, (2) Network connectivity issues, (3) ScraperAPI rate limit reached. Try again later or reduce pagesToCheck parameter.',
          suggestionHe: 'העדכון נכשל. סיבות אפשריות: (1) gov.il אינו זמין זמנית, (2) בעיות קישוריות, (3) הגעה למגבלת ScraperAPI. נסה שוב מאוחר יותר או הקטן את פרמטר pagesToCheck.'
        })
      }],
      isError: true
    };
  }
}

type AnalyticsQueryType = 'decisions_by_committee' | 'decisions_by_year' | 'decisions_by_appraiser' | 'decisions_by_case_type' | 'avg_decisions_per_month';

async function handleGetAnalytics(params: { query_type: AnalyticsQueryType; limit?: number; database?: DatabaseType }): Promise<MCPToolResult> {
  // Check database availability
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const limit = params.limit || 50;
  const database = params.database;

  let results: Array<{ name: string; count: number }> | { avgPerMonth: number; totalMonths: number; totalDecisions: number };
  let total = 0;

  switch (params.query_type) {
    case 'decisions_by_committee':
      results = db!.getDecisionsByCommittee(limit, database);
      total = (results as Array<{ count: number }>).reduce((sum, r) => sum + r.count, 0);
      break;

    case 'decisions_by_year':
      results = db!.getDecisionsByYear(limit, database);
      total = (results as Array<{ count: number }>).reduce((sum, r) => sum + r.count, 0);
      break;

    case 'decisions_by_appraiser':
      results = db!.getDecisionsByAppraiser(limit, database);
      total = (results as Array<{ count: number }>).reduce((sum, r) => sum + r.count, 0);
      break;

    case 'decisions_by_case_type':
      results = db!.getDecisionsByCaseType(limit, database);
      total = (results as Array<{ count: number }>).reduce((sum, r) => sum + r.count, 0);
      break;

    case 'avg_decisions_per_month':
      results = db!.getAvgDecisionsPerMonth(database);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query_type: params.query_type,
            database: database || 'all',
            avgDecisionsPerMonth: results.avgPerMonth,
            totalMonths: results.totalMonths,
            totalDecisions: results.totalDecisions
          }, null, 2)
        }]
      };

    default:
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `Invalid query_type: ${params.query_type}`,
            validTypes: ['decisions_by_committee', 'decisions_by_year', 'decisions_by_appraiser', 'decisions_by_case_type', 'avg_decisions_per_month']
          })
        }],
        isError: true
      };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        query_type: params.query_type,
        database: database || 'all',
        total,
        count: (results as Array<{ name: string; count: number }>).length,
        results
      }, null, 2)
    }]
  };
}

// ============================================================
// PROGRESSIVE DISCLOSURE HANDLERS (Layer 1, 2, 3)
// ============================================================

/**
 * Layer 1: Search and return lightweight index only
 * Returns ~50 tokens per result instead of ~500
 */
async function handleSearchDecisionsIndex(params: SearchParams): Promise<MCPToolResult> {
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const searchParams: SearchParams = {
    query: params.query,
    database: params.database,
    committee: params.committee,
    block: params.block,
    plot: params.plot,
    appraiser: params.appraiser,
    caseType: params.caseType,
    year: params.year,
    limit: Math.min(params.limit || 50, 100),
    offset: params.offset || 0
  };

  const result = db!.search(searchParams);

  // Return ONLY lightweight index data - no pdfText, no full metadata
  const indexResults = result.decisions.map((d, idx) => ({
    id: d.id,
    title: d.title ? (d.title.length > 80 ? d.title.substring(0, 80) + '...' : d.title) : null,
    date: d.decisionDate || d.publishDate,
    committee: d.committee,
    database: d.database,
    relevance_score: d.relevanceScore || (1 - idx * 0.01)  // Approximate relevance by position
  }));

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        layer: 1,
        layer_name: 'INDEX',
        query: searchParams,
        total_count: result.totalCount,
        returned_count: indexResults.length,
        has_more: result.hasMore,
        next_step: 'Call get_decision_summaries with interesting IDs for more details',
        next_step_he: 'קרא ל-get_decision_summaries עם מזהים מעניינים לפרטים נוספים',
        results: indexResults
      }, null, 2) + DATA_COLLECTOR_INSTRUCTIONS
    }]
  };
}

/**
 * Layer 2: Get summaries for multiple decisions
 * Returns summaries with key extracted values
 */
async function handleGetDecisionSummaries(params: { ids: string[] }): Promise<MCPToolResult> {
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  if (!params.ids || params.ids.length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'ids parameter required',
          errorHe: 'נדרש פרמטר ids',
          example: { ids: ['decisive_appraiser_123', 'decisive_appraiser_456'] }
        })
      }],
      isError: true
    };
  }

  // Limit to 20 IDs to prevent context overflow
  const limitedIds = params.ids.slice(0, 20);

  const summaries: Array<{
    id: string;
    title: string | null;
    date: string | null;
    committee: string | null;
    appraiser: string | null;
    caseType: string | null;
    block: string | null;
    plot: string | null;
    database: string;
    summary: string;
    key_values: { coefficient?: string; price_per_sqm?: string; percentage?: string; amount?: string } | null;
    has_full_text: boolean;
  }> = [];
  for (const id of limitedIds) {
    const decision = db!.getDecision(id);
    if (decision) {
      // Extract key values from pdfText if available
      let keyValues: any = {};
      let summary = '';

      if (decision.pdfText && decision.pdfText.length > 0) {
        // Generate summary (first 500 chars, cleaned)
        summary = decision.pdfText
          .replace(/\s+/g, ' ')
          .substring(0, 500)
          .trim();
        if (decision.pdfText.length > 500) {
          summary += '...';
        }

        // Extract key values using patterns
        const coefficientMatch = decision.pdfText.match(/מקדם\s*(?:דחייה|היוון|הנחה|ריבית)?\s*[:=]?\s*([\d.,]+)/i);
        const priceMatch = decision.pdfText.match(/(?:שווי|מחיר)\s*(?:למ"ר|למטר|ל-?מ"ר)?\s*[:=]?\s*(?:₪|ש"ח)?\s*([\d,]+)/i);
        const percentMatch = decision.pdfText.match(/([\d.,]+)\s*%/);
        const amountMatch = decision.pdfText.match(/(?:סכום|פיצוי|היטל)\s*[:=]?\s*(?:₪|ש"ח)?\s*([\d,]+)/i);

        if (coefficientMatch) keyValues.coefficient = coefficientMatch[1];
        if (priceMatch) keyValues.price_per_sqm = priceMatch[1];
        if (percentMatch) keyValues.percentage = percentMatch[1] + '%';
        if (amountMatch) keyValues.amount = amountMatch[1];
      }

      summaries.push({
        id: decision.id,
        title: decision.title,
        date: decision.decisionDate || decision.publishDate,
        committee: decision.committee,
        appraiser: decision.appraiser,
        caseType: decision.caseType,
        block: decision.block,
        plot: decision.plot,
        database: decision.database,
        summary: summary || '(No PDF text available)',
        key_values: Object.keys(keyValues).length > 0 ? keyValues : null,
        has_full_text: !!(decision.pdfText && decision.pdfText.length > 100)
      });
    }
  }

  const notFound = limitedIds.filter(id => !summaries.find(s => s.id === id));

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        layer: 2,
        layer_name: 'SUMMARIES',
        requested_count: params.ids.length,
        returned_count: summaries.length,
        limited_to: limitedIds.length < params.ids.length ? 20 : undefined,
        not_found: notFound.length > 0 ? notFound : undefined,
        next_step: 'Call get_decision_detail for full PDF text of specific decision',
        next_step_he: 'קרא ל-get_decision_detail לטקסט PDF מלא של החלטה ספציפית',
        summaries: summaries
      }, null, 2) + DATA_COLLECTOR_INSTRUCTIONS
    }]
  };
}

/**
 * Layer 3: Get full details for a single decision
 * Returns complete decision metadata with optional PDF text
 * CHANGED: Default is to NOT include full pdfText to prevent context overflow
 */
async function handleGetDecisionDetail(params: {
  id: string;
  include_pdf_text?: boolean;  // Default FALSE (changed from true)
  include_summary?: boolean;   // Default TRUE - extracts key values
}): Promise<MCPToolResult> {
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const decision = db!.getDecision(params.id);

  if (!decision) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Decision not found',
          errorHe: 'ההחלטה לא נמצאה',
          id: params.id,
          suggestion: 'Use search_decisions_index to find valid decision IDs'
        })
      }],
      isError: true
    };
  }

  // CHANGED: Default to false to prevent context overflow
  const includePdfText = params.include_pdf_text === true;
  const includeSummary = params.include_summary !== false;  // Default true

  // Build response with optional full text
  const response: any = {
    layer: 3,
    layer_name: 'FULL_DETAIL',
    id: decision.id,
    title: decision.title,
    database: decision.database,
    committee: decision.committee,
    appraiser: decision.appraiser,
    caseType: decision.caseType,
    block: decision.block,
    plot: decision.plot,
    decisionDate: decision.decisionDate,
    publishDate: decision.publishDate,
    pdfUrl: decision.url
  };

  // Add summary info by default (key values + excerpt)
  if (includeSummary && decision.pdfText) {
    response.key_values = extractKeyValuesFromText(decision.pdfText);
    response.excerpt = decision.pdfText.substring(0, MAX_EXCERPT_CHARS) +
      (decision.pdfText.length > MAX_EXCERPT_CHARS ? '...' : '');
    response.pdf_text_available = true;
    response.pdf_text_chars = decision.pdfText.length;
  } else if (includeSummary && !decision.pdfText) {
    response.pdf_text_available = false;
    response.note = 'PDF text not yet extracted. Use read_pdf tool to extract.';
    response.noteHe = 'טקסט PDF טרם חולץ. השתמש בכלי read_pdf לחילוץ.';
  }

  // Only include full text if explicitly requested (and truncate with warning)
  if (includePdfText && decision.pdfText) {
    if (decision.pdfText.length > MAX_PDFTEXT_CHARS) {
      response.pdfText = decision.pdfText.substring(0, MAX_PDFTEXT_CHARS) + '...';
      response.pdfTextTruncated = true;
      response.pdfTextLength = decision.pdfText.length;
      response.pdfTextNote = `Showing ${MAX_PDFTEXT_CHARS}/${decision.pdfText.length} chars. Use read_pdf with mode="full" for complete text.`;
    } else {
      response.pdfText = decision.pdfText;
      response.pdfTextLength = decision.pdfText.length;
    }
  } else if (includePdfText && !decision.pdfText) {
    response.pdfText = null;
    response.note = 'PDF text not yet extracted. Use read_pdf tool to extract.';
    response.noteHe = 'טקסט PDF טרם חולץ. השתמש בכלי read_pdf לחילוץ.';
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(response, null, 2)
    }]
  };
}

/**
 * Smart search with on-demand PDF extraction
 * This tool works even when PDF text hasn't been batch-extracted yet
 */
async function handleSmartSearch(params: {
  query: string;
  content_search?: string;
  committee?: string;
  caseType?: string;
  database?: DatabaseType;
  year?: string;
  extract_on_demand?: boolean;
  max_extractions?: number;
}): Promise<MCPToolResult> {
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const maxExtractions = Math.min(params.max_extractions || 10, 15);
  const extractOnDemand = params.extract_on_demand !== false;

  // Step 1: Search by metadata
  const conditions: string[] = ['1=1'];
  const sqlParams: any[] = [];

  if (params.committee) {
    conditions.push('committee LIKE ?');
    sqlParams.push(`%${params.committee}%`);
  }
  if (params.caseType) {
    conditions.push('(case_type LIKE ? OR title LIKE ? OR pdf_text LIKE ?)');
    sqlParams.push(`%${params.caseType}%`, `%${params.caseType}%`, `%${params.caseType}%`);
  }
  if (params.database) {
    conditions.push('database = ?');
    sqlParams.push(params.database);
  }
  if (params.year) {
    conditions.push('year = ?');
    sqlParams.push(params.year);
  }
  if (params.query) {
    conditions.push('(title LIKE ? OR committee LIKE ?)');
    sqlParams.push(`%${params.query}%`, `%${params.query}%`);
  }

  const whereClause = conditions.join(' AND ');

  // First, get documents that already have PDF text and match content_search
  let resultsWithText: any[] = [];
  if (params.content_search) {
    const withTextSql = `
      SELECT id, database, title, url, block, plot, committee, appraiser, case_type, decision_date, year, pdf_text
      FROM decisions
      WHERE ${whereClause} AND pdf_text IS NOT NULL AND LENGTH(pdf_text) > 100
        AND pdf_text LIKE ?
      ORDER BY decision_date DESC
      LIMIT 30
    `;
    resultsWithText = executeRawQuery(withTextSql, [...sqlParams, `%${params.content_search}%`]);
  }

  // Step 2: If we don't have enough results and extract_on_demand is enabled,
  // get documents without text and extract on-demand
  let extractedOnDemand: any[] = [];
  const neededMore = resultsWithText.length < 10 && extractOnDemand;

  if (neededMore) {
    // Get documents WITHOUT pdf_text that match metadata
    const withoutTextSql = `
      SELECT id, database, title, url, block, plot, committee, appraiser, case_type, decision_date, year
      FROM decisions
      WHERE ${whereClause} AND (pdf_text IS NULL OR LENGTH(pdf_text) < 100) AND url IS NOT NULL
      ORDER BY decision_date DESC
      LIMIT ?
    `;
    const candidatesWithoutText = executeRawQuery(withoutTextSql, [...sqlParams, maxExtractions]);

    // Extract PDF text on-demand for these candidates
    const pdfCache = getPdfCache();
    const extractor = createPdfExtractor(SCRAPER_API_KEY);

    for (const doc of candidatesWithoutText) {
      if (extractedOnDemand.length >= maxExtractions) break;

      try {
        // Check cache first
        const isCached = await pdfCache.isCached(doc.id, doc.database);
        let pdfBuffer: Buffer | null = null;

        if (isCached) {
          pdfBuffer = await pdfCache.loadPdf(doc.id, doc.database);
        } else if (doc.url && SCRAPER_API_KEY) {
          // Fetch via ScraperAPI with timeout
          const scraperUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(doc.url)}`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

          try {
            const response = await fetch(scraperUrl, {
              signal: controller.signal,
              headers: { 'Accept': 'application/pdf' }
            });
            clearTimeout(timeout);

            if (response.ok) {
              pdfBuffer = Buffer.from(await response.arrayBuffer());
              // Cache for future use
              await pdfCache.savePdf(doc.id, doc.database, pdfBuffer);
            }
          } catch (fetchError: any) {
            clearTimeout(timeout);
            console.error(`[SmartSearch] Fetch failed for ${doc.id}: ${fetchError.message}`);
            continue;
          }
        }

        if (pdfBuffer) {
          const extraction = await extractor.extractText(pdfBuffer);
          if (extraction.fullText && extraction.fullText.length > 100) {
            // Save to database for future searches
            (db as any).savePdfText(doc.id, extraction.fullText.substring(0, 35000));

            // Check if content_search matches
            if (!params.content_search || extraction.fullText.includes(params.content_search)) {
              extractedOnDemand.push({
                ...doc,
                pdf_text: extraction.fullText.substring(0, 35000),
                extracted_on_demand: true
              });
            }
          }
        }
      } catch (error: any) {
        console.error(`[SmartSearch] Error extracting ${doc.id}: ${error.message}`);
      }
    }
  }

  // Combine results
  const allResults = [...resultsWithText, ...extractedOnDemand];

  // Extract key values from results
  const extractedData: Array<{
    decision_id: string;
    title: string;
    appraiser: string | null;
    committee: string | null;
    block: string | null;
    plot: string | null;
    year: string | null;
    extracted_values: { coefficient?: string; price?: string; percentage?: string };
    context: string;
    extracted_on_demand: boolean;
  }> = [];

  for (const doc of allResults) {
    const text = doc.pdf_text || '';
    const extractedValues: any = {};

    // Extract coefficient
    const coeffMatch = text.match(/מקדם\s*(?:דחייה|היוון|הנחה)?\s*[:=]?\s*([\d.,]+)/i);
    if (coeffMatch) extractedValues.coefficient = coeffMatch[1];

    // Extract price
    const priceMatch = text.match(/(?:שווי|מחיר)\s*(?:למ"ר|למטר)?\s*[:=]?\s*(?:₪|ש"ח)?\s*([\d,]+)/i);
    if (priceMatch) extractedValues.price = priceMatch[1];

    // Extract percentage
    const percentMatch = text.match(/([\d.,]+)\s*%/);
    if (percentMatch) extractedValues.percentage = percentMatch[1] + '%';

    // Get context around content_search term
    let context = '';
    if (params.content_search && text) {
      const searchIdx = text.indexOf(params.content_search);
      if (searchIdx !== -1) {
        const start = Math.max(0, searchIdx - 100);
        const end = Math.min(text.length, searchIdx + params.content_search.length + 100);
        context = '...' + text.substring(start, end).replace(/\s+/g, ' ').trim() + '...';
      }
    }

    extractedData.push({
      decision_id: doc.id,
      title: doc.title,
      appraiser: doc.appraiser,
      committee: doc.committee,
      block: doc.block,
      plot: doc.plot,
      year: doc.year,
      extracted_values: Object.keys(extractedValues).length > 0 ? extractedValues : { note: 'No values extracted' },
      context: context || '(no context available)',
      extracted_on_demand: doc.extracted_on_demand || false
    });
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        query: params.query,
        content_search: params.content_search,
        filters: {
          committee: params.committee,
          caseType: params.caseType,
          database: params.database,
          year: params.year
        },
        results_from_cache: resultsWithText.length,
        results_extracted_on_demand: extractedOnDemand.length,
        total_results: extractedData.length,
        note: extractedOnDemand.length > 0
          ? `Extracted ${extractedOnDemand.length} PDFs on-demand. These are now cached for future searches.`
          : 'All results from pre-extracted cache.',
        extracted_data: extractedData
      }, null, 2)
    }]
  };
}

/**
 * Smart multi-term search: splits complex Hebrew queries into OR conditions.
 * Short queries (1-3 words) use exact LIKE match.
 * Long queries extract key appraisal terms and build OR conditions.
 */
const APPRAISAL_KEY_TERMS = [
  'מקדם', 'שווי', 'מחיר', 'ערך', 'קרקע', 'מגורים', 'בניה', 'זכויות',
  'גינה', 'ריקה', 'ציבורית', 'ייעוד', 'פינוי', 'בינוי', 'היטל', 'השבחה',
  'פיצוי', 'הפקעה', 'דחייה', 'היוון', 'גודל', 'הכרעה', 'שמאי',
  'דירה', 'מסחרי', 'תעשיה', 'חקלאי', 'מגרש', 'תכנית', 'תב"ע'
];

function buildContentSearchCondition(query: string): { sql: string; params: string[] } {
  const words = query.trim().split(/\s+/);

  // Short queries (1-3 words): use exact match
  if (words.length <= 3) {
    return { sql: 'pdf_text LIKE ?', params: [`%${query}%`] };
  }

  // Long queries: extract key terms and OR them
  const terms: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (APPRAISAL_KEY_TERMS.some(t => words[i].includes(t))) {
      // Build 2-word phrase if next word exists
      if (i + 1 < words.length) terms.push(words[i] + ' ' + words[i + 1]);
      terms.push(words[i]);
    }
  }

  const unique = [...new Set(terms)].slice(0, 5);
  if (unique.length === 0) {
    // No key terms found — fall back to exact match
    return { sql: 'pdf_text LIKE ?', params: [`%${query}%`] };
  }

  const conditions = unique.map(() => 'pdf_text LIKE ?');
  const params = unique.map(t => `%${t}%`);
  return { sql: `(${conditions.join(' OR ')})`, params };
}

/**
 * Query and Aggregate - Guaranteed no context overflow
 * Returns pre-computed CSV table with extracted values
 * This is the SAFEST tool for multi-document queries
 */
async function handleQueryAndAggregate(params: {
  content_search: string;
  committee?: string;
  year?: string;
  database?: DatabaseType;
  caseType?: string;
  extract_fields?: string[];
  max_rows?: number;
  param_filter?: {
    param_type?: string;
    param_subtype?: string;
    value_min?: number;
    value_max?: number;
  };
}): Promise<MCPToolResult> {
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  if (!params.content_search || params.content_search.length < 2) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'content_search parameter required (minimum 2 characters)',
          errorHe: 'נדרש פרמטר content_search (מינימום 2 תווים)',
          examples: [
            { content_search: 'מקדם דחייה', committee: 'תל אביב', year: '2025' },
            { content_search: 'שווי למ"ר', committee: 'נתניה' },
            { content_search: 'אחוז פיצוי', caseType: 'הפקעה' }
          ]
        })
      }],
      isError: true
    };
  }

  const extractFields = params.extract_fields || ['coefficient', 'price_per_sqm', 'percentage'];
  const maxRows = Math.min(params.max_rows || 50, 500);

  // Build WHERE clause - search in pdf_text
  const conditions: string[] = ['pdf_text IS NOT NULL', 'LENGTH(pdf_text) > 100'];
  const sqlParams: any[] = [];

  // Content search within PDF text — smart multi-term for complex queries
  const contentCondition = buildContentSearchCondition(params.content_search);
  conditions.push(contentCondition.sql);
  sqlParams.push(...contentCondition.params);

  if (params.committee) {
    conditions.push('committee LIKE ?');
    sqlParams.push(`%${params.committee}%`);
  }
  if (params.caseType) {
    conditions.push('(case_type LIKE ? OR title LIKE ? OR pdf_text LIKE ?)');
    sqlParams.push(`%${params.caseType}%`, `%${params.caseType}%`, `%${params.caseType}%`);
  }
  if (params.database) {
    conditions.push('database = ?');
    sqlParams.push(params.database);
  }
  if (params.year) {
    conditions.push('year = ?');
    sqlParams.push(params.year);
  }

  // Optional: filter by pre-extracted parameters (JOIN with decision_parameters)
  let paramJoin = '';
  if (params.param_filter?.param_type) {
    paramJoin = ' JOIN decision_parameters dp ON decisions.id = dp.decision_id';
    conditions.push('dp.param_type = ?');
    sqlParams.push(params.param_filter.param_type);
    if (params.param_filter.param_subtype) {
      conditions.push('dp.param_subtype LIKE ?');
      sqlParams.push(`%${params.param_filter.param_subtype}%`);
    }
    if (params.param_filter.value_min !== undefined) {
      conditions.push('dp.value_numeric >= ?');
      sqlParams.push(params.param_filter.value_min);
    }
    if (params.param_filter.value_max !== undefined) {
      conditions.push('dp.value_numeric <= ?');
      sqlParams.push(params.param_filter.value_max);
    }
  }

  const whereClause = conditions.join(' AND ');

  // Query ALL matches (no limit) for accurate statistics
  const searchSql = `
    SELECT DISTINCT decisions.id as id, decisions.database as database, decisions.title as title, decisions.url as url, decisions.committee as committee, decisions.appraiser as appraiser, decisions.case_type as case_type, decisions.block as block, decisions.plot as plot, decisions.year as year, decisions.decision_date as decision_date, decisions.pdf_text as pdf_text
    FROM decisions${paramJoin}
    WHERE ${whereClause}
    ORDER BY decisions.decision_date DESC
  `;

  const allResults = executeRawQuery(searchSql, sqlParams);

  if (allResults.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `לא נמצאו תוצאות עבור "${params.content_search}"${params.committee ? ` ב${params.committee}` : ''}${params.year ? ` לשנת ${params.year}` : ''}.

סיבות אפשריות:
1. מונח החיפוש לא נמצא במסמכים
2. הסינונים מצמצמים מדי

נסה:
- מונחי חיפוש קצרים יותר (מילה אחת או שתיים)
- הסר סינון שנה/ועדה

⚠️ אין צורך לנסות ניסוחים שונים — המערכת כבר מפרקת שאלות ארוכות למונחי מפתח.`
      }]
    };
  }

  // Process all results - extract values from PDF text
  const processedRows: Array<Record<string, any>> = [];

  // Always include search_value as a field — the number closest to the search term
  const allExtractFields = ['search_value', ...extractFields.filter(f => f !== 'search_value')];

  for (const doc of allResults) {
    const pdfText = doc.pdf_text || '';

    // PRIMARY: Extract numbers near the search term (context-aware)
    const nearbyValues = extractValuesNearSearchTerm(pdfText, params.content_search);
    const searchValue = nearbyValues.length > 0 ? nearbyValues[0] : null;

    // FALLBACK: Extract values using rigid patterns
    const extractedValues = extractValuesFromText(pdfText, extractFields);

    // Get context snippet around search term (with char position for page estimation)
    const { snippet: context, charIndex } = getContextSnippet(pdfText, params.content_search, 80);
    const page = estimatePage(charIndex, pdfText.length);

    processedRows.push({
      decision_id: doc.id,
      url: doc.url ? `[עמוד ${page}](${doc.url}#page=${page})` : '',
      appraiser: doc.appraiser || '',
      committee: doc.committee || '',
      block: doc.block || '',
      plot: doc.plot || '',
      year: doc.year || '',
      search_value: searchValue,
      ...extractedValues,
      context: context
    });
  }

  // Compute summary statistics from ALL rows
  const summary = computeSummaryStats(processedRows, Math.min(processedRows.length, maxRows), allExtractFields);

  // Limit rows for output
  const limitedRows = processedRows.slice(0, maxRows);

  // Define output columns
  const columns = ['decision_id', 'url', 'appraiser', 'committee', 'block', 'plot', 'year', ...allExtractFields, 'context'];

  // Format as CSV (29% token savings vs JSON)
  const csvOutput = formatResultsAsCSV(limitedRows, columns, summary);

  // Response behavior instructions
  return {
    content: [{
      type: 'text',
      text: csvOutput + DATA_COLLECTOR_INSTRUCTIONS
    }]
  };
}

/**
 * Export ALL results to a local CSV file — no row limit.
 * Returns file path + summary statistics.
 */
async function handleExportResults(params: {
  content_search: string;
  committee?: string;
  year?: string;
  database?: DatabaseType;
  caseType?: string;
  extract_fields?: string[];
}): Promise<MCPToolResult> {
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  if (!params.content_search || params.content_search.length < 2) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'content_search parameter required (minimum 2 characters)',
          errorHe: 'נדרש פרמטר content_search (מינימום 2 תווים)'
        })
      }],
      isError: true
    };
  }

  const extractFields = params.extract_fields || ['coefficient', 'price_per_sqm', 'percentage'];

  // Build WHERE clause — same as query_and_aggregate but NO row limit
  const conditions: string[] = ['pdf_text IS NOT NULL', 'LENGTH(pdf_text) > 100'];
  const sqlParams: any[] = [];

  const contentCondition = buildContentSearchCondition(params.content_search);
  conditions.push(contentCondition.sql);
  sqlParams.push(...contentCondition.params);

  if (params.committee) {
    conditions.push('committee LIKE ?');
    sqlParams.push(`%${params.committee}%`);
  }
  if (params.caseType) {
    conditions.push('(case_type LIKE ? OR title LIKE ? OR pdf_text LIKE ?)');
    sqlParams.push(`%${params.caseType}%`, `%${params.caseType}%`, `%${params.caseType}%`);
  }
  if (params.database) {
    conditions.push('database = ?');
    sqlParams.push(params.database);
  }
  if (params.year) {
    conditions.push('year = ?');
    sqlParams.push(params.year);
  }

  const whereClause = conditions.join(' AND ');
  const searchSql = `
    SELECT id, database, title, url, committee, appraiser, case_type, block, plot, year, decision_date, pdf_text
    FROM decisions
    WHERE ${whereClause}
    ORDER BY decision_date DESC
  `;

  const allResults = executeRawQuery(searchSql, sqlParams);

  if (allResults.length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'No results found',
          errorHe: `לא נמצאו תוצאות עבור "${params.content_search}"`,
          total: 0
        })
      }]
    };
  }

  // Process ALL results
  const allExtractFields = ['search_value', ...extractFields.filter(f => f !== 'search_value')];
  const processedRows: Array<Record<string, any>> = [];

  for (const doc of allResults) {
    const pdfText = doc.pdf_text || '';
    const nearbyValues = extractValuesNearSearchTerm(pdfText, params.content_search);
    const searchValue = nearbyValues.length > 0 ? nearbyValues[0] : null;
    const extractedValues = extractValuesFromText(pdfText, extractFields);
    const { snippet: context, charIndex } = getContextSnippet(pdfText, params.content_search, 80);
    const page = estimatePage(charIndex, pdfText.length);

    processedRows.push({
      decision_id: doc.id,
      url: doc.url ? `[עמוד ${page}](${doc.url}#page=${page})` : '',
      appraiser: doc.appraiser || '',
      committee: doc.committee || '',
      block: doc.block || '',
      plot: doc.plot || '',
      year: doc.year || '',
      search_value: searchValue,
      ...extractedValues,
      context: context
    });
  }

  // Compute summary stats
  const summary = computeSummaryStats(processedRows, processedRows.length, allExtractFields);

  // Build HTML table for Excel — RTL, Hebrew headers, proper formatting
  const columns = ['decision_id', 'url', 'appraiser', 'committee', 'block', 'plot', 'year', ...allExtractFields, 'context'];

  const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let html = `<html dir="rtl">
<head>
<meta charset="UTF-8">
<style>
  table { border-collapse: collapse; direction: rtl; width: 100%; }
  th, td { border: 1px solid #999; padding: 6px 10px; text-align: right; font-family: Arial, sans-serif; font-size: 11pt; }
  th { background-color: #4472C4; color: white; font-weight: bold; }
  tr:nth-child(even) { background-color: #D9E2F3; }
</style>
</head>
<body dir="rtl">
<h2 style="font-family:Arial; direction:rtl;">תוצאות חיפוש: ${escHtml(params.content_search)}${params.committee ? ' — ' + escHtml(params.committee) : ''}${params.year ? ' — ' + params.year : ''}</h2>
<p style="font-family:Arial; direction:rtl;">סה"כ: ${processedRows.length} תוצאות</p>
<table>
<tr>${columns.map(col => `<th>${escHtml(HEBREW_COLUMN_LABELS[col] || col)}</th>`).join('')}</tr>\n`;

  for (const row of processedRows) {
    html += '<tr>';
    for (const col of columns) {
      const val = row[col];
      const str = val === null || val === undefined ? '' : String(val);
      html += `<td>${escHtml(str)}</td>`;
    }
    html += '</tr>\n';
  }

  // Summary row
  html += `</table>
<br>
<table>
<tr><th>סטטיסטיקה</th><th>ערך</th></tr>
<tr><td>סה"כ תוצאות</td><td>${summary.total_matches}</td></tr>\n`;

  for (const field of ['search_value', 'coefficient', 'price_per_sqm', 'percentage', 'amount']) {
    if (summary[`count_${field}`]) {
      const label = HEBREW_FIELD_LABELS[field] || field;
      html += `<tr><td>${escHtml(label)} — כמות</td><td>${summary[`count_${field}`]}</td></tr>\n`;
      html += `<tr><td>${escHtml(label)} — ממוצע</td><td>${summary[`avg_${field}`]}</td></tr>\n`;
      html += `<tr><td>${escHtml(label)} — חציון</td><td>${summary[`median_${field}`]}</td></tr>\n`;
      html += `<tr><td>${escHtml(label)} — מינימום</td><td>${summary[`min_${field}`]}</td></tr>\n`;
      html += `<tr><td>${escHtml(label)} — מקסימום</td><td>${summary[`max_${field}`]}</td></tr>\n`;
    }
  }

  html += `</table>
</body>
</html>`;

  // Create exports directory
  const exportsDir = join(homedir(), '.gov-il-mcp', 'exports');
  if (!existsSync(exportsDir)) {
    mkdirSync(exportsDir, { recursive: true });
  }

  // Generate filename with timestamp — .xls so Excel opens it directly with RTL
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const safeSearch = params.content_search.substring(0, 30).replace(/[/\\?%*:|"<>]/g, '_');
  const fileName = `export_${timestamp}_${safeSearch}.xls`;
  const filePath = join(exportsDir, fileName);

  // Write file with BOM for encoding detection
  const BOM = '\xEF\xBB\xBF';
  writeFileSync(filePath, BOM + html, 'utf-8');

  // Return summary (NOT the data — it's in the file)
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        file: filePath,
        fileHe: `הקובץ נשמר ב: ${filePath}`,
        total_rows: processedRows.length,
        search_term: params.content_search,
        filters: {
          committee: params.committee || 'all',
          year: params.year || 'all',
          database: params.database || 'all'
        },
        summary: summary,
        instructions: 'Double-click the .xls file to open in Excel. Table is RTL with Hebrew headers.',
        instructionsHe: 'לחץ פעמיים על קובץ ה-xls לפתיחה באקסל. הטבלה בעברית מימין לשמאל.'
      }, null, 2)
    }]
  };
}

/**
 * Search within PDF content and extract structured data
 * This is the KEY tool for complex analytical queries
 */
async function handleSearchAndExtract(params: {
  content_search: string;
  committee?: string;
  caseType?: string;
  database?: DatabaseType;
  year?: string;
  extract_pattern?: 'coefficient' | 'price_per_sqm' | 'percentage' | 'amount' | 'auto';
  limit?: number;
}): Promise<MCPToolResult> {
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  if (!params.content_search || params.content_search.length < 2) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'content_search parameter required (minimum 2 characters)',
          errorHe: 'נדרש פרמטר content_search (מינימום 2 תווים)',
          example: { content_search: 'מקדם דחייה', committee: 'תל אביב' }
        })
      }],
      isError: true
    };
  }

  const limit = Math.min(params.limit || 20, 50);

  // Build WHERE clause for metadata filters
  const conditions: string[] = ['pdf_text IS NOT NULL', 'LENGTH(pdf_text) > 100'];
  const sqlParams: any[] = [];

  // Add content search - search within pdfText
  conditions.push('pdf_text LIKE ?');
  sqlParams.push(`%${params.content_search}%`);

  if (params.committee) {
    conditions.push('committee LIKE ?');
    sqlParams.push(`%${params.committee}%`);
  }
  if (params.caseType) {
    conditions.push('case_type LIKE ?');
    sqlParams.push(`%${params.caseType}%`);
  }
  if (params.database) {
    conditions.push('database = ?');
    sqlParams.push(params.database);
  }
  if (params.year) {
    conditions.push('year = ?');
    sqlParams.push(params.year);
  }

  const whereClause = conditions.join(' AND ');

  // Search with content filter
  const searchSql = `
    SELECT id, database, title, url, block, plot, committee, appraiser, case_type, decision_date, year, pdf_text
    FROM decisions
    WHERE ${whereClause}
    ORDER BY decision_date DESC
    LIMIT ?
  `;

  const results = executeRawQuery(searchSql, [...sqlParams, limit]);

  // Define extraction patterns
  const extractionPatterns: Record<string, RegExp[]> = {
    coefficient: [
      /מקדם\s*(?:דחייה|היוון|הנחה|ריבית)?\s*[:=]?\s*([\d.,]+)/gi,
      /coefficient\s*[:=]?\s*([\d.,]+)/gi,
      /([\d.,]+)\s*%?\s*מקדם/gi
    ],
    price_per_sqm: [
      /(?:שווי|מחיר)\s*(?:ל)?מ"ר\s*[:=]?\s*(?:₪|ש"ח)?\s*([\d,]+)/gi,
      /([\d,]+)\s*(?:₪|ש"ח)\s*(?:ל)?מ"ר/gi,
      /למ"ר\s*[:=]?\s*([\d,]+)/gi
    ],
    percentage: [
      /([\d.,]+)\s*%/gi,
      /אחוז\s*[:=]?\s*([\d.,]+)/gi,
      /שיעור\s*(?:של)?\s*([\d.,]+)/gi
    ],
    amount: [
      /(?:₪|ש"ח)\s*([\d,]+)/gi,
      /([\d,]+)\s*(?:₪|ש"ח)/gi,
      /סכום\s*(?:של)?\s*([\d,]+)/gi
    ]
  };

  // Extract values from each result
  const extractedData: Array<{
    decision_id: string;
    title: string;
    appraiser: string | null;
    committee: string | null;
    block: string | null;
    plot: string | null;
    year: string | null;
    decision_date: string | null;
    url: string | null;
    extracted_values: string[];
    context: string;
  }> = [];

  for (const row of results) {
    const pdfText = row.pdf_text || '';

    // Find the search term in context
    const searchTermLower = params.content_search.toLowerCase();
    const textLower = pdfText.toLowerCase();
    const termIndex = textLower.indexOf(searchTermLower);

    let context = '';
    if (termIndex >= 0) {
      const start = Math.max(0, termIndex - 50);
      const end = Math.min(pdfText.length, termIndex + params.content_search.length + 100);
      context = (start > 0 ? '...' : '') + pdfText.substring(start, end).trim() + (end < pdfText.length ? '...' : '');
    }

    // Extract values based on pattern
    const extracted_values: string[] = [];
    const patternType = params.extract_pattern || 'auto';

    if (patternType === 'auto') {
      // Try all patterns
      for (const [, patterns] of Object.entries(extractionPatterns)) {
        for (const pattern of patterns) {
          const matches = pdfText.matchAll(pattern);
          for (const match of matches) {
            if (match[1] && !extracted_values.includes(match[1])) {
              extracted_values.push(match[1]);
            }
          }
        }
      }
    } else {
      const patterns = extractionPatterns[patternType] || [];
      for (const pattern of patterns) {
        const matches = pdfText.matchAll(pattern);
        for (const match of matches) {
          if (match[1] && !extracted_values.includes(match[1])) {
            extracted_values.push(match[1]);
          }
        }
      }
    }

    extractedData.push({
      decision_id: row.id,
      title: row.title,
      appraiser: row.appraiser,
      committee: row.committee,
      block: row.block,
      plot: row.plot,
      year: row.year,
      decision_date: row.decision_date,
      url: row.url,
      extracted_values: extracted_values.slice(0, 5), // Limit to 5 values
      context
    });
  }

  // Get total count (without limit)
  const countSql = `SELECT COUNT(*) as count FROM decisions WHERE ${whereClause}`;
  const totalCountResult = executeRawQuery(countSql, sqlParams);
  const totalCount = totalCountResult.length > 0 ? totalCountResult[0] : { count: 0 };

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        query: params.content_search,
        filters: {
          committee: params.committee || null,
          caseType: params.caseType || null,
          database: params.database || null,
          year: params.year || null,
          extract_pattern: params.extract_pattern || 'auto'
        },
        total_matching: totalCount.count,
        results_returned: extractedData.length,
        extracted_data: extractedData,
        _format: 'הצג בעברית, מימין לשמאל (RTL)',
        note: 'חיפוש וחילוץ בצד השרת. לא הוחזרו מסמכים מלאים.',
        tip: 'השתמש ב-read_pdf(decision_id) לטקסט המלא של החלטות ספציפיות'
      }, null, 2)
    }]
  };
}

/**
 * Compare statistics between multiple committees (cities)
 * Returns aggregated stats WITHOUT raw documents to save context window
 */
async function handleCompareCommittees(params: { committees: string[]; database?: DatabaseType; year?: string; caseType?: string }): Promise<MCPToolResult> {
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  if (!params.committees || params.committees.length < 2) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'At least 2 committees required for comparison',
          errorHe: 'נדרשות לפחות 2 ועדות להשוואה',
          example: { committees: ['תל אביב', 'ירושלים'] }
        })
      }],
      isError: true
    };
  }

  const comparison: Array<{
    committee: string;
    total: number;
    by_year: Record<string, number>;
    by_case_type: Record<string, number>;
    top_appraisers: Array<{ name: string; count: number }>;
  }> = [];

  for (const committee of params.committees) {
    // Get total count for this committee
    const searchResult = db!.search({
      committee,
      database: params.database,
      year: params.year,
      caseType: params.caseType,
      limit: 1 // We only need count
    });

    // Get breakdown by year for this committee
    const byYearSql = `
      SELECT year as name, COUNT(*) as count FROM decisions
      WHERE committee LIKE ?
      ${params.database ? 'AND database = ?' : ''}
      ${params.caseType ? 'AND case_type LIKE ?' : ''}
      AND year IS NOT NULL
      GROUP BY year ORDER BY year DESC LIMIT 10
    `;
    const byYearParams = [
      `%${committee}%`,
      ...(params.database ? [params.database] : []),
      ...(params.caseType ? [`%${params.caseType}%`] : [])
    ];
    const byYearResults = executeRawQuery(byYearSql, byYearParams);
    const by_year: Record<string, number> = {};
    for (const row of byYearResults) {
      by_year[row.name] = row.count;
    }

    // Get breakdown by case type for this committee
    const byCaseTypeSql = `
      SELECT case_type as name, COUNT(*) as count FROM decisions
      WHERE committee LIKE ?
      ${params.database ? 'AND database = ?' : ''}
      ${params.year ? 'AND year = ?' : ''}
      AND case_type IS NOT NULL
      GROUP BY case_type ORDER BY count DESC LIMIT 10
    `;
    const byCaseTypeParams = [
      `%${committee}%`,
      ...(params.database ? [params.database] : []),
      ...(params.year ? [params.year] : [])
    ];
    const byCaseTypeResults = executeRawQuery(byCaseTypeSql, byCaseTypeParams);
    const by_case_type: Record<string, number> = {};
    for (const row of byCaseTypeResults) {
      by_case_type[row.name] = row.count;
    }

    // Get top appraisers for this committee
    const topAppraisersSql = `
      SELECT appraiser as name, COUNT(*) as count FROM decisions
      WHERE committee LIKE ?
      ${params.database ? 'AND database = ?' : ''}
      ${params.year ? 'AND year = ?' : ''}
      AND appraiser IS NOT NULL
      GROUP BY appraiser ORDER BY count DESC LIMIT 5
    `;
    const topAppraisersParams = [
      `%${committee}%`,
      ...(params.database ? [params.database] : []),
      ...(params.year ? [params.year] : [])
    ];
    const top_appraisers = executeRawQuery(topAppraisersSql, topAppraisersParams);

    comparison.push({
      committee,
      total: searchResult.totalCount,
      by_year,
      by_case_type,
      top_appraisers
    });
  }

  // Generate summary
  const sortedByTotal = [...comparison].sort((a, b) => b.total - a.total);
  const highest = sortedByTotal[0];
  const lowest = sortedByTotal[sortedByTotal.length - 1];
  const percentDiff = lowest.total > 0
    ? Math.round(((highest.total - lowest.total) / lowest.total) * 100)
    : 100;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        committees: params.committees,
        filters: {
          database: params.database || 'all',
          year: params.year || 'all',
          caseType: params.caseType || 'all'
        },
        comparison,
        _format: 'הצג בעברית, מימין לשמאל (RTL)',
        summary: `ב${highest.committee} יש ${percentDiff}% יותר החלטות מאשר ב${lowest.committee}`,
        note: 'סטטיסטיקות מחושבות בשרת. לא הוחזרו מסמכים גולמיים.'
      }, null, 2)
    }]
  };
}

/**
 * Get summary statistics with optional filters
 * Returns ONLY aggregated stats, not documents
 */
async function handleGetSummaryStats(params: { committee?: string; database?: DatabaseType; year?: string; caseType?: string; appraiser?: string }): Promise<MCPToolResult> {
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  // Build WHERE clause based on filters
  const conditions: string[] = ['1=1'];
  const sqlParams: any[] = [];

  if (params.committee) {
    conditions.push('committee LIKE ?');
    sqlParams.push(`%${params.committee}%`);
  }
  if (params.database) {
    conditions.push('database = ?');
    sqlParams.push(params.database);
  }
  if (params.year) {
    conditions.push('year = ?');
    sqlParams.push(params.year);
  }
  if (params.caseType) {
    conditions.push('case_type LIKE ?');
    sqlParams.push(`%${params.caseType}%`);
  }
  if (params.appraiser) {
    conditions.push('appraiser LIKE ?');
    sqlParams.push(`%${params.appraiser}%`);
  }

  const whereClause = conditions.join(' AND ');

  // Get total count
  const totalSql = `SELECT COUNT(*) as count FROM decisions WHERE ${whereClause}`;
  const totalResultArr = executeRawQuery(totalSql, sqlParams);
  const totalResult = totalResultArr.length > 0 ? totalResultArr[0] : { count: 0 };

  // Get by year
  const byYearSql = `SELECT year as name, COUNT(*) as count FROM decisions WHERE ${whereClause} AND year IS NOT NULL GROUP BY year ORDER BY year DESC LIMIT 10`;
  const byYear = executeRawQuery(byYearSql, sqlParams);

  // Get by case type
  const byCaseTypeSql = `SELECT case_type as type, COUNT(*) as count FROM decisions WHERE ${whereClause} AND case_type IS NOT NULL GROUP BY case_type ORDER BY count DESC LIMIT 10`;
  const byCaseType = executeRawQuery(byCaseTypeSql, sqlParams);

  // Get by appraiser (top 10)
  const byAppraiserSql = `SELECT appraiser as name, COUNT(*) as count FROM decisions WHERE ${whereClause} AND appraiser IS NOT NULL GROUP BY appraiser ORDER BY count DESC LIMIT 10`;
  const byAppraiser = executeRawQuery(byAppraiserSql, sqlParams);

  // Get unique counts
  const uniqueAppraisersSql = `SELECT COUNT(DISTINCT appraiser) as count FROM decisions WHERE ${whereClause} AND appraiser IS NOT NULL`;
  const uniqueAppraisersArr = executeRawQuery(uniqueAppraisersSql, sqlParams);
  const uniqueAppraisers = uniqueAppraisersArr.length > 0 ? uniqueAppraisersArr[0] : { count: 0 };

  // Get date range
  const dateRangeSql = `SELECT MIN(decision_date) as earliest, MAX(decision_date) as latest FROM decisions WHERE ${whereClause} AND decision_date IS NOT NULL`;
  const dateRangeArr = executeRawQuery(dateRangeSql, sqlParams);
  const dateRange = dateRangeArr.length > 0 ? dateRangeArr[0] : { earliest: null, latest: null };

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        filters_applied: {
          committee: params.committee || null,
          database: params.database || null,
          year: params.year || null,
          caseType: params.caseType || null,
          appraiser: params.appraiser || null
        },
        total_decisions: totalResult.count,
        by_year: byYear,
        by_case_type: byCaseType,
        by_appraiser: byAppraiser,
        unique_appraisers: uniqueAppraisers.count,
        date_range: {
          earliest: dateRange.earliest,
          latest: dateRange.latest
        },
        note: 'Statistics computed server-side. No raw documents returned.',
        noteHe: 'סטטיסטיקות מחושבות בשרת. לא הוחזרו מסמכים גולמיים.'
      }, null, 2)
    }]
  };
}

/**
 * US-PDF-006: Get PDF cache statistics
 */
async function handleGetPdfCacheStats(): Promise<MCPToolResult> {
  const pdfCache = getPdfCache();

  // Helper function to format bytes
  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  try {
    // Get file cache stats (on-disk PDFs)
    const fileStats = await pdfCache.getStats();

    // Get text cache stats from database (if available)
    let textCacheStats: {
      totalCached: number;
      totalSize: number;
      byStatus: Array<{ status: string; count: number }>;
      oldestEntry: string | null;
      newestEntry: string | null;
    } | null = null;

    if (db) {
      try {
        textCacheStats = db.getPdfCacheStats();
      } catch (error) {
        console.error('[handleGetPdfCacheStats] Error getting text cache stats:', error);
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          fileCache: {
            totalFiles: fileStats.totalFiles,
            totalSizeBytes: fileStats.totalSizeBytes,
            totalSizeFormatted: formatBytes(fileStats.totalSizeBytes),
            byDatabase: fileStats.byDatabase,
            cacheDir: fileStats.cacheDir
          },
          textCache: textCacheStats ? {
            totalCached: textCacheStats.totalCached,
            totalSize: textCacheStats.totalSize,
            totalSizeFormatted: formatBytes(textCacheStats.totalSize),
            byStatus: textCacheStats.byStatus,
            dateRange: {
              oldest: textCacheStats.oldestEntry,
              newest: textCacheStats.newestEntry
            }
          } : null,
          summary: {
            totalFilesOnDisk: fileStats.totalFiles,
            totalDiskSpace: formatBytes(fileStats.totalSizeBytes),
            textExtractionsCached: textCacheStats?.totalCached || 0,
            cacheLocation: fileStats.cacheDir
          }
        }, null, 2)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Failed to get PDF cache statistics',
          errorHe: 'נכשל בקבלת סטטיסטיקות מטמון PDF',
          message: error instanceof Error ? error.message : String(error)
        })
      }],
      isError: true
    };
  }
}

/**
 * US-PDF-006: Cleanup PDF cache with LRU strategy
 */
async function handleCleanupPdfCache(params: { maxSizeBytes?: number; dryRun?: boolean }): Promise<MCPToolResult> {
  const pdfCache = getPdfCache();
  const maxSizeBytes = params.maxSizeBytes || 5 * 1024 * 1024 * 1024; // Default 5GB
  const dryRun = params.dryRun || false;

  // Helper function to format bytes
  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  try {
    // Get current stats before cleanup
    const beforeStats = await pdfCache.getStats();

    if (beforeStats.totalSizeBytes <= maxSizeBytes) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            action: 'no_cleanup_needed',
            actionHe: 'לא נדרש ניקוי',
            currentSize: beforeStats.totalSizeBytes,
            currentSizeFormatted: formatBytes(beforeStats.totalSizeBytes),
            maxSize: maxSizeBytes,
            maxSizeFormatted: formatBytes(maxSizeBytes),
            percentUsed: Math.round((beforeStats.totalSizeBytes / maxSizeBytes) * 100),
            message: 'Cache size is within limit. No cleanup needed.',
            messageHe: 'גודל המטמון בתוך הגבול. לא נדרש ניקוי.'
          }, null, 2)
        }]
      };
    }

    if (dryRun) {
      // Calculate what would be deleted without actually deleting
      const targetSize = maxSizeBytes * 0.8;
      const bytesToFree = beforeStats.totalSizeBytes - targetSize;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            action: 'dry_run',
            actionHe: 'הרצה יבשה',
            currentSize: beforeStats.totalSizeBytes,
            currentSizeFormatted: formatBytes(beforeStats.totalSizeBytes),
            maxSize: maxSizeBytes,
            maxSizeFormatted: formatBytes(maxSizeBytes),
            targetSize,
            targetSizeFormatted: formatBytes(targetSize),
            wouldFreeBytes: bytesToFree,
            wouldFreeFormatted: formatBytes(bytesToFree),
            message: 'Dry run complete. Use dryRun: false to actually clean up.',
            messageHe: 'הרצה יבשה הושלמה. השתמש ב-dryRun: false לניקוי בפועל.'
          }, null, 2)
        }]
      };
    }

    // Perform actual cleanup
    const deletedCount = await pdfCache.cleanup(maxSizeBytes);

    // Get stats after cleanup
    const afterStats = await pdfCache.getStats();
    const freedBytes = beforeStats.totalSizeBytes - afterStats.totalSizeBytes;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          action: 'cleanup_completed',
          actionHe: 'ניקוי הושלם',
          deletedFiles: deletedCount,
          freedBytes,
          freedFormatted: formatBytes(freedBytes),
          beforeSize: beforeStats.totalSizeBytes,
          beforeSizeFormatted: formatBytes(beforeStats.totalSizeBytes),
          afterSize: afterStats.totalSizeBytes,
          afterSizeFormatted: formatBytes(afterStats.totalSizeBytes),
          maxSize: maxSizeBytes,
          maxSizeFormatted: formatBytes(maxSizeBytes),
          percentUsed: Math.round((afterStats.totalSizeBytes / maxSizeBytes) * 100),
          message: `Cleanup completed. Deleted ${deletedCount} files and freed ${formatBytes(freedBytes)}.`,
          messageHe: `הניקוי הושלם. נמחקו ${deletedCount} קבצים ושוחררו ${formatBytes(freedBytes)}.`
        }, null, 2)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Failed to cleanup PDF cache',
          errorHe: 'נכשל בניקוי מטמון PDF',
          message: error instanceof Error ? error.message : String(error),
          suggestion: 'Check that the cache directory exists and is writable.',
          suggestionHe: 'בדוק שתיקיית המטמון קיימת וניתנת לכתיבה.'
        })
      }],
      isError: true
    };
  }
}

async function handleHealthCheck(params: { verbose?: boolean }): Promise<MCPToolResult> {
  const startTime = Date.now();
  const issues: string[] = [];
  const issuesHe: string[] = [];
  const suggestions: string[] = [];
  const suggestionsHe: string[] = [];

  // Check database status
  let databaseStatus: {
    connected: boolean;
    decisionCount: number;
    fts5Working: boolean;
    path?: string;
    error?: string;
  } = {
    connected: false,
    decisionCount: 0,
    fts5Working: false
  };

  if (db) {
    try {
      // Test database connection
      const stats = db.getStats();
      databaseStatus.connected = true;
      databaseStatus.decisionCount = stats.totalDecisions;
      databaseStatus.path = db.getDbPath();

      // Test FTS5 by running a simple search
      try {
        db.search({ query: 'test', limit: 1 });
        databaseStatus.fts5Working = true;
      } catch {
        databaseStatus.fts5Working = false;
        issues.push('FTS5 full-text search is not working properly');
        issuesHe.push('חיפוש טקסט מלא FTS5 אינו עובד כראוי');
      }

      if (stats.totalDecisions === 0) {
        issues.push('Database is empty - run "npm run index-all" to populate');
        issuesHe.push('מסד הנתונים ריק - הרץ "npm run index-all" לאכלוס');
        suggestions.push('Run: SCRAPER_API_KEY=your_key npm run index-all');
        suggestionsHe.push('הרץ: SCRAPER_API_KEY=your_key npm run index-all');
      }
    } catch (error) {
      databaseStatus.connected = false;
      databaseStatus.error = error instanceof Error ? error.message : String(error);
      issues.push(`Database connection failed: ${databaseStatus.error}`);
      issuesHe.push(`חיבור למסד הנתונים נכשל: ${databaseStatus.error}`);
    }
  } else {
    issues.push('Database not initialized');
    issuesHe.push('מסד הנתונים לא אותחל');
    suggestions.push('Restart the MCP server. Check ~/.gov-il-mcp/decisions.db exists.');
    suggestionsHe.push('הפעל מחדש את שרת ה-MCP. בדוק ש-~/.gov-il-mcp/decisions.db קיים.');
  }

  // Check ScraperAPI status
  const scraperApiStatus: {
    configured: boolean;
    keyPresent: boolean;
  } = {
    configured: !!SCRAPER_API_KEY,
    keyPresent: !!SCRAPER_API_KEY
  };

  if (!SCRAPER_API_KEY) {
    suggestions.push('Set SCRAPER_API_KEY environment variable for live updates from gov.il');
    suggestionsHe.push('הגדר משתנה סביבה SCRAPER_API_KEY לעדכונים חיים מ-gov.il');
  }

  // Check embeddings status
  const embeddingsStatus: {
    available: boolean;
    error?: string;
  } = {
    available: !!embeddings
  };

  if (!embeddings) {
    suggestions.push('Embeddings/semantic search not available. This is optional but enhances search.');
    suggestionsHe.push('חיפוש סמנטי/embeddings לא זמין. זה אופציונלי אך משפר את החיפוש.');
  }

  // Server info
  const serverStatus = {
    version: '2.0.0',
    uptimeMs: Date.now() - startTime,
    nodeVersion: process.version
  };

  // Build detailed stats if verbose
  let detailedStats: Record<string, unknown> | undefined;
  if (params.verbose && db) {
    try {
      const stats = db.getStats();
      detailedStats = {
        byDatabase: stats.byDatabase,
        recentDecisions: stats.recentDecisions,
        lastUpdateAt: stats.lastUpdateAt,
        oldestDecision: stats.oldestDecision
      };
    } catch {
      // Ignore errors for verbose stats
    }
  }

  const healthy = databaseStatus.connected && databaseStatus.decisionCount > 0;

  const result: Record<string, unknown> = {
    healthy,
    status: {
      database: databaseStatus,
      scraperApi: scraperApiStatus,
      embeddings: embeddingsStatus,
      server: serverStatus
    },
    issues,
    issuesHe,
    suggestions,
    suggestionsHe
  };

  if (detailedStats) {
    result.detailedStats = detailedStats;
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }],
    isError: !healthy
  };
}

// Clarification prompts for different ambiguity types
const CLARIFICATION_PROMPTS: Record<AmbiguityType, ClarificationPrompt> = {
  missing_database: {
    ambiguityType: 'missing_database',
    question: 'באיזה מאגר לחפש?',
    questionEn: 'Which database should we search?',
    options: [
      { value: 'decisive_appraiser', label: 'שמאי מכריע', labelEn: 'Decisive Appraiser' },
      { value: 'appeals_committee', label: 'ועדת השגות', labelEn: 'Appeals Committee' },
      { value: 'appeals_board', label: 'ועדת ערעורים', labelEn: 'Appeals Board' },
      { value: 'all', label: 'כל המאגרים', labelEn: 'All databases' }
    ],
    allowMultiple: true
  },
  vague_location: {
    ambiguityType: 'vague_location',
    question: 'האם תרצה לצמצם לאזור מסוים?',
    questionEn: 'Would you like to narrow down to a specific area?',
    options: [
      { value: 'specify_city', label: 'ציין עיר/ועדה', labelEn: 'Specify city/committee' },
      { value: 'specify_block', label: 'ציין גוש וחלקה', labelEn: 'Specify block and plot' },
      { value: 'no_location', label: 'חפש בכל הארץ', labelEn: 'Search nationwide' }
    ],
    allowFreeText: true
  },
  unclear_date_range: {
    ambiguityType: 'unclear_date_range',
    question: 'לאיזה טווח תאריכים לחפש?',
    questionEn: 'What date range should we search?',
    options: [
      { value: 'last_year', label: 'שנה אחרונה', labelEn: 'Last year' },
      { value: 'last_3_years', label: '3 שנים אחרונות', labelEn: 'Last 3 years' },
      { value: 'last_5_years', label: '5 שנים אחרונות', labelEn: 'Last 5 years' },
      { value: 'all_time', label: 'כל הזמן', labelEn: 'All time' }
    ],
    allowFreeText: true
  },
  ambiguous_case_type: {
    ambiguityType: 'ambiguous_case_type',
    question: 'איזה סוג תיק מעניין אותך?',
    questionEn: 'What type of case interests you?',
    options: [
      { value: 'היטל השבחה', label: 'היטל השבחה', labelEn: 'Betterment Levy' },
      { value: 'פיצויים', label: 'פיצויים', labelEn: 'Compensation' },
      { value: 'ירידת ערך', label: 'ירידת ערך', labelEn: 'Depreciation' },
      { value: 'all_types', label: 'כל סוגי התיקים', labelEn: 'All case types' }
    ],
    allowFreeText: true
  },
  missing_search_terms: {
    ambiguityType: 'missing_search_terms',
    question: 'השאילתה קצרה מדי. מה בדיוק אתה מחפש?',
    questionEn: 'The query is too short. What exactly are you looking for?',
    options: [
      { value: 'add_details', label: 'אוסיף פרטים נוספים', labelEn: 'I will add more details' },
      { value: 'show_recent', label: 'הצג החלטות אחרונות', labelEn: 'Show recent decisions' },
      { value: 'show_statistics', label: 'הצג סטטיסטיקות', labelEn: 'Show statistics' }
    ],
    allowFreeText: true
  }
};

// Database keywords for detection
const DATABASE_KEYWORDS: Record<DatabaseType, string[]> = {
  decisive_appraiser: ['שמאי מכריע', 'הכרעה', 'הכרעת שמאי', 'מכריע'],
  appeals_committee: ['השגה', 'ועדת השגות', 'השגות'],
  appeals_board: ['ערעור', 'ועדת ערעורים', 'ערר', 'ערעורים']
};

// Case type keywords
const CASE_TYPE_KEYWORDS = [
  'היטל השבחה', 'פיצויים', 'ירידת ערך', 'הפקעה',
  'תכנית מתאר', 'שינוי ייעוד', 'היתר בניה',
  'תמ"א 38', 'פינוי בינוי', 'תב"ע'
];

// Year pattern for date detection
const YEAR_PATTERN = /\b(19|20)\d{2}\b|תשפ"?[א-ת]|תש[פע]"?[א-ת]/;

// Block/plot pattern
const BLOCK_PLOT_PATTERN = /גוש\s*\d+|חלקה\s*\d+|ג['׳]?\s*\d+|ח['׳]?\s*\d+/;

async function handleClarifyQuery(params: ClarifyQueryInput): Promise<MCPToolResult> {
  const { originalQuery, previousClarifications = [] } = params;
  const query = originalQuery.trim();

  const detectedAmbiguities: AmbiguityType[] = [];
  const clarifications: ClarificationPrompt[] = [];
  const suggestedParams: Partial<SearchParams> = {};

  // Check for minimum query length
  if (query.length < 3) {
    if (!previousClarifications.includes('missing_search_terms')) {
      detectedAmbiguities.push('missing_search_terms');
    }
  }

  // Check for database keywords
  let hasDbKeyword = false;
  for (const [dbType, keywords] of Object.entries(DATABASE_KEYWORDS)) {
    for (const keyword of keywords) {
      if (query.includes(keyword)) {
        hasDbKeyword = true;
        suggestedParams.database = dbType as DatabaseType;
        break;
      }
    }
    if (hasDbKeyword) break;
  }

  if (!hasDbKeyword && !previousClarifications.includes('missing_database')) {
    detectedAmbiguities.push('missing_database');
  }

  // Check for location specificity (city names or block/plot)
  const hasBlockPlot = BLOCK_PLOT_PATTERN.test(query);
  // Common Israeli cities - check if query mentions any
  const commonCities = ['תל אביב', 'ירושלים', 'חיפה', 'באר שבע', 'רעננה', 'נתניה', 'הרצליה', 'פתח תקווה', 'ראשון לציון', 'אשדוד'];
  const hasCityName = commonCities.some(city => query.includes(city));

  if (!hasBlockPlot && !hasCityName && query.length > 10 && !previousClarifications.includes('vague_location')) {
    // Only suggest location clarification for longer queries that don't have location info
    detectedAmbiguities.push('vague_location');
  }

  // Check for date/year mentions without clear range
  const hasYear = YEAR_PATTERN.test(query);
  const hasDateRange = query.includes('מ-') || query.includes('עד') || query.includes('בין') ||
                       query.includes('מתאריך') || query.includes('לתאריך');

  if (hasYear && !hasDateRange && !previousClarifications.includes('unclear_date_range')) {
    detectedAmbiguities.push('unclear_date_range');
  }

  // Check for case type specificity
  const hasCaseType = CASE_TYPE_KEYWORDS.some(caseType => query.includes(caseType));
  // General legal terms that might need clarification
  const generalTerms = ['החלטות', 'פסיקות', 'תיקים', 'עניינים'];
  const hasGeneralTerms = generalTerms.some(term => query.includes(term));

  if (!hasCaseType && hasGeneralTerms && !previousClarifications.includes('ambiguous_case_type')) {
    detectedAmbiguities.push('ambiguous_case_type');
  }

  // Build clarification prompts for detected ambiguities
  for (const ambiguity of detectedAmbiguities) {
    clarifications.push(CLARIFICATION_PROMPTS[ambiguity]);
  }

  // Extract any parameters we could determine despite ambiguity
  if (hasCaseType) {
    for (const caseType of CASE_TYPE_KEYWORDS) {
      if (query.includes(caseType)) {
        suggestedParams.caseType = caseType;
        break;
      }
    }
  }

  if (hasCityName) {
    for (const city of commonCities) {
      if (query.includes(city)) {
        suggestedParams.committee = city;
        break;
      }
    }
  }

  // Extract block/plot if present
  const blockMatch = query.match(/גוש\s*(\d+)|ג['׳]?\s*(\d+)/);
  if (blockMatch) {
    suggestedParams.block = blockMatch[1] || blockMatch[2];
  }

  const plotMatch = query.match(/חלקה\s*(\d+)|ח['׳]?\s*(\d+)/);
  if (plotMatch) {
    suggestedParams.plot = plotMatch[1] || plotMatch[2];
  }

  const result: ClarifyQueryResult = {
    needsClarification: clarifications.length > 0,
    clarifications,
    detectedAmbiguities,
    suggestedParams: Object.keys(suggestedParams).length > 0 ? suggestedParams : undefined,
    originalQuery: query
  };

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }]
  };
}

/**
 * Generate claims from sources with citation mappings.
 * Each claim is linked to the specific decision(s) that support it.
 * This helps Claude construct accurate, well-cited answers.
 */
function generateClaimsFromSources(
  question: string,
  decisions: Decision[],
  sources: CitedSource[],
  pdfExcerpts: Array<{ decisionId: string; excerpt: string }>
): CitedClaim[] {
  const claims: CitedClaim[] = [];

  // Group decisions by shared attributes to identify common themes
  const decisionsByBlock = new Map<string, number[]>();
  const decisionsByCommittee = new Map<string, number[]>();
  const decisionsByCaseType = new Map<string, number[]>();
  const decisionsByAppraiser = new Map<string, number[]>();

  decisions.forEach((decision, index) => {
    if (decision.block) {
      const key = decision.block;
      if (!decisionsByBlock.has(key)) decisionsByBlock.set(key, []);
      decisionsByBlock.get(key)!.push(index);
    }
    if (decision.committee) {
      const key = decision.committee;
      if (!decisionsByCommittee.has(key)) decisionsByCommittee.set(key, []);
      decisionsByCommittee.get(key)!.push(index);
    }
    if (decision.caseType) {
      const key = decision.caseType;
      if (!decisionsByCaseType.has(key)) decisionsByCaseType.set(key, []);
      decisionsByCaseType.get(key)!.push(index);
    }
    if (decision.appraiser) {
      const key = decision.appraiser;
      if (!decisionsByAppraiser.has(key)) decisionsByAppraiser.set(key, []);
      decisionsByAppraiser.get(key)!.push(index);
    }
  });

  // Generate claims based on location (block/plot) if present in query
  const hasLocationQuery = /גוש|חלקה|ג['׳]|ח['׳]|\d{4,}/.test(question);
  if (hasLocationQuery) {
    decisionsByBlock.forEach((indices, block) => {
      const relevantDecisions = indices.map(i => decisions[i]);
      const hasHighRelevance = relevantDecisions.some(d => (d.relevanceScore || 0) > 0.6);
      claims.push({
        text: `נמצאו ${indices.length} החלטות בגוש ${block}`,
        citations: indices,
        confidence: hasHighRelevance ? 'confident' : 'uncertain'
      });
    });
  }

  // Generate claims based on committee/location
  const hasCommitteeQuery = /ועדה|עירייה|רשות|מקומי/.test(question);
  const hasCityQuery = /תל אביב|ירושלים|חיפה|באר שבע|נתניה|רעננה|הרצליה|רמת גן|פתח תקווה|אשדוד/.test(question);
  if (hasCommitteeQuery || hasCityQuery) {
    decisionsByCommittee.forEach((indices, committee) => {
      if (indices.length >= 1) {
        const relevantDecisions = indices.map(i => decisions[i]);
        const avgRelevance = relevantDecisions.reduce((sum, d) => sum + (d.relevanceScore || 0), 0) / indices.length;
        claims.push({
          text: `${indices.length} החלטות נמצאו מועדה ${committee}`,
          citations: indices,
          confidence: avgRelevance > 0.5 ? 'confident' : 'uncertain'
        });
      }
    });
  }

  // Generate claims based on case type
  const caseTypeKeywords = ['היטל השבחה', 'פיצויים', 'ירידת ערך', 'הפקעה', 'תכנית מתאר', 'שינוי ייעוד', 'היתר בניה', 'תמ"א 38', 'פינוי בינוי', 'תב"ע'];
  const queriedCaseType = caseTypeKeywords.find(ct => question.includes(ct));
  if (queriedCaseType) {
    decisionsByCaseType.forEach((indices, caseType) => {
      if (caseType.includes(queriedCaseType) || queriedCaseType.includes(caseType)) {
        const relevantDecisions = indices.map(i => decisions[i]);
        const hasHighRelevance = relevantDecisions.some(d => (d.relevanceScore || 0) > 0.6);
        claims.push({
          text: `${indices.length} החלטות עוסקות ב${caseType}`,
          citations: indices,
          confidence: hasHighRelevance ? 'confident' : 'uncertain'
        });
      }
    });
  }

  // Generate claims based on appraiser if queried
  const hasAppraiserQuery = /שמאי|מעריך/.test(question);
  if (hasAppraiserQuery) {
    decisionsByAppraiser.forEach((indices, appraiser) => {
      if (indices.length >= 1) {
        claims.push({
          text: `שמאי ${appraiser} טיפל ב-${indices.length} מקרים`,
          citations: indices,
          confidence: indices.length > 1 ? 'confident' : 'uncertain'
        });
      }
    });
  }

  // Generate claims from PDF excerpts if available
  pdfExcerpts.forEach(({ decisionId, excerpt }) => {
    const sourceIndex = sources.findIndex(s => s.decisionId === decisionId);
    if (sourceIndex >= 0 && excerpt.length > 50) {
      // Extract a meaningful claim from the excerpt
      const truncatedExcerpt = excerpt.length > 150 ? excerpt.substring(0, 150) + '...' : excerpt;
      claims.push({
        text: `מתוך ההחלטה: "${truncatedExcerpt}"`,
        citations: [sourceIndex],
        confidence: 'confident' // Direct quotes from PDF are high confidence
      });
    }
  });

  // If no specific claims were generated, create general source claims
  if (claims.length === 0 && decisions.length > 0) {
    // Create a claim for each decision with its key details
    decisions.slice(0, 5).forEach((decision, index) => {
      const details: string[] = [];
      if (decision.caseType) details.push(decision.caseType);
      if (decision.committee) details.push(`ועדה: ${decision.committee}`);
      if (decision.decisionDate) details.push(`תאריך: ${decision.decisionDate}`);

      const claimText = details.length > 0
        ? `החלטה ${index + 1}: ${details.join(', ')}`
        : `החלטה רלוונטית נמצאה: ${decision.title.substring(0, 80)}`;

      claims.push({
        text: claimText,
        citations: [index],
        confidence: (decision.relevanceScore || 0) > 0.6 ? 'confident' : 'uncertain'
      });
    });
  }

  return claims;
}

/**
 * Format a PDF excerpt for quotation in the answer.
 * Cleans up the text and adds proper Hebrew quotation marks.
 * @param excerpt - Raw excerpt from PDF
 * @param maxLength - Maximum length before truncation (default 500)
 * @returns Formatted excerpt with quotation marks
 */
function formatPdfExcerpt(excerpt: string, maxLength: number = 500): string {
  // Clean up the excerpt
  let cleaned = excerpt
    .replace(/\s+/g, ' ')           // Normalize whitespace
    .replace(/\n{3,}/g, '\n\n')     // Limit consecutive newlines
    .trim();

  // Truncate if needed, breaking at word boundary
  if (cleaned.length > maxLength) {
    const truncated = cleaned.substring(0, maxLength);
    const lastSpace = truncated.lastIndexOf(' ');
    cleaned = (lastSpace > maxLength * 0.8 ? truncated.substring(0, lastSpace) : truncated) + '...';
  }

  // Add Hebrew quotation marks (״...״) for Hebrew text, or standard for English
  const isHebrew = /[\u0590-\u05FF]/.test(cleaned);
  if (isHebrew) {
    return `״${cleaned}״`;
  }
  return `"${cleaned}"`;
}

/**
 * Extract key phrases from PDF excerpt that may answer the user's question.
 * Looks for monetary amounts, percentages, dates, and legal determinations.
 */
function extractKeyPhrasesFromExcerpt(excerpt: string): string[] {
  const phrases: string[] = [];

  // Extract monetary amounts (Israeli shekel patterns)
  const moneyMatches = excerpt.match(/[\d,]+\s*(?:ש"ח|שקל|₪|שקלים)/g);
  if (moneyMatches) phrases.push(...moneyMatches);

  // Extract percentages
  const percentMatches = excerpt.match(/\d+(?:\.\d+)?%/g);
  if (percentMatches) phrases.push(...percentMatches);

  // Extract dates (DD/MM/YYYY or DD.MM.YYYY patterns)
  const dateMatches = excerpt.match(/\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}/g);
  if (dateMatches) phrases.push(...dateMatches);

  // Extract legal determination keywords
  const determinationKeywords = [
    'נקבע כי', 'הוחלט', 'נדחה', 'התקבל',
    'הפיצוי', 'ההיטל', 'השומה', 'הערך'
  ];
  for (const keyword of determinationKeywords) {
    if (excerpt.includes(keyword)) {
      // Extract surrounding context (up to 100 chars after keyword)
      const index = excerpt.indexOf(keyword);
      const contextEnd = Math.min(index + 100, excerpt.length);
      const context = excerpt.substring(index, contextEnd);
      const endPunct = context.search(/[.!?]/);
      if (endPunct > 0) {
        phrases.push(context.substring(0, endPunct + 1));
      }
    }
  }

  return [...new Set(phrases)]; // Remove duplicates
}

// Handler for constructing answers with citations (US-006)
async function handleConstructAnswer(params: ConstructAnswerInput): Promise<MCPToolResult> {
  const { question, decisions, pdfExcerpts = [] } = params;

  // Handle no results case - PRD requirement: Warn when no relevant decisions found
  if (!decisions || decisions.length === 0) {
    const noResultsWarning = 'לא נמצאו החלטות רלוונטיות';
    const formattedNoResultsAnswer = `
## ⚠️ ${noResultsWarning}

---

### הצעות:

1. **חדד את החיפוש** — נסה מונחים אחרים או ספציפיים יותר

2. **בדוק את המאגר** — האם המאגר הנכון נבחר? (שמאי מכריע / ועדת השגות / ועדת ערעורים)

3. **הבהר את השאילתה** — הוסף פרטים כמו גוש/חלקה, עיר, או סוג תיק

---

**רמת ביטחון / Confidence Level**: 🟡 ייתכן / Uncertain
`.trim();

    const result: ConstructAnswerResult = {
      formattedAnswer: formattedNoResultsAnswer,
      sources: [],
      claims: [],
      quotedExcerpts: [],
      overallConfidence: 'uncertain',
      confidenceIndicator: 'ייתכן',  // Uncertain when no results found
      noResultsWarning: noResultsWarning
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  }

  // Build sources array with inline citation indices [S0], [S1], etc.
  const sources: CitedSource[] = decisions.map((decision, index) => {
    // Find matching PDF excerpt if available
    const excerptMatch = pdfExcerpts.find(e => e.decisionId === decision.id);

    return {
      index,
      decisionId: decision.id,
      title: decision.title,
      pdfUrl: decision.url,
      database: decision.database,
      relevanceScore: decision.relevanceScore,
      excerpt: excerptMatch?.excerpt
    };
  });

  // Determine overall confidence based on:
  // - Number of results (more = more confident)
  // - Relevance scores (higher = more confident)
  // - Consistency of results (same database = more confident)
  let overallConfidence: ConfidenceLevel = 'uncertain';

  if (decisions.length >= 3) {
    // Multiple decisions support confidence
    const avgRelevance = decisions.reduce((sum, d) => sum + (d.relevanceScore || 0), 0) / decisions.length;
    if (avgRelevance > 0.5 || decisions.length >= 5) {
      overallConfidence = 'confident';
    }
  } else if (decisions.length >= 1) {
    // Single decision with high relevance
    const topRelevance = decisions[0].relevanceScore || 0;
    if (topRelevance > 0.8) {
      overallConfidence = 'confident';
    }
  }

  // Build formatted answer template with citation placeholders
  // Claude will use this structure to build actual answers
  const citationGuide = sources.map(s => `[S${s.index}]`).join(', ');

  // Build quoted excerpts from PDF content
  const quotedExcerpts: QuotedExcerpt[] = pdfExcerpts.map(({ decisionId, excerpt }) => {
    const sourceIndex = sources.findIndex(s => s.decisionId === decisionId);
    const keyPhrases = extractKeyPhrasesFromExcerpt(excerpt);

    return {
      sourceIndex: sourceIndex >= 0 ? sourceIndex : 0,
      decisionId,
      excerpt: formatPdfExcerpt(excerpt),
      context: keyPhrases.length > 0
        ? `נתונים מרכזיים: ${keyPhrases.slice(0, 3).join(', ')}`
        : undefined
    };
  });

  // Build quoted excerpts section for answer construction
  let quotedExcerptsSection = '';
  if (quotedExcerpts.length > 0) {
    const excerptItems = quotedExcerpts.map(qe => {
      const source = sources.find(s => s.decisionId === qe.decisionId);
      const sourceRef = qe.sourceIndex >= 0 ? `[S${qe.sourceIndex}]` : '';
      return `
### ציטוט מ-${sourceRef}
> ${qe.excerpt}

${qe.context ? `**${qe.context}**` : ''}
מקור: ${source?.title || qe.decisionId}`;
    }).join('\n\n');

    quotedExcerptsSection = `
## ציטוטים מתוך ה-PDF / Quoted Excerpts from PDF Content

השתמש בציטוטים הבאים בתשובתך כדי לבסס טענות:
Use these quotes in your answer to support claims:

${excerptItems}

---
`;
  }

  // Build detailed sources section with all required fields per PRD
  const sourcesSection = sources.map(s => {
    const relevancePercent = s.relevanceScore !== undefined
      ? `${Math.round(s.relevanceScore * 100)}%`
      : 'N/A';
    return `
**[S${s.index}]**
- מזהה / Decision ID: \`${s.decisionId}\`
- כותרת / Title: ${s.title}
- קישור ל-PDF / PDF URL: ${s.pdfUrl || 'לא זמין / Not available'}
- ציון רלוונטיות / Relevance Score: ${relevancePercent}${s.excerpt ? `
- ציטוט / Excerpt: ${formatPdfExcerpt(s.excerpt, 200)}` : ''}`;
  }).join('\n');

  // Build confidence indicator with explanation
  const confidenceIndicator = overallConfidence === 'confident'
    ? `**🟢 בטוח / Confident**
התשובה מבוססת על ${decisions.length} מקורות עם ציוני רלוונטיות גבוהים.
This answer is based on ${decisions.length} sources with high relevance scores.`
    : `**🟡 ייתכן / Uncertain**
התשובה מבוססת על ${decisions.length} מקור(ות) עם ציוני רלוונטיות בינוניים. מומלץ לבדוק את המקורות ישירות.
This answer is based on ${decisions.length} source(s) with moderate relevance. Recommend verifying sources directly.`;

  const formattedAnswer = `
## רמת ביטחון / Confidence Level

${confidenceIndicator}

---

## מבנה התשובה / Answer Structure

השתמש בציטוטים הבאים בתשובתך / Use these citations in your answer:
${citationGuide}

---
${quotedExcerptsSection}
## מקורות / Sources Section

${sourcesSection}

---

### הנחיות לבניית תשובה / Answer Construction Guidelines:
1. הצב ציטוט [S#] מיד אחרי כל טענה / Place [S#] citation immediately after each claim
2. **ציטוט ישיר מ-PDF**: ״...טקסט...״ [S#] / Direct quote from PDF: "...text..." [S#]
3. מספר מקורות לאותה טענה: [S0][S1] / Multiple sources for same claim: [S0][S1]
4. **ציין רמת ביטחון בתשובה**: פתח ב-"${overallConfidence === 'confident' ? 'בטוח' : 'ייתכן'}:" אם נדרש / **Indicate confidence in answer**: Start with "${overallConfidence === 'confident' ? 'Confident' : 'Uncertain'}:" if needed
5. ${quotedExcerpts.length > 0 ? `**חשוב**: השתמש בציטוטים מה-PDF לעיל כדי לבסס תשובות / **Important**: Use the PDF quotes above to support answers` : 'אם יש תוכן PDF, צטט את הטקסט הרלוונטי / If PDF content available, quote the relevant text'}
`.trim();

  // Generate claims from sources with citation mappings
  // Each claim links to the specific decision(s) that support it
  const claims: CitedClaim[] = generateClaimsFromSources(question, decisions, sources, pdfExcerpts);

  // Hebrew confidence label for direct use in responses
  const hebrewConfidenceLabel = overallConfidence === 'confident' ? 'בטוח' : 'ייתכן';

  const result: ConstructAnswerResult = {
    formattedAnswer,
    sources,
    claims,
    quotedExcerpts,
    overallConfidence,
    confidenceIndicator: hebrewConfidenceLabel
  };

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }]
  };
}

// ============================================================
// PARAMETER EXTRACTION HANDLERS
// ============================================================

async function handleSearchByParameters(params: {
  param_type: string;
  param_subtype?: string;
  value_min?: number;
  value_max?: number;
  value_text?: string;
  committee?: string;
  year?: string;
  database?: string;
  min_confidence?: number;
  limit?: number;
}): Promise<MCPToolResult> {
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const { rows, totalCount } = db!.searchByParameters({
    param_type: params.param_type,
    param_subtype: params.param_subtype,
    value_min: params.value_min,
    value_max: params.value_max,
    value_text: params.value_text,
    min_confidence: params.min_confidence ?? 0.5,
    committee: params.committee,
    year: params.year,
    database: params.database,
    limit: params.limit || 50
  });

  if (rows.length === 0) {
    // Return stats about what's available
    const stats = db!.getParameterStats(params.param_type);
    return {
      content: [{
        type: 'text',
        text: `לא נמצאו תוצאות עבור ${params.param_type}${params.param_subtype ? ` (${params.param_subtype})` : ''}.

סטטיסטיקות זמינות עבור ${params.param_type}:
- סה"כ ערכים: ${stats.count}
- תתי-סוגים: ${stats.subtypes.map(s => `${s.subtype} (${s.count})`).join(', ') || 'אין'}
${stats.avgValue !== null ? `- ממוצע: ${stats.avgValue.toFixed(2)}, טווח: ${stats.minValue}-${stats.maxValue}` : ''}

נסה להרחיב את הסינונים או לבדוק שפרמטרים חולצו (extract_parameters).`
      }]
    };
  }

  // Format as CSV
  const csvColumns = ['id', 'committee', 'appraiser', 'block', 'plot', 'year', 'param_subtype', 'value_numeric', 'value_text', 'unit', 'confidence', 'context_snippet'];
  const hebrewLabels: Record<string, string> = {
    id: 'מזהה', committee: 'ועדה', appraiser: 'שמאי', block: 'גוש', plot: 'חלקה',
    year: 'שנה', param_subtype: 'תת-סוג', value_numeric: 'ערך מספרי', value_text: 'ערך טקסט',
    unit: 'יחידה', confidence: 'ביטחון', context_snippet: 'הקשר'
  };

  let csv = csvColumns.map(c => hebrewLabels[c] || c).join(',') + '\n';
  for (const row of rows) {
    csv += csvColumns.map(c => {
      const val = row[c];
      if (val === null || val === undefined) return '';
      const str = String(val);
      return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(',') + '\n';
  }

  // Stats
  let statsLine = `\n---\nסה"כ: ${totalCount} תוצאות | מוצג: ${rows.length}`;

  return {
    content: [{
      type: 'text',
      text: csv + statsLine + DATA_COLLECTOR_INSTRUCTIONS
    }]
  };
}

async function handleGetDecisionParameters(params: { id: string }): Promise<MCPToolResult> {
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const decision = db!.getById(params.id);
  if (!decision) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Decision not found: ${params.id}`, errorHe: `החלטה לא נמצאה: ${params.id}` }) }],
      isError: true
    };
  }

  const parameters = db!.getParametersForDecision(params.id);

  if (parameters.length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          decision_id: params.id,
          title: decision.title,
          parameters: [],
          message: 'לא חולצו פרמטרים עבור החלטה זו. הפעל extract_parameters כדי לחלץ.',
          messageEn: 'No parameters extracted for this decision. Run extract_parameters to extract.'
        }, null, 2)
      }]
    };
  }

  // Group by param_type
  const grouped: Record<string, any[]> = {};
  for (const p of parameters) {
    if (!grouped[p.param_type]) grouped[p.param_type] = [];
    grouped[p.param_type].push({
      subtype: p.param_subtype,
      value_numeric: p.value_numeric,
      value_text: p.value_text,
      unit: p.unit,
      confidence: p.confidence,
      method: p.extraction_method,
      context: p.context_snippet
    });
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        decision_id: params.id,
        title: decision.title,
        committee: decision.committee,
        year: decision.year,
        total_parameters: parameters.length,
        parameters: grouped
      }, null, 2)
    }]
  };
}

async function handleExtractParameters(params: {
  decision_id?: string;
  batch_size?: number;
  use_llm?: boolean;
}): Promise<MCPToolResult> {
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const useLLM = params.use_llm || false;
  const batchSize = Math.min(params.batch_size || 50, 500);

  // Single decision extraction
  if (params.decision_id) {
    const decision = db!.getById(params.decision_id);
    if (!decision) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Decision not found: ${params.decision_id}` }) }],
        isError: true
      };
    }
    if (!decision.pdfText || decision.pdfText.length < 50) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Decision has no PDF text', errorHe: 'להחלטה אין טקסט PDF' }) }],
        isError: true
      };
    }

    const results = await extractParameters(decision.pdfText, decision.id, {
      useLLM,
      committee: decision.committee
    });

    const inserted = db!.insertParameters(decision.id, results);
    db!.forceSave();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          decision_id: decision.id,
          parameters_extracted: inserted,
          types: [...new Set(results.map(r => r.param_type))],
          details: results.map(r => ({
            type: r.param_type,
            subtype: r.param_subtype,
            value: r.value_numeric ?? r.value_text,
            confidence: r.confidence
          }))
        }, null, 2)
      }]
    };
  }

  // Batch extraction
  const unextractedIds = db!.getUnextractedDecisionIds(batchSize);
  if (unextractedIds.length === 0) {
    const stats = db!.getParameterExtractionStats();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          message: 'כל המסמכים כבר עובדו / All documents already processed',
          stats
        }, null, 2)
      }]
    };
  }

  let totalExtracted = 0;
  let processed = 0;
  let errors = 0;

  for (const id of unextractedIds) {
    const decision = db!.getById(id);
    if (!decision || !decision.pdfText) {
      db!.setParameterExtractionStatus(id, 'failed', 'No PDF text');
      errors++;
      continue;
    }

    try {
      const results = await extractParameters(decision.pdfText, id, {
        useLLM,
        committee: decision.committee
      });

      const inserted = db!.insertParameters(id, results);
      totalExtracted += inserted;
      processed++;

      // Save every 100 documents
      if (processed % 100 === 0) {
        db!.forceSave();
        console.error(`[ExtractParameters] Progress: ${processed}/${unextractedIds.length}, params: ${totalExtracted}`);
      }
    } catch (err) {
      db!.setParameterExtractionStatus(id, 'failed', err instanceof Error ? err.message : String(err));
      errors++;
    }
  }

  // Final save
  db!.forceSave();

  const stats = db!.getParameterExtractionStats();

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        processed,
        errors,
        total_parameters_extracted: totalExtracted,
        remaining: stats.pending,
        overall_stats: stats
      }, null, 2)
    }]
  };
}

// Main server setup
async function main() {
  const server = new Server(
    {
      name: 'gov-il-land-appraisal',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
      instructions: `אתה מתמחה שאוסף נתונים עבור שמאי מקרקעין מוסמך. התפקיד שלך: למצוא ולהציג עובדות קונקרטיות עם קישור למקור. אתה לא מנתח, לא מסכם, לא מחשב ממוצעים, ולא מפרש — השמאי יעשה את זה בעצמו.

## כללי ברזל
1. **תמיד השתמש בכלים של השרת הזה** — לעולם אל תחפש באינטרנט. כל התשובות חייבות להגיע ממאגר ההחלטות.
2. **קרא את שלושת משאבי הידע** בתחילת כל שיחה:
   - shamai://knowledge/glossary — מילון מונחים מקצועיים
   - shamai://knowledge/query-patterns — מיפוי שאלות לכלים
   - shamai://knowledge/institutional-framework — המסגרת המוסדית
3. **ענה בעברית מקצועית** — השתמש במונחי שמאות: מקדם, שיעור היוון, גישת ההשוואה, שיטת החילוץ, שיטה שיורית.
4. **אל תמציא נתונים** — אם אין תוצאות במאגר, אמור "לא נמצאו תוצאות" בלבד. אל תציע חלופות, אל תסביר למה, ואל תשלים מידע מהאינטרנט.
5. **לעולם אל תסכם, אל תחשב ממוצעים, אל תוסיף פרשנות** — השמאי לא יכול לצטט "ממוצע AI" בדיון. הוא צריך עובדות קונקרטיות עם מקור.

## הבנת השמאי
כשהשמאי שואל:
- "מה המקדם" → הוא מתכוון למקדם שמאי (גודל/דחייה/היוון/ניצול/מיקום/סחירות). חפש בהחלטות.
- "כמה השבחה" → הוא מתכוון להיטל השבחה. חפש החלטות שמאי מכריע.
- "גוש X חלקה Y" → חפש ישירות לפי block/plot.
- שם עיר (תל אביב, הרצליה, רמת גן) → זו הועדה המקומית. השתמש בפילטר committee.
- "ש"מ" = שמאי מכריע, "ו"מ" = ועדה מקומית, "ה"ה" = היטל השבחה, "רמ"י" = רשות מקרקעי ישראל.

## בחירת כלי
- **שאלות על מקדמים / מחירים / ערכים** → query_and_aggregate (מחזיר טבלת CSV עם ערכים מתוך המסמכים — **זה הכלי הנכון לשאלות "מקדם X ב-Y"**)
- **שאלות בשפה חופשית / נושאים מושגיים** → semantic_search (חיפוש סמנטי עם AI embeddings על 31K+ מסמכים)
- **חיפוש לפי פרמטרים** (גוש/חלקה, שמאי, ועדה) → search_decisions
- **חיפוש מדויק** (מקדם מעל X, מחיר מתחת Y) → search_by_parameters
- **קריאת מסמך בודד** → read_pdf (**רק כשהמשתמש מבקש לקרוא מסמך ספציפי**)
- **השוואת ערים** → compare_committees

⚠️ **כלל קריטי: לעולם אל תקרא יותר מ-PDF אחד בשיחה אחת.** הצג את מה שהחיפוש מחזיר. אם המשתמש רוצה לקרוא מסמך ספציפי — הוא יבקש.

דוגמאות:
- "מקדם גובה פנים בתל אביב" → query_and_aggregate עם content_search="מקדם גובה פנים", committee="תל אביב"
- "גובה פנים דירה" → semantic_search
- "קרא את ההחלטה הזו" → read_pdf

## מאגרים
- decisive_appraiser (24,478 החלטות) — שמאי מכריע: מקדמים, שווי, עסקאות השוואה
- appeals_committee (6,118) — ועדת השגות: ביקורת על שמאי מכריע
- appeals_board (1,061) — ועדת ערעורים: סכסוכי רמ"י, דמי חכירה

## סגנון תשובה — כללי ברזל
- אתה אוסף נתונים, לא מנתח. תפקידך: למצוא ולהציג עובדות קונקרטיות עם מקור.
- לעולם אל תסכם, אל תחשב ממוצעים, אל תפרש. המשתמש הוא שמאי מוסמך — הוא יעשה את הניתוח בעצמו.
- כל שורה בטבלה חייבת לכלול: שם החלטה, שמאי, גוש/חלקה, שנה, קישור ל-PDF, ומה כתוב שם (ציטוט קצר).
- כל ערך חייב להיות בר-מעקב למסמך ספציפי — לעולם אל תציג מספר בלי לציין מאיפה הוא.
- אם לא נמצא — אמור בפשטות "לא נמצאו תוצאות". אל תציע חלופות ואל תסביר למה.
- **לעולם אל תקרא כמה מסמכי PDF ברצף.** קריאת PDF אחד = בסדר. קריאת 2+ = אסור. הצג מה שהחיפוש מחזיר ותן למשתמש לבקש מסמך ספציפי.
- **אל תנרטב את התהליך** ("עכשיו אחפש...", "בוא אקרא..."). הצג ישר את הטבלה.`
    }
  );

  // Handle tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Handle list resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: SHAMAI_RESOURCES };
  });

  // Handle read resource
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const content = getResourceContent(uri);
    if (!content) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: 'text/markdown',
          text: content,
        },
      ],
    };
  });

  // Handle list prompts
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: SHAMAI_PROMPTS };
  });

  // Handle get prompt
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const messages = getPromptMessages(name, args ?? {});
    if (!messages) {
      throw new Error(`Prompt not found: ${name}`);
    }
    return { messages };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'search_decisions':
          return await handleSearchDecisions(args as SearchParams);

        case 'get_decision':
          return await handleGetDecision(args as { id: string });

        case 'get_decision_pdf':
          return await handleGetDecisionPdf(args as { id: string });

        case 'read_pdf':
          return await handleReadPdf(args as {
            id: string;
            maxPages?: number;
            mode?: 'summary' | 'excerpt' | 'full';
            offset?: number;
            chunk_size?: number;
          });

        case 'get_statistics':
          return await handleGetStatistics();

        // get_extraction_stats - REMOVED
        // compare_decisions - REMOVED
        // clarify_query - REMOVED
        // construct_answer - REMOVED
        // get_pdf_cache_stats - REMOVED
        // cleanup_pdf_cache - REMOVED
        // search_and_extract - REMOVED
        // smart_search - REMOVED

        case 'list_committees':
          return await handleListCommittees(args as { limit?: number });

        case 'list_appraisers':
          return await handleListAppraisers(args as { limit?: number });

        case 'semantic_search':
          return await handleSemanticSearch(args as { query: string; limit?: number; database?: DatabaseType });

        case 'trigger_update':
          return await handleTriggerUpdate(args as { pagesToCheck?: number });

        case 'health_check':
          return await handleHealthCheck(args as { verbose?: boolean });

        case 'get_analytics':
          return await handleGetAnalytics(args as { query_type: AnalyticsQueryType; limit?: number; database?: DatabaseType });

        case 'compare_committees':
          return await handleCompareCommittees(args as { committees: string[]; database?: DatabaseType; year?: string; caseType?: string });

        case 'get_summary_stats':
          return await handleGetSummaryStats(args as { committee?: string; database?: DatabaseType; year?: string; caseType?: string; appraiser?: string });

        // Progressive Disclosure Tools (Layer 1, 2, 3)
        case 'search_decisions_index':
          return await handleSearchDecisionsIndex(args as SearchParams);

        case 'get_decision_summaries':
          return await handleGetDecisionSummaries(args as { ids: string[] });

        case 'get_decision_detail':
          return await handleGetDecisionDetail(args as {
            id: string;
            include_pdf_text?: boolean;
            include_summary?: boolean;
          });

        case 'query_and_aggregate':
          return await handleQueryAndAggregate(args as { content_search: string; committee?: string; year?: string; database?: DatabaseType; caseType?: string; extract_fields?: string[]; max_rows?: number; param_filter?: { param_type?: string; param_subtype?: string; value_min?: number; value_max?: number } });

        case 'export_results':
          return await handleExportResults(args as { content_search: string; committee?: string; year?: string; database?: DatabaseType; caseType?: string; extract_fields?: string[] });

        // Parameter extraction tools
        case 'search_by_parameters':
          return await handleSearchByParameters(args as {
            param_type: string; param_subtype?: string; value_min?: number; value_max?: number;
            value_text?: string; committee?: string; year?: string; database?: string;
            min_confidence?: number; limit?: number;
          });

        case 'get_decision_parameters':
          return await handleGetDecisionParameters(args as { id: string });

        case 'extract_parameters':
          return await handleExtractParameters(args as {
            decision_id?: string; batch_size?: number; use_llm?: boolean;
          });

        default:
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: `Unknown tool: ${name}`,
                suggestion: 'Available tools: semantic_search (BEST for natural language), query_and_aggregate (tables/aggregation), search_by_parameters, get_decision_parameters, extract_parameters, export_results (CSV export), search_decisions, search_decisions_index, get_decision_summaries, get_decision_detail, get_decision, get_decision_pdf, read_pdf, get_statistics, list_committees, list_appraisers, trigger_update, health_check, get_analytics, compare_committees, get_summary_stats',
                suggestionHe: 'כלים זמינים: query_and_aggregate (ראשי), search_by_parameters (חיפוש פרמטרים), get_decision_parameters (פרמטרים של החלטה), extract_parameters (חילוץ), export_results (ייצוא CSV), search_decisions, search_decisions_index (שכבה 1), get_decision_summaries (שכבה 2), get_decision_detail (שכבה 3), get_decision, get_decision_pdf, read_pdf, get_statistics, list_committees, list_appraisers, semantic_search, trigger_update, health_check, get_analytics, compare_committees, get_summary_stats'
              })
            }],
            isError: true
          };
      }
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'Tool execution failed',
            tool: name,
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'An unexpected error occurred. Check that all required parameters are provided and in the correct format. For search_decisions, ensure dates are in YYYY-MM-DD format.',
            suggestionHe: 'אירעה שגיאה בלתי צפויה. ודא שכל הפרמטרים הנדרשים סופקו ובפורמט הנכון. עבור search_decisions, ודא שתאריכים בפורמט YYYY-MM-DD.'
          })
        }],
        isError: true
      };
    }
  });

  // Setup transport and start server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Cleanup on exit
  process.on('SIGINT', () => {
    closeEmbeddingsStore();
    closeDatabase();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    closeEmbeddingsStore();
    closeDatabase();
    process.exit(0);
  });

  console.error('Gov.il Land Appraisal MCP Server started');

  // Initialize database in background AFTER server is connected.
  // Delay 3s so tools/list, prompts/list, resources/list responses go through
  // before the synchronous sql.js file read blocks the event loop.
  setTimeout(async () => {
    try {
      db = await getDatabase();
      console.error('[MCP Server] Database initialized successfully');
    } catch (error) {
      console.error('[MCP Server] WARNING: Database initialization failed:', error instanceof Error ? error.message : String(error));
      console.error('[MCP Server] Server will continue but database-dependent tools will return errors.');
      console.error('[MCP Server] Check that ~/.gov-il-mcp/ directory is accessible and has write permissions.');
      db = null;
    }

    try {
      embeddings = await getEmbeddings();
      console.error('[MCP Server] Semantic search initialized');
    } catch (error) {
      console.error('[MCP Server] Semantic search not available:', error instanceof Error ? error.message : String(error));
      embeddings = null;
    }
  }, 3000);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
