# PRD: PDF Caching & Pinecone Integration for MCP Server

## Problem Statement
The current MCP server has critical issues:
1. **No Pinecone connection**: MCP queries SQLite (1 doc) while Python indexer feeds Pinecone (20K docs)
2. **Missing cache methods**: `getCachedPdfText()` and `savePdfText()` were not implemented (FIXED)
3. **No file caching**: PDFs are re-downloaded via ScraperAPI every time
4. **ScraperAPI latency**: Each request takes 5-15 seconds and costs credits
5. **No offline access**: Can't read PDFs without internet

## Goal
1. Connect MCP server to Pinecone so it can query the 20K indexed documents
2. Enable fast, reliable, offline PDF reading via hybrid caching system

---

## Status Summary

| Story | Status | Description |
|-------|--------|-------------|
| US-PDF-010 | [x] | Add Pinecone client |
| US-PDF-011 | [x] | Generate embeddings for queries |
| US-PDF-012 | [x] | Update semantic_search to use Pinecone |
| US-PDF-013 | [x] | Update read_pdf for Pinecone results |
| US-PDF-001 | [x] | Implement getCachedPdfText |
| US-PDF-002 | [x] | Implement savePdfText |
| US-PDF-003 | [x] | Create PdfCache module |
| US-PDF-004 | [x] | Integrate file cache |
| US-PDF-005 | [x] | Add pdf_cache tracking table |
| US-PDF-006 | [x] | Add cache management tools |
| US-PDF-007 | [x] | Add PDF to image conversion |
| US-PDF-008 | [x] | Return images for scanned PDFs |
| US-PDF-009 | [x] | Create prefetch script |

---

## Architecture After Implementation
```
User Query (Claude Desktop)
        │
        ▼
MCP Server semantic_search
        │
        ▼
Query Pinecone (20K docs) ──► Get relevant doc IDs + URLs
        │
        ▼
read_pdf(id)
        │
        ├─► Text Cache (SQLite) ──► HIT: Return instantly
        │
        ├─► File Cache (local) ──► HIT: Extract + return
        │
        └─► Download (ScraperAPI) ──► Cache + return
```

## Target Performance
| Scenario | Current | Target |
|----------|---------|--------|
| First PDF read | 5-15 sec | 5-15 sec (download once) |
| Repeat PDF read | 5-15 sec | <200ms (cached) |
| Offline read | ❌ Fails | ✅ Works |
| Searchable docs | 1 | 20,000+ |

---

## Phase 0: Pinecone Integration (CRITICAL)

### US-PDF-010: Add Pinecone client to MCP server
**Priority**: P0 - Critical for chatbot functionality

**Acceptance Criteria:**
- [x] Install `@pinecone-database/pinecone` package
- [x] Create `src/pinecone-client.ts` with PineconeClient class
- [x] Add environment variables: `PINECONE_API_KEY`, `PINECONE_INDEX_HOST`
- [x] Implement `query(embedding: number[], topK: number)` method
- [x] Return results with: id, title, url, score, metadata

**Implementation:**
```typescript
// src/pinecone-client.ts
import { Pinecone } from '@pinecone-database/pinecone';

export class PineconeClient {
  private client: Pinecone;
  private indexName: string;

  constructor(apiKey: string, indexName: string) {
    this.client = new Pinecone({ apiKey });
    this.indexName = indexName;
  }

  async query(embedding: number[], topK: number = 10, namespace: string = 'gov-il-decisions') {
    const index = this.client.index(this.indexName);
    const results = await index.namespace(namespace).query({
      vector: embedding,
      topK,
      includeMetadata: true
    });
    return results.matches || [];
  }
}
```

---

### US-PDF-011: Generate embeddings for search queries
**Priority**: P0
**Status**: ✅ COMPLETED

**Acceptance Criteria:**
- [x] Add OpenAI embedding generation in `embeddings.ts`
- [x] Use `text-embedding-3-small` model with 1024 dimensions (matches Python indexer)
- [x] Add `OPENAI_API_KEY` environment variable
- [x] Create `generateEmbedding(text: string): Promise<number[]>` function

**Implementation:**
```typescript
// Add to embeddings.ts
export async function generateQueryEmbedding(text: string): Promise<number[]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
      dimensions: 1024
    })
  });
  const data = await response.json();
  return data.data[0].embedding;
}
```

---

### US-PDF-012: Update semantic_search to use Pinecone
**Priority**: P0
**Status**: ✅ COMPLETED

**Acceptance Criteria:**
- [x] Modify `handleSemanticSearch()` in `index.ts`
- [x] Generate embedding for query text
- [x] Query Pinecone instead of SQLite embeddings
- [x] Map Pinecone results to Decision format
- [x] Return results with relevance scores

**Updated flow:**
```
semantic_search(query)
  1. Generate embedding for query text (OpenAI)
  2. Query Pinecone with embedding
  3. Map results to Decision objects
  4. Return with relevance scores
```

---

### US-PDF-013: Update read_pdf to work with Pinecone results
**Priority**: P0
**Status**: ✅ COMPLETED

**Acceptance Criteria:**
- [x] Accept decision ID in format from Pinecone metadata
- [x] Extract PDF URL from Pinecone metadata (not SQLite)
- [x] Cache results locally after first read
- [x] Handle case where decision exists in Pinecone but not SQLite

---

## Phase 1: Fix Missing Cache Methods (COMPLETED)

### US-PDF-001: Implement getCachedPdfText method
**Priority**: P0 - Critical bug fix
**Status**: ✅ COMPLETED

**Acceptance Criteria:**
- [x] Add `getCachedPdfText(decisionId: string): string | null` method to `DecisionDatabase` class
- [x] Method queries `pdf_text` column from `decisions` table
- [x] Returns null if no cached text exists
- [x] Method is called by `pdf-extractor.ts` extractWithCache()

---

### US-PDF-002: Implement savePdfText method
**Priority**: P0 - Critical bug fix
**Status**: ✅ COMPLETED

**Acceptance Criteria:**
- [x] Add `savePdfText(decisionId: string, text: string): boolean` method to `DecisionDatabase` class
- [x] Method updates `pdf_text` column in `decisions` table
- [x] Returns true on success, false on failure
- [x] Calls `this.save()` to persist changes

---

## Phase 2: Local File Cache

### US-PDF-001: Implement getCachedPdfText method
**Priority**: P0 - Critical bug fix

**Acceptance Criteria:**
- [ ] Add `getCachedPdfText(decisionId: string): string | null` method to `DecisionDatabase` class
- [ ] Method queries `pdf_text` column from `decisions` table
- [ ] Returns null if no cached text exists
- [ ] Method is called by `pdf-extractor.ts` extractWithCache()

**Implementation:**
```typescript
// database.ts - add to DecisionDatabase class
getCachedPdfText(decisionId: string): string | null {
  if (!this.db) throw new Error('Database not initialized');
  const result = this.db.exec(
    `SELECT pdf_text FROM decisions WHERE id = ? AND pdf_text IS NOT NULL AND pdf_text != ''`,
    [decisionId]
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  return String(result[0].values[0][0]);
}
```

---

### US-PDF-002: Implement savePdfText method
**Priority**: P0 - Critical bug fix

**Acceptance Criteria:**
- [ ] Add `savePdfText(decisionId: string, text: string): boolean` method to `DecisionDatabase` class
- [ ] Method updates `pdf_text` column in `decisions` table
- [ ] Returns true on success, false on failure
- [ ] Calls `this.save()` to persist changes

**Implementation:**
```typescript
// database.ts - add to DecisionDatabase class
savePdfText(decisionId: string, text: string): boolean {
  if (!this.db) throw new Error('Database not initialized');
  try {
    this.db.run(
      `UPDATE decisions SET pdf_text = ? WHERE id = ?`,
      [text, decisionId]
    );
    this.save();
    return true;
  } catch (error) {
    console.error(`[Database] Failed to save PDF text for ${decisionId}:`, error);
    return false;
  }
}
```

---

## Phase 2: Local File Cache

### US-PDF-003: Create PdfCache module
**Priority**: P1
**Status**: ✅ COMPLETED

**Acceptance Criteria:**
- [x] Create new file `src/pdf-cache.ts`
- [x] Implement `PdfCache` class with methods:
  - `isCached(decisionId, database): boolean`
  - `loadPdf(decisionId, database): Buffer | null`
  - `savePdf(decisionId, database, buffer): Promise<CachedPdfInfo>`
  - `getStats(): CacheStats`
- [x] Store PDFs in `~/.gov-il-mcp/pdfs/{database}/{id}.pdf`
- [x] Create directory structure on initialization

---

### US-PDF-004: Integrate file cache into pdf-extractor
**Priority**: P1

**Acceptance Criteria:**
- [ ] Update `PdfExtractorOptions` to accept optional `PdfCache` instance
- [ ] Modify `extractWithCache()` to check file cache before downloading
- [ ] Save downloaded PDFs to file cache
- [ ] Extraction order: text cache → file cache → network download

**Updated flow:**
```
extractWithCache(decisionId, pdfUrl)
  1. Check text cache (getCachedPdfText) → HIT: return text
  2. Check file cache (pdfCache.loadPdf) → HIT: extract text, save to text cache, return
  3. Download from network (ScraperAPI)
  4. Save to file cache (pdfCache.savePdf)
  5. Extract text and save to text cache (savePdfText)
  6. Return extracted text
```

---

### US-PDF-005: Add pdf_cache tracking table
**Priority**: P2

**Acceptance Criteria:**
- [ ] Add `pdf_cache` table to database schema in `initializeDatabase()`
- [ ] Track: decision_id, file_path, file_size, file_hash, cached_at, last_accessed, extraction_status
- [ ] Add index on extraction_status for filtering
- [ ] Add `getPdfCacheStats()` method to database

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS pdf_cache (
  decision_id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_hash TEXT NOT NULL,
  cached_at TEXT DEFAULT (datetime('now')),
  last_accessed TEXT,
  extraction_status TEXT DEFAULT 'pending'
);
```

---

### US-PDF-006: Add cache management tools
**Priority**: P2

**Acceptance Criteria:**
- [ ] Add `get_pdf_cache_stats` tool to MCP server
- [ ] Add `cleanup_pdf_cache` tool with LRU strategy
- [ ] Default max cache size: 5GB
- [ ] Cleanup removes least recently accessed PDFs first

---

## Phase 3: Claude Vision Fallback (for scanned PDFs)

### US-PDF-007: Add PDF to image conversion
**Priority**: P2
**Status**: ✅ COMPLETED

**Acceptance Criteria:**
- [x] Install `unpdf` and `@napi-rs/canvas` packages
- [x] Add `convertToImages(pdfBuffer, maxPages): Promise<ImageResult[]>` method
- [x] Optimize images for MCP 1MB limit (JPEG 70-85% quality)
- [x] Return base64-encoded images

---

### US-PDF-008: Return images when text extraction fails
**Priority**: P2
**Status**: ✅ COMPLETED

**Acceptance Criteria:**
- [x] If extracted text < 100 chars, consider PDF "scanned"
- [x] Convert first 3-5 pages to images
- [x] Return images in MCP format: `{ type: 'image', data: base64, mimeType: 'image/jpeg' }`
- [x] Include prompt asking Claude to extract Hebrew text visually

---

## Phase 4: Bulk Prefetch (Optional)

### US-PDF-009: Create prefetch script
**Priority**: P3

**Acceptance Criteria:**
- [ ] Create `scripts/prefetch-pdfs.ts`
- [ ] Download all PDFs with URLs in database
- [ ] Support `--limit`, `--delay`, `--database` options
- [ ] Skip already cached PDFs
- [ ] Add npm script: `"prefetch-pdfs": "tsx scripts/prefetch-pdfs.ts"`

---

## Estimated Disk Space

| Database | ~Decisions | Avg PDF | Total |
|----------|------------|---------|-------|
| decisive_appraiser | 10,000 | 500KB | 5GB |
| appeals_committee | 5,000 | 400KB | 2GB |
| appeals_board | 5,000 | 400KB | 2GB |
| **Total** | **20,000** | | **~9GB** |

---

## Implementation Priority

1. **P0 (Critical)**: US-PDF-010, US-PDF-011, US-PDF-012, US-PDF-013 - Pinecone integration
2. **P0 (Done)**: US-PDF-001, US-PDF-002 - Fix missing cache methods ✅
3. **P1 (This Week)**: US-PDF-003, US-PDF-004 - File caching
4. **P2 (Next Week)**: US-PDF-005, US-PDF-006, US-PDF-007, US-PDF-008 - Tracking + Vision
5. **P3 (Later)**: US-PDF-009 - Bulk prefetch

## Environment Variables Required

Add to Claude Desktop MCP config (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "gov-il-land-appraisal": {
      "command": "npx",
      "args": ["tsx", "C:/Users/user/automation-shamai/mcp-server/src/index.ts"],
      "env": {
        "SCRAPER_API_KEY": "your-scraper-api-key",
        "PINECONE_API_KEY": "your-pinecone-api-key",
        "PINECONE_INDEX_NAME": "gov-il-decisions",
        "OPENAI_API_KEY": "your-openai-api-key"
      }
    }
  }
}
```

---

## Testing

After implementing, test with:
```
1. read_pdf for a decision (should download and cache)
2. read_pdf same decision again (should return instantly from cache)
3. Restart Claude Desktop, read_pdf again (should use file cache)
4. Disconnect internet, read_pdf cached decision (should work offline)
```
