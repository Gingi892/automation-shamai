/**
 * PDF Text Extractor for Gov.il Land Appraisal Decisions
 * Downloads PDFs using ScraperAPI and extracts text using pdf-parse
 *
 * US-003: Implement PDF text extraction
 */

import pdf from 'pdf-parse';

export interface PdfExtractionResult {
  fullText: string;
  pageCount: number;
  extractedPages: number;
  cached: boolean;
}

export interface PdfExtractorOptions {
  apiKey: string;
  maxPages?: number;  // Limit extraction to first N pages for large PDFs
}

export class PdfExtractor {
  private apiKey: string;
  private maxPages: number;

  constructor(options: PdfExtractorOptions) {
    this.apiKey = options.apiKey;
    this.maxPages = options.maxPages ?? 0;  // 0 = extract all pages
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
    const options: pdf.Options = {};

    // If maxPages is set, limit extraction
    if (this.maxPages > 0) {
      options.max = this.maxPages;
    }

    try {
      const data = await pdf(pdfBuffer, options);

      // Hebrew text handling: pdf-parse returns text in logical order
      // which works correctly for RTL Hebrew text
      const fullText = data.text;

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
}

/**
 * Factory function for creating PdfExtractor instances
 */
export function createPdfExtractor(apiKey: string, options?: Partial<PdfExtractorOptions>): PdfExtractor {
  return new PdfExtractor({ apiKey, ...options });
}
