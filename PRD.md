# PRD: Gov.il Land Appraisal MCP Server v2

## Introduction

Build a robust MCP server for Claude Desktop that provides accurate, citation-backed answers about Israeli land appraisal decisions from three government databases. The server must handle 10,000+ documents efficiently without RAG, understand Hebrew natural language queries, and provide reliable answers with proper source attribution.

**Problem Statement:**
The existing `gov-il-live` MCP server is non-functional because:
1. All CSS selectors broke when gov.il updated their page structure
2. Tool descriptions don't help Claude parse Hebrew queries properly
3. Puppeteer timing issues cause silent failures
4. No verification that searches actually returned relevant results

**Target Sites:**
| Database | URL | Est. Documents |
|----------|-----|----------------|
| שמאי מכריע (Decisive Appraiser) | https://www.gov.il/he/departments/dynamiccollectors/decisive_appraisal_decisions | ~10,000+ |
| ועדת השגות (Appeals Committee) | https://www.gov.il/he/departments/dynamiccollectors/committee | ~5,000+ |
| ועדת ערעורים (Appeals Board) | https://www.gov.il/he/departments/dynamiccollectors/decisions_appeals_board | ~5,000+ |

## Goals

- Reliably search 20,000+ documents across three databases
- Understand Hebrew natural language queries
- Return accurate answers with citations to source documents
- Extract and analyze PDF content when needed
- Handle ambiguous queries by asking clarifying questions
- Sub-second response times for indexed data
- Graceful degradation when live fetching fails

## Non-Goals

- Real-time synchronization with gov.il (daily updates sufficient)
- Full RAG pipeline with embeddings (use structured search + keyword matching)
- Supporting other gov.il databases (only the three land appraisal databases)
- User authentication or personalization
- Multi-language support beyond Hebrew and English

## User Stories

### US-001: Build resilient data fetching layer
**Description:** As a developer, I want a data fetching layer that can reliably extract documents from gov.il using ScraperAPI, so that selector changes don't completely break the system.

**Acceptance Criteria:**
- [x] Use ScraperAPI with `render=true` and `premium=true` for JavaScript rendering
- [x] Implement multiple selector strategies with fallbacks
- [x] Add selector health check that validates selectors before full crawl
- [x] Parse HTML with Cheerio using adaptive patterns (class-based, structure-based, regex fallback)
- [x] Extract: title, PDF URL, block, plot, committee, appraiser, case type, dates
- [x] Log warning when primary selectors fail but fallback succeeds
- [x] Support pagination through `?skip=N` parameter
- [x] Typecheck passes

### US-002: Create local SQLite index with FTS5
**Description:** As a developer, I want a local SQLite database with full-text search, so that queries return results in milliseconds without hitting gov.il.

**Acceptance Criteria:**
- [x] SQLite database with FTS5 extension for Hebrew text search
- [x] Table schema: id, database, title, url, block, plot, committee, appraiser, caseType, decisionDate, publishDate, contentHash, indexedAt
- [x] FTS5 virtual table indexing: title, committee, appraiser, caseType
- [x] Support filtering by any combination of fields
- [x] Support date range queries (fromDate, toDate)
- [x] Return results with relevance ranking
- [x] Index location: `~/.gov-il-mcp/decisions.db`
- [x] Typecheck passes

### US-003: Implement PDF text extraction
**Description:** As a developer, I want to extract text from decision PDFs, so that Claude can answer questions about the actual decision content.

**Acceptance Criteria:**
- [ ] Download PDF using ScraperAPI (handles any blocking)
- [ ] Extract text using pdf-parse library
- [ ] Handle Hebrew RTL text properly
- [ ] Cache extracted text in database (avoid re-downloading)
- [ ] Support partial extraction (first N pages) for large PDFs
- [ ] Return structured output: { fullText, pageCount, extractedPages }
- [ ] Typecheck passes

### US-004: Design Hebrew-aware tool descriptions
**Description:** As a developer, I want tool descriptions that help Claude correctly parse Hebrew natural language queries into structured parameters, so that searches return relevant results.

**Acceptance Criteria:**
- [ ] Include 6+ diverse Hebrew query examples with expected parameter extraction
- [ ] Add database selection table mapping Hebrew keywords to databases:
  - "שמאי מכריע", "הכרעה" → decisive_appraiser
  - "השגה", "ועדת השגות" → appeals_committee
  - "ערעור", "ועדת ערעורים" → appeals_board
- [ ] Specify default database (decisive_appraiser) when unclear
- [ ] Include Hebrew descriptions for all parameters
- [ ] Add negative guidance: "Don't invent parameters user didn't mention"
- [ ] Document common case types: היטל השבחה, פיצויים, ירידת ערך
- [ ] Typecheck passes

### US-005: Implement query clarification tool
**Description:** As a developer, I want a tool that Claude can use to ask clarifying questions, so that ambiguous queries get resolved before searching.

**Acceptance Criteria:**
- [ ] Tool: `clarify_query` that returns structured clarification prompts
- [ ] Detect ambiguity patterns: missing database, vague location, unclear date range
- [ ] Generate Hebrew clarification questions with multiple-choice options
- [ ] Example: "באיזה מאגר לחפש?" with options [שמאי מכריע, ועדת השגות, ועדת ערעורים]
- [ ] Track clarification state to avoid asking same question twice
- [ ] Typecheck passes

### US-006: Build answer construction with citations
**Description:** As a developer, I want answers to include proper citations to source documents, so that users can verify the information and access original PDFs.

**Acceptance Criteria:**
- [ ] Format answers with inline citations: "[S0]", "[S1]", etc.
- [ ] Include sources section with: decision ID, title, PDF URL, relevance score
- [ ] For each claim, cite the specific decision(s) supporting it
- [ ] When answering from PDF content, quote relevant excerpts
- [ ] Add confidence indicator: "בטוח" (confident) vs "ייתכן" (uncertain)
- [ ] Warn when no relevant decisions found: "לא נמצאו החלטות רלוונטיות"
- [ ] Typecheck passes

### US-007: Implement incremental update mechanism
**Description:** As a developer, I want the database to update incrementally, so that new decisions are added without full re-crawl.

**Acceptance Criteria:**
- [ ] Tool: `trigger_update` checks first N pages for new decisions
- [ ] Compare content hash to detect duplicates
- [ ] Skip already-indexed decisions
- [ ] Log: "Found X new decisions in [database]"
- [ ] Store lastUpdateAt timestamp
- [ ] Script for daily cron job: `npm run daily-update`
- [ ] Typecheck passes

### US-008: Create MCP server with all tools
**Description:** As a developer, I want the MCP server to expose all tools via stdio transport, so that Claude Desktop can use them.

**Acceptance Criteria:**
- [ ] Tools exposed: search_decisions, get_decision, read_pdf, get_statistics, list_committees, list_appraisers, trigger_update, clarify_query
- [ ] Each tool has comprehensive Hebrew+English description
- [ ] Error responses include actionable suggestions
- [ ] Graceful handling of database unavailable
- [ ] Console logging to stderr (not stdout)
- [ ] Typecheck passes

### US-009: Add configuration for Claude Desktop
**Description:** As a user, I want easy installation in Claude Desktop, so that I can start using the server quickly.

**Acceptance Criteria:**
- [ ] README with installation steps
- [ ] Claude Desktop config snippet for `claude_desktop_config.json`
- [ ] Environment variable: `SCRAPER_API_KEY` for live fetching
- [ ] First-run initialization creates database
- [ ] Health check tool to verify setup
- [ ] Typecheck passes

### US-010: Implement fallback for selector failures
**Description:** As a developer, I want the scraper to try multiple extraction strategies, so that gov.il page changes don't completely break data fetching.

**Acceptance Criteria:**
- [ ] Strategy 1: CSS selectors (primary)
- [ ] Strategy 2: XPath patterns (fallback 1)
- [ ] Strategy 3: Regex on raw HTML (fallback 2)
- [ ] Strategy 4: Return cached data with warning (fallback 3)
- [ ] Log which strategy succeeded
- [ ] Alert mechanism when primary strategy fails 3+ times
- [ ] Typecheck passes

## Technical Notes

### ScraperAPI Configuration
```javascript
const scraperUrl = `https://api.scraperapi.com?api_key=${API_KEY}&url=${encodeURIComponent(targetUrl)}&render=true&premium=true`;
```

### Database Schema
```sql
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  database TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  block TEXT,
  plot TEXT,
  committee TEXT,
  appraiser TEXT,
  caseType TEXT,
  decisionDate TEXT,
  publishDate TEXT,
  contentHash TEXT UNIQUE,
  pdfText TEXT,
  indexedAt TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE decisions_fts USING fts5(
  title, committee, appraiser, caseType,
  content='decisions',
  content_rowid='rowid'
);
```

### Common Hebrew Query Patterns
| Query Pattern | Expected Extraction |
|--------------|---------------------|
| "החלטות בנתניה" | {city: "נתניה"} |
| "גוש 6158 חלקה 25" | {block: "6158", plot: "25"} |
| "היטל השבחה תל אביב" | {caseType: "היטל השבחה", city: "תל אביב"} |
| "ערעורים מ-2024" | {database: "appeals_board", yearFrom: 2024} |
| "שמאי מכריע כהן" | {database: "decisive_appraiser", appraiser: "כהן"} |
| "פיצויים על הפקעה" | {caseType: "פיצויים"} |

### Existing Code Reference
- Working database layer: `automation-shamai/mcp-server/src/database.ts`
- Working indexer: `automation-shamai/mcp-server/src/indexer.ts`
- Broken scraper (needs new selectors): `automation-shamai/mcp-server/src/scraper.ts`
- QA findings: `automation-shamai/mcp-server-live/QA-FINDINGS.md`

### API Key
ScraperAPI: `566e1370a3f3158b969f898e102c7fd0`
