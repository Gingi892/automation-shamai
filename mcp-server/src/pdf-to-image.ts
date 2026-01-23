/**
 * PDF to Image Converter
 * Converts PDF pages to JPEG images for scanned document handling
 * Uses unpdf + @napi-rs/canvas for serverless-compatible rendering
 *
 * US-PDF-007: Add PDF to image conversion
 */

import { renderPageAsImage, getDocumentProxy, getMeta } from 'unpdf';

/**
 * Result of converting a single PDF page to an image
 */
export interface ImageResult {
  /** Page number (1-indexed) */
  pageNumber: number;
  /** Base64-encoded JPEG image data */
  base64: string;
  /** MIME type (always image/jpeg) */
  mimeType: 'image/jpeg';
  /** Image width in pixels */
  width: number;
  /** Image height in pixels */
  height: number;
  /** Approximate size in bytes */
  sizeBytes: number;
}

/**
 * Options for PDF to image conversion
 */
export interface ConvertToImagesOptions {
  /** Maximum number of pages to convert (default: 5) */
  maxPages?: number;
  /** Scale factor for image resolution (default: 1.5 for good readability) */
  scale?: number;
  /** Target maximum size in bytes per image (default: 900000 for MCP 1MB limit) */
  maxSizeBytes?: number;
  /** JPEG quality 0-100 (default: 80 for balance of quality and size) */
  jpegQuality?: number;
}

/**
 * Default options for image conversion
 */
const DEFAULT_OPTIONS: Required<ConvertToImagesOptions> = {
  maxPages: 5,
  scale: 1.5,          // Good balance of readability and size
  maxSizeBytes: 900000, // Leave buffer for MCP 1MB limit
  jpegQuality: 80       // Good quality, reasonable size
};

/**
 * Convert ArrayBuffer to base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Dynamically import canvas module
 * Required by unpdf for serverless environments
 */
async function getCanvasModule() {
  // @napi-rs/canvas is compatible with node-canvas API
  return await import('@napi-rs/canvas');
}

/**
 * Estimate PNG to JPEG compression ratio
 * PNG is typically much larger than JPEG for photos/scanned docs
 */
function estimateJpegSize(pngSize: number, quality: number): number {
  // JPEG typically 10-30% of PNG for photographic content
  // Higher quality = larger file
  const qualityFactor = 0.1 + (quality / 100) * 0.3;
  return Math.round(pngSize * qualityFactor);
}

/**
 * Convert PDF buffer pages to JPEG images
 * Optimized for MCP 1MB limit with configurable quality
 *
 * @param pdfBuffer - PDF file as Buffer
 * @param options - Conversion options
 * @returns Array of ImageResult with base64-encoded JPEG images
 */
export async function convertToImages(
  pdfBuffer: Buffer,
  options: ConvertToImagesOptions = {}
): Promise<ImageResult[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  console.error(`[PdfToImage] Converting PDF to images (maxPages: ${opts.maxPages}, scale: ${opts.scale})`);

  // Get PDF document proxy
  const data = new Uint8Array(pdfBuffer);
  const pdf = await getDocumentProxy(data);

  // Get total page count
  const totalPages = pdf.numPages;
  const pagesToConvert = Math.min(totalPages, opts.maxPages);

  console.error(`[PdfToImage] PDF has ${totalPages} pages, converting first ${pagesToConvert}`);

  const results: ImageResult[] = [];

  // Convert each page
  for (let pageNum = 1; pageNum <= pagesToConvert; pageNum++) {
    console.error(`[PdfToImage] Rendering page ${pageNum}/${pagesToConvert}...`);

    try {
      // Render page as image using unpdf
      // Note: unpdf's renderPageAsImage returns PNG by default
      const imageBuffer = await renderPageAsImage(pdf, pageNum, {
        canvas: getCanvasModule,
        scale: opts.scale
      });

      // Convert ArrayBuffer to Buffer for processing
      const pngBuffer = Buffer.from(imageBuffer);

      // Get image dimensions (we'll estimate from data size and scale)
      // For a typical A4 page at 72 DPI base, scaled
      const estimatedWidth = Math.round(595 * opts.scale);  // A4 width in points
      const estimatedHeight = Math.round(842 * opts.scale); // A4 height in points

      // Convert PNG to JPEG with quality adjustment
      // We need to use canvas to convert to JPEG
      const canvas = await getCanvasModule();
      const img = new canvas.Image();

      // Load PNG into canvas
      img.src = pngBuffer;

      const canvasElement = canvas.createCanvas(img.width, img.height);
      const ctx = canvasElement.getContext('2d');

      // Draw white background (JPEG doesn't support transparency)
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, img.width, img.height);
      ctx.drawImage(img, 0, 0);

      // Convert to JPEG with quality setting
      // @napi-rs/canvas uses different API than node-canvas
      const jpegBuffer = canvasElement.toBuffer('image/jpeg', opts.jpegQuality);

      // Check if within size limit, reduce quality if needed
      let finalBuffer = jpegBuffer;
      let finalQuality = opts.jpegQuality;

      while (finalBuffer.length > opts.maxSizeBytes && finalQuality > 40) {
        finalQuality -= 10;
        console.error(`[PdfToImage] Page ${pageNum} too large (${finalBuffer.length} bytes), reducing quality to ${finalQuality}`);
        finalBuffer = canvasElement.toBuffer('image/jpeg', finalQuality);
      }

      // If still too large after quality reduction, try scaling down
      if (finalBuffer.length > opts.maxSizeBytes) {
        console.error(`[PdfToImage] Page ${pageNum} still too large, scaling down image`);
        const scaleFactor = Math.sqrt(opts.maxSizeBytes / finalBuffer.length) * 0.9;
        const newWidth = Math.round(img.width * scaleFactor);
        const newHeight = Math.round(img.height * scaleFactor);

        const scaledCanvas = canvas.createCanvas(newWidth, newHeight);
        const scaledCtx = scaledCanvas.getContext('2d');
        scaledCtx.fillStyle = '#ffffff';
        scaledCtx.fillRect(0, 0, newWidth, newHeight);
        scaledCtx.drawImage(img, 0, 0, newWidth, newHeight);

        finalBuffer = scaledCanvas.toBuffer('image/jpeg', finalQuality);
      }

      const base64 = finalBuffer.toString('base64');

      results.push({
        pageNumber: pageNum,
        base64,
        mimeType: 'image/jpeg',
        width: img.width,
        height: img.height,
        sizeBytes: finalBuffer.length
      });

      console.error(`[PdfToImage] Page ${pageNum}: ${img.width}x${img.height}, ${finalBuffer.length} bytes (quality: ${finalQuality})`);

    } catch (error) {
      console.error(`[PdfToImage] Failed to convert page ${pageNum}:`, error);
      // Continue with other pages even if one fails
    }
  }

  // Clean up
  await pdf.destroy();

  console.error(`[PdfToImage] Converted ${results.length}/${pagesToConvert} pages successfully`);

  return results;
}

/**
 * Get PDF metadata without converting pages
 */
export async function getPdfInfo(pdfBuffer: Buffer): Promise<{
  totalPages: number;
  metadata: Record<string, any>;
}> {
  const data = new Uint8Array(pdfBuffer);
  const pdf = await getDocumentProxy(data);

  const meta = await getMeta(pdf);
  const totalPages = pdf.numPages;

  await pdf.destroy();

  return {
    totalPages,
    metadata: {
      ...meta.info,
      ...meta.metadata
    }
  };
}

/**
 * Convert images to MCP-compatible format
 * Returns array of content blocks ready for MCP response
 */
export function toMcpImageContent(images: ImageResult[]): Array<{
  type: 'image';
  data: string;
  mimeType: 'image/jpeg';
}> {
  return images.map(img => ({
    type: 'image' as const,
    data: img.base64,
    mimeType: img.mimeType
  }));
}
