/**
 * PDF Text Extractor for Gov.il Land Appraisal Decisions
 * Downloads PDFs using ScraperAPI and extracts text using pdf-parse
 * Supports caching extracted text in SQLite database
 *
 * US-003: Implement PDF text extraction
 */

import pdf from 'pdf-parse';
import type { DecisionDatabase } from './database.js';
import type { PdfCache } from './pdf-cache.js';
import type { DatabaseType } from './types.js';

/**
 * Hebrew RTL Text Processing Utilities
 * Handles proper normalization and cleanup of Hebrew text from PDFs
 */

// Unicode ranges for Hebrew characters
const HEBREW_RANGE_START = 0x0590;
const HEBREW_RANGE_END = 0x05FF;

// RTL control characters
const RTL_MARK = '\u200F';           // Right-to-Left Mark
const LTR_MARK = '\u200E';           // Left-to-Right Mark
const RTL_EMBEDDING = '\u202B';      // Right-to-Left Embedding
const LTR_EMBEDDING = '\u202A';      // Left-to-Right Embedding
const POP_DIRECTIONAL = '\u202C';    // Pop Directional Formatting
const RTL_OVERRIDE = '\u202E';       // Right-to-Left Override
const LTR_OVERRIDE = '\u202D';       // Left-to-Right Override
const RTL_ISOLATE = '\u2067';        // Right-to-Left Isolate
const LTR_ISOLATE = '\u2066';        // Left-to-Right Isolate
const POP_ISOLATE = '\u2069';        // Pop Directional Isolate
const FIRST_STRONG_ISOLATE = '\u2068'; // First Strong Isolate

/**
 * Check if a character is a Hebrew letter
 */
function isHebrewChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= HEBREW_RANGE_START && code <= HEBREW_RANGE_END;
}

/**
 * Check if a string contains Hebrew characters
 */
function containsHebrew(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (isHebrewChar(text[i])) {
      return true;
    }
  }
  return false;
}

/**
 * Remove all Unicode directional control characters
 * These can cause display issues and are not needed in extracted text
 */
function removeDirectionalControls(text: string): string {
  const directionalChars = [
    RTL_MARK, LTR_MARK, RTL_EMBEDDING, LTR_EMBEDDING,
    POP_DIRECTIONAL, RTL_OVERRIDE, LTR_OVERRIDE,
    RTL_ISOLATE, LTR_ISOLATE, POP_ISOLATE, FIRST_STRONG_ISOLATE
  ];

  let result = text;
  for (const char of directionalChars) {
    result = result.split(char).join('');
  }
  return result;
}

/**
 * Normalize Hebrew final letters (sofit forms)
 * PDF extraction sometimes produces incorrect final form usage
 */
function normalizeHebrewFinalLetters(text: string): string {
  // Map of final forms to their regular counterparts for checking context
  // Final letters should only appear at end of words
  const finalLetters: Record<string, string> = {
    'ך': 'כ',  // Final Kaf
    'ם': 'מ',  // Final Mem
    'ן': 'נ',  // Final Nun
    'ף': 'פ',  // Final Pe
    'ץ': 'צ'   // Final Tsadi
  };

  const regularToFinal: Record<string, string> = {
    'כ': 'ך',
    'מ': 'ם',
    'נ': 'ן',
    'פ': 'ף',
    'צ': 'ץ'
  };

  const result: string[] = [];
  const chars = [...text];

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const nextChar = chars[i + 1];
    const isEndOfWord = !nextChar || !isHebrewChar(nextChar);

    // If this is a final letter in the middle of a word, convert to regular form
    if (finalLetters[char] && !isEndOfWord) {
      result.push(finalLetters[char]);
    }
    // If this is a regular letter at the end of a word, convert to final form
    else if (regularToFinal[char] && isEndOfWord) {
      result.push(regularToFinal[char]);
    }
    else {
      result.push(char);
    }
  }

  return result.join('');
}

/**
 * Clean up common PDF extraction artifacts in Hebrew text
 */
function cleanHebrewPdfArtifacts(text: string): string {
  let result = text;

  // Remove zero-width characters that PDF extraction sometimes leaves
  result = result.replace(/[\u200B-\u200D\uFEFF]/g, '');

  // Normalize multiple spaces to single space
  result = result.replace(/  +/g, ' ');

  // Fix common Hebrew punctuation issues
  // Hebrew uses different quote marks than English
  result = result.replace(/״/g, '"');  // Gershayim to double quote
  result = result.replace(/׳/g, "'");  // Geresh to single quote

  // Clean up line breaks - PDF often has excessive line breaks
  // Replace single line breaks with space, keep double for paragraphs
  result = result.replace(/([^\n])\n([^\n])/g, '$1 $2');
  result = result.replace(/\n{3,}/g, '\n\n');

  // Trim whitespace from each line
  result = result.split('\n').map(line => line.trim()).join('\n');

  // Remove empty lines at start/end
  result = result.trim();

  return result;
}

/**
 * Process Hebrew RTL text from PDF extraction
 * Main function that applies all Hebrew text normalization
 */
function processHebrewText(text: string): string {
  if (!text || !containsHebrew(text)) {
    return text;
  }

  console.error('[PdfExtractor] Processing Hebrew RTL text');

  let processed = text;

  // Step 1: Remove directional control characters
  processed = removeDirectionalControls(processed);

  // Step 2: Normalize Hebrew final letters
  processed = normalizeHebrewFinalLetters(processed);

  // Step 3: Clean up PDF extraction artifacts
  processed = cleanHebrewPdfArtifacts(processed);

  return processed;
}

export interface PdfExtractionResult {
  fullText: string;
  pageCount: number;
  extractedPages: number;
  cached: boolean;
}

export interface PdfExtractorOptions {
  apiKey: string;
  maxPages?: number;  // Limit extraction to first N pages for large PDFs
  database?: DecisionDatabase;  // Optional database for text caching
  pdfCache?: PdfCache;  // Optional file cache for PDF files
}

export class PdfExtractor {
  private apiKey: string;
  private maxPages: number;
  private database: DecisionDatabase | null;
  private pdfCache: PdfCache | null;

  constructor(options: PdfExtractorOptions) {
    this.apiKey = options.apiKey;
    this.maxPages = options.maxPages ?? 0;  // 0 = extract all pages
    this.database = options.database ?? null;
    this.pdfCache = options.pdfCache ?? null;
  }

  /**
   * Set the database for text caching
   */
  setDatabase(database: DecisionDatabase): void {
    this.database = database;
  }

  /**
   * Set the PDF file cache
   */
  setPdfCache(pdfCache: PdfCache): void {
    this.pdfCache = pdfCache;
  }

  /**
   * Build ScraperAPI URL for PDF download
   * Uses ScraperAPI to handle any blocking/protection on the PDF URLs
   */
  private buildScraperUrl(pdfUrl: string): string {
    const params = new URLSearchParams({
      api_key: this.apiKey,
      url: pdfUrl,
      // Note: PDFs don't need render=true (they're not HTML)
      // But premium=true helps bypass blocking
      premium: 'true'
    });
    return `https://api.scraperapi.com?${params.toString()}`;
  }

  /**
   * Download PDF from URL using ScraperAPI
   * Returns raw PDF buffer
   */
  async downloadPdf(pdfUrl: string): Promise<Buffer> {
    // Validate URL
    if (!pdfUrl || (!pdfUrl.startsWith('http://') && !pdfUrl.startsWith('https://'))) {
      throw new Error(`Invalid PDF URL: ${pdfUrl}`);
    }

    // Build ScraperAPI URL for the PDF
    const scraperUrl = this.buildScraperUrl(pdfUrl);

    console.error(`[PdfExtractor] Downloading PDF via ScraperAPI: ${pdfUrl}`);

    const response = await fetch(scraperUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/pdf,*/*'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to download PDF: ${response.status} ${response.statusText}`);
    }

    // Get content type to verify it's a PDF
    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.includes('pdf') && !contentType.includes('octet-stream')) {
      console.error(`[PdfExtractor] WARNING: Unexpected content type: ${contentType}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    console.error(`[PdfExtractor] Downloaded ${buffer.length} bytes`);

    if (buffer.length < 100) {
      throw new Error('Downloaded content too small to be a valid PDF');
    }

    // Verify PDF magic bytes (%PDF-)
    const header = buffer.slice(0, 5).toString('ascii');
    if (!header.startsWith('%PDF-')) {
      throw new Error(`Invalid PDF file: expected %PDF- header, got: ${header}`);
    }

    return buffer;
  }

  /**
   * Extract text from PDF buffer
   * Supports partial extraction (first N pages) for large PDFs
   */
  async extractText(pdfBuffer: Buffer): Promise<PdfExtractionResult> {
    console.error(`[PdfExtractor] Extracting text from PDF (${pdfBuffer.length} bytes)`);

    // Configure pdf-parse options
    const options: { max?: number } = {};

    // If maxPages is set, limit extraction
    if (this.maxPages > 0) {
      options.max = this.maxPages;
    }

    try {
      const data = await pdf(pdfBuffer, options);

      // Process Hebrew RTL text - normalizes final letters, removes
      // directional controls, and cleans up PDF extraction artifacts
      const fullText = processHebrewText(data.text);

      const extractedPages = this.maxPages > 0
        ? Math.min(this.maxPages, data.numpages)
        : data.numpages;

      console.error(`[PdfExtractor] Extracted ${fullText.length} characters from ${extractedPages}/${data.numpages} pages`);

      return {
        fullText,
        pageCount: data.numpages,
        extractedPages,
        cached: false
      };
    } catch (error) {
      console.error(`[PdfExtractor] PDF extraction error:`, error);
      throw new Error(`Failed to extract text from PDF: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Download PDF and extract text in one operation
   * This is the main entry point for extracting PDF content
   */
  async downloadAndExtract(pdfUrl: string): Promise<PdfExtractionResult> {
    const buffer = await this.downloadPdf(pdfUrl);
    return this.extractText(buffer);
  }

  /**
   * Extract PDF text with caching support
   * Uses a three-tier cache strategy:
   * 1. Text cache (SQLite) - instant return of extracted text
   * 2. File cache (local files) - extract from cached PDF file
   * 3. Network download (ScraperAPI) - download, cache, and extract
   *
   * @param decisionId - The decision ID for cache lookup/storage
   * @param pdfUrl - The URL to download PDF from (if not cached)
   * @param databaseType - The database type for file cache organization (optional)
   * @returns PdfExtractionResult with cached=true if from cache
   */
  async extractWithCache(decisionId: string, pdfUrl: string, databaseType?: DatabaseType): Promise<PdfExtractionResult> {
    // TIER 1: Check text cache first (fastest - returns extracted text directly)
    if (this.database) {
      const cachedText = this.database.getCachedPdfText(decisionId);
      if (cachedText !== null) {
        console.error(`[PdfExtractor] Text cache HIT for decision ${decisionId}`);
        // Return cached result - we don't know original page count, estimate from text
        // Average Hebrew legal doc: ~3000 chars per page
        const estimatedPages = Math.max(1, Math.ceil(cachedText.length / 3000));
        return {
          fullText: cachedText,
          pageCount: estimatedPages,
          extractedPages: estimatedPages,
          cached: true
        };
      }
      console.error(`[PdfExtractor] Text cache MISS for decision ${decisionId}`);
    }

    // TIER 2: Check file cache (fast - reads local PDF file)
    const dbType = databaseType ?? 'decisive_appraiser'; // Default database type
    if (this.pdfCache) {
      const cachedPdfBuffer = await this.pdfCache.loadPdf(decisionId, dbType);
      if (cachedPdfBuffer !== null) {
        console.error(`[PdfExtractor] File cache HIT for decision ${decisionId}`);
        // Extract text from cached PDF file
        const result = await this.extractText(cachedPdfBuffer);

        // Save extracted text to text cache for even faster access next time
        if (this.database && result.fullText) {
          const saved = this.database.savePdfText(decisionId, result.fullText);
          if (saved) {
            console.error(`[PdfExtractor] Saved ${result.fullText.length} chars to text cache from file cache`);
          }
        }

        return {
          ...result,
          cached: true
        };
      }
      console.error(`[PdfExtractor] File cache MISS for decision ${decisionId}`);
    }

    // TIER 3: Download from network (slowest - uses ScraperAPI)
    console.error(`[PdfExtractor] Downloading from network for decision ${decisionId}`);
    const pdfBuffer = await this.downloadPdf(pdfUrl);

    // Save PDF to file cache for offline access
    if (this.pdfCache) {
      try {
        await this.pdfCache.savePdf(decisionId, dbType, pdfBuffer);
        console.error(`[PdfExtractor] Saved PDF to file cache for decision ${decisionId}`);
      } catch (error) {
        console.error(`[PdfExtractor] WARNING: Failed to save PDF to file cache:`, error);
      }
    }

    // Extract text from downloaded PDF
    const result = await this.extractText(pdfBuffer);

    // Save extracted text to text cache
    if (this.database && result.fullText) {
      const saved = this.database.savePdfText(decisionId, result.fullText);
      if (saved) {
        console.error(`[PdfExtractor] Saved ${result.fullText.length} chars to text cache for decision ${decisionId}`);
      } else {
        console.error(`[PdfExtractor] WARNING: Failed to save to text cache for decision ${decisionId}`);
      }
    }

    return result;
  }

  /**
   * Update max pages limit
   */
  setMaxPages(maxPages: number): void {
    this.maxPages = maxPages;
  }

  /**
   * Get current max pages setting
   */
  getMaxPages(): number {
    return this.maxPages;
  }

  /**
   * Smart extraction with fallback handling
   * Returns text if available, or indicates the document is scanned
   *
   * @param decisionId - The decision ID for cache lookup
   * @param pdfUrl - The URL to download PDF from
   * @param minTextLength - Minimum text length to consider extraction successful (default: 100)
   * @param databaseType - The database type for file cache organization (optional)
   */
  async smartExtract(
    decisionId: string,
    pdfUrl: string,
    minTextLength: number = 100,
    databaseType?: DatabaseType
  ): Promise<{ type: 'text'; result: PdfExtractionResult } | { type: 'scanned'; pdfUrl: string; message: string }> {
    console.error(`[PdfExtractor] Smart extraction for decision ${decisionId}`);

    // Try text extraction (uses cache if available)
    try {
      const textResult = await this.extractWithCache(decisionId, pdfUrl, databaseType);

      // Check if we got meaningful text
      if (textResult.fullText && textResult.fullText.trim().length >= minTextLength) {
        console.error(`[PdfExtractor] Text extraction successful: ${textResult.fullText.length} chars`);
        return { type: 'text', result: textResult };
      }

      console.error(`[PdfExtractor] Text too short (${textResult.fullText.length} chars), document appears to be scanned`);
    } catch (error) {
      console.error(`[PdfExtractor] Text extraction failed:`, error);
    }

    // Return scanned document indicator with URL for manual viewing
    return {
      type: 'scanned',
      pdfUrl: pdfUrl,
      message: 'This PDF appears to be a scanned document with no extractable text. Use the PDF URL to view the document directly.'
    };
  }
}

/**
 * Factory function for creating PdfExtractor instances
 */
export function createPdfExtractor(apiKey: string, options?: Partial<PdfExtractorOptions>): PdfExtractor {
  return new PdfExtractor({ apiKey, ...options });
}
