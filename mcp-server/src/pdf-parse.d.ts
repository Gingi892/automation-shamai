/**
 * Type declarations for pdf-parse module
 * @see https://www.npmjs.com/package/pdf-parse
 */

declare module 'pdf-parse' {
  interface PDFInfo {
    PDFFormatVersion?: string;
    IsAcroFormPresent?: boolean;
    IsXFAPresent?: boolean;
    Title?: string;
    Author?: string;
    Subject?: string;
    Creator?: string;
    Producer?: string;
    CreationDate?: string;
    ModDate?: string;
  }

  interface PDFMetadata {
    _metadata?: Record<string, unknown>;
  }

  interface PDFData {
    /** Total number of pages in the PDF */
    numpages: number;
    /** Number of pages that were rendered/processed */
    numrender: number;
    /** PDF info object */
    info: PDFInfo;
    /** PDF metadata */
    metadata: PDFMetadata | null;
    /** Extracted text content from all processed pages */
    text: string;
    /** PDF version */
    version: string;
  }

  interface Options {
    /** Max number of pages to parse (0 = all pages) */
    max?: number;
    /** PDF.js page render options */
    pagerender?: (pageData: unknown) => Promise<string>;
    /** Version of PDF.js to use */
    version?: string;
  }

  function pdf(dataBuffer: Buffer, options?: Options): Promise<PDFData>;

  export = pdf;
}
