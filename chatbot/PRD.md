# PRD: Israeli Land Appraisal Legal Chatbot (שמאות מכריעה)

## Executive Summary

A production-ready Hebrew legal chatbot for Israeli land appraisal decisions. The system indexes **all documents** from 3 gov.il databases (~20,000+ decisions), stores them in Pinecone for RAG retrieval, and provides a professional UI for legal professionals to query decisions with cited sources.

**Goal:** Enable legal professionals to ask questions like:
- "מה הסטטיסטיקה של החלטות בתל אביב ב-2024?" (Statistics of Tel Aviv decisions in 2024)
- "מצא תקדימים להיטל השבחה על הפקעה" (Find precedents for betterment levy on expropriation)
- "השווה בין החלטות של שמאי כהן לשמאי לוי" (Compare decisions by appraiser Cohen vs Levy)

---

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         LEGAL CHATBOT SYSTEM                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────────┐  │
│  │  Gov.il      │    │  ScraperAPI  │    │  Pinecone Vector DB      │  │
│  │  Databases   │───►│  (Scraper)   │───►│  gov-il-decisions        │  │
│  │  (3 sources) │    │  ultra_prem  │    │  ~20,000 embeddings      │  │
│  └──────────────┘    └──────────────┘    └────────────┬─────────────┘  │
│                                                        │                 │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                     n8n Workflows                                 │  │
│  │  ┌────────────────────┐  ┌───────────────────┐  ┌──────────────┐│  │
│  │  │ 1. Full Indexer    │  │ 2. Daily Update   │  │ 3. RAG Chat  ││  │
│  │  │ (fetch all docs)   │  │ (incremental)     │  │ (query+AI)   ││  │
│  │  └────────────────────┘  └───────────────────┘  └──────────────┘│  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                        │                 │
│  ┌──────────────┐    ┌──────────────────────────────────────────────┐  │
│  │  Frontend    │◄───│  Hallucination Detection                      │  │
│  │  (Hebrew UI) │    │  (Strawberry/Pythea KL-divergence)            │  │
│  └──────────────┘    └──────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Data Sources (CRITICAL)

### Gov.il Databases

| Database | Hebrew Name | URL | Est. Docs |
|----------|-------------|-----|-----------|
| decisive_appraiser | שמאי מכריע | https://www.gov.il/he/departments/dynamiccollectors/decisive_appraisal_decisions | ~10,000 |
| appeals_committee | ועדת השגות | https://www.gov.il/he/departments/dynamiccollectors/committee | ~5,000 |
| appeals_board | ועדת ערעורים | https://www.gov.il/he/departments/dynamiccollectors/decisions_appeals_board | ~5,000 |

### API Keys & Credentials

```yaml
ScraperAPI:
  key: 566e1370a3f3158b969f898e102c7fd0
  settings:
    ultra_premium: true     # REQUIRED for gov.il
    render: true            # JavaScript rendering
    wait_for: 5000          # 5 seconds for Angular

Pinecone:
  host: https://gov-il-decisions-k1iqa9s.svc.aped-4627-b74a.pinecone.io
  namespace: gov-il-decisions
  dimension: 1024           # text-embedding-3-small

OpenAI:
  embedding_model: text-embedding-3-small
  chat_model: gpt-4o
  verification_model: gpt-4o-mini
```

---

## Phase 1: Discovery & Planning

### US-P1-001: Analyze Existing System
**As** Ralph Loop
**I want** to understand the current implementation
**So that** I can identify gaps and improvements

**Acceptance Criteria:**
- [x] Map existing n8n workflows (IDs: oqihIkB7Ur9WVJZG, kTZqcClvtUspeC28, McOa9j15PRy8AZ8v)
- [x] Document current Pinecone schema and data
- [x] Identify what documents are already indexed
- [x] List current frontend features
- [x] Document current hallucination detection flow

---

### US-P1-002: Data Gap Analysis
**As** Ralph Loop
**I want** to identify missing documents
**So that** I know what needs to be indexed

**Acceptance Criteria:**
- [x] Query Pinecone to count existing vectors by namespace
- [x] Estimate total documents from each gov.il database
- [x] Calculate coverage percentage per database
- [x] List databases with <80% coverage

---

## Phase 2: Full Document Indexing

### US-P2-001: Create Full Indexer Workflow
**As** n8n
**I want** a workflow that fetches ALL documents from all 3 databases
**So that** Pinecone contains complete data

**Acceptance Criteria:**
- [x] n8n workflow: "Full Indexer - All Databases"
- [x] Fetches pages via ScraperAPI with `ultra_premium=true`, `wait_for=5000`
- [x] Pagination: `?skip=0`, `?skip=10`, `?skip=20`, ... until no results
- [x] Parses Hebrew decision titles correctly
- [x] Extracts metadata: title, url, database, block, plot, committee, appraiser, caseType, decisionDate
- [x] Creates embeddings via OpenAI text-embedding-3-small (1024 dimensions)
- [x] Upserts to Pinecone with metadata
- [x] **CRITICAL: One document = one vector** (no splitting)
- [x] Progress tracking with resume capability
- [x] Rate limiting: 1 request/second to ScraperAPI

**Implementation Notes:**
```javascript
// ScraperAPI URL builder
function buildScraperUrl(targetUrl) {
  const params = new URLSearchParams({
    api_key: '566e1370a3f3158b969f898e102c7fd0',
    url: targetUrl,
    render: 'true',
    ultra_premium: 'true',
    wait_for: '5000'
  });
  return `https://api.scraperapi.com?${params}`;
}

// Decision title regex (decisive_appraiser)
const TITLE_REGEX = /הכרעת שמאי מכריע מיום (\d{2}-\d{2}-\d{4}) בעניין ([^נ]+)נ ([^ג]+)ג (\d+) ח (\d+)\s*-?\s*(.+)?/;
```

---

### US-P2-002: PDF Content Extraction
**As** the indexer
**I want** to extract full text from decision PDFs
**So that** RAG has complete content for answers

**Acceptance Criteria:**
- [x] Fetch PDF via ScraperAPI (same settings)
- [x] Extract text using pdf-parse
- [x] Handle Hebrew RTL text properly
- [x] Store full text as Pinecone metadata (max 40KB per vector)
- [x] For large PDFs, store first 35KB + summary
- [x] Link PDF URL in metadata for direct access

---

### US-P2-003: Pinecone Schema
**As** the system
**I want** a consistent vector schema
**So that** queries return complete information

**Metadata Schema:**
```typescript
interface DecisionMetadata {
  // Core fields
  id: string;           // Unique: `${database}-${contentHash.slice(0,12)}`
  database: 'decisive_appraiser' | 'appeals_committee' | 'appeals_board';
  title: string;        // Full Hebrew title
  url: string;          // PDF URL (free-justice.openapi.gov.il)

  // Structured fields (for filtering)
  block: string | null;      // גוש
  plot: string | null;       // חלקה
  committee: string | null;  // ועדה מקומית
  appraiser: string | null;  // שמאי (decisive_appraiser only)
  caseType: string | null;   // היטל השבחה, פיצויים, ירידת ערך, etc.
  decisionDate: string | null; // DD-MM-YYYY
  year: string | null;       // Extracted year for filtering

  // Content
  description: string;  // Full text or summary (max 35KB)
  contentHash: string;  // For deduplication

  // Timestamps
  indexedAt: string;    // ISO datetime
  publishDate: string | null;
}
```

**Acceptance Criteria:**
- [x] All vectors follow this schema
- [x] id is unique and deterministic
- [x] contentHash prevents duplicates
- [x] year field enables year-based filtering

---

## Phase 3: RAG Chatbot Refinement

### US-P3-001: Improved Query Understanding
**As** the chatbot
**I want** to understand Hebrew legal queries
**So that** I retrieve the most relevant documents

**Acceptance Criteria:**
- [x] Parse query for structured filters:
  - Block/plot: `גוש 6158` → filter `block=6158`
  - Committee: `תל אביב` → filter `committee=תל אביב`
  - Year: `2024` or `תשפ"ד` → filter `year=2024`
  - Case type: `היטל השבחה` → filter `caseType=היטל השבחה`
  - Appraiser: `שמאי כהן` → filter `appraiser=כהן`
- [x] Combine semantic search with metadata filters
- [x] Increase topK for analytical queries (topK=20 for statistics)

---

### US-P3-002: Source Attribution (CRITICAL)
**As** a legal professional
**I want** each claim to cite its exact source
**So that** I can verify information

**Acceptance Criteria:**
- [x] Citations use format [S0], [S1], [S2], etc.
- [x] Each [S#] maps to ONE complete document (not chunks)
- [x] Sources include:
  - Full title
  - Database source (שמאי מכריע/ועדת השגות/ועדת ערעורים)
  - Decision date
  - PDF URL (clickable)
  - Relevance score (%)
- [x] Hovering [S#] shows tooltip with source preview
- [x] Click [S#] opens PDF in new tab

---

### US-P3-003: Analytical Queries
**As** a legal researcher
**I want** to ask statistical questions
**So that** I can analyze trends

**Example Queries & Expected Behavior:**

| Query | Expected Action |
|-------|-----------------|
| "כמה החלטות יש בתל אביב ב-2024?" | Count vectors where committee="תל אביב" AND year="2024" |
| "מי השמאי עם הכי הרבה החלטות?" | Group by appraiser, count, return top 10 |
| "מהי התפלגות סוגי התיקים?" | Group by caseType, count, return as chart data |
| "השווה בין 2023 ל-2024" | Count by year for comparison |

**Acceptance Criteria:**
- [x] Detect analytical intent from query
- [x] For counting: use Pinecone filter queries, not AI generation
- [x] For statistics: aggregate results before sending to AI
- [x] Return structured data for charts when appropriate
- [x] AI synthesizes the data into Hebrew narrative

---

### US-P3-004: Hallucination Detection Enhancement
**As** a legal professional
**I want** confidence indicators on each claim
**So that** I know what to trust

**Current:** Strawberry/Pythea KL-divergence algorithm (EXISTS)

**Enhancements:**
- [x] Show grounding badge prominently:
  - 🟢 `מבוסס` (>80% grounded)
  - 🟡 `מבוסס חלקית` (50-80% grounded)
  - 🔴 `דורש בדיקה` (<50% grounded)
- [x] Per-claim breakdown expandable
- [x] Warning banner for ungrounded claims
- [x] Link ungrounded claims to "need verification" state

---

## Phase 4: Frontend UI/UX

### US-P4-001: Professional Legal UI
**As** a legal professional
**I want** a clean, professional interface
**So that** I can work efficiently

**Acceptance Criteria:**
- [ ] Hebrew RTL layout
- [ ] Dark header with title: "צ'אטבוט שמאות מכריעה"
- [ ] Clean chat bubbles (user right, assistant left)
- [ ] Typing indicator while loading
- [ ] Error handling with Hebrew messages
- [ ] Mobile responsive

---

### US-P4-002: Source Display Panel
**As** a user
**I want** sources displayed clearly
**So that** I can review and access original documents

**Acceptance Criteria:**
- [ ] Collapsible sources section below each response
- [ ] Each source shows:
  - Number badge [S0], [S1], etc.
  - Title (clickable → opens PDF)
  - Database label (color-coded)
  - Relevance percentage
  - Decision date
- [ ] Sort by relevance (default) or date
- [ ] "Open PDF" button for each source

---

### US-P4-003: Interactive Citations
**As** a user reading a response
**I want** citations to be interactive
**So that** I can quickly understand where information comes from

**Acceptance Criteria:**
- [ ] [S#] tags are styled blue badges
- [ ] Hover shows tooltip with:
  - Source title
  - Relevance score
  - "Click to expand" hint
- [ ] Click highlights the source in the sources list
- [ ] Multiple citations [S0][S1] group together
- [ ] Animation: subtle highlight when hovering

---

### US-P4-004: Analytics Dashboard
**As** a researcher
**I want** to see visual analytics
**So that** I can understand data at a glance

**Acceptance Criteria:**
- [ ] When response contains statistics, show chart
- [ ] Chart types:
  - Bar chart for counts by category
  - Line chart for trends over time
  - Pie chart for distribution
- [ ] Charts are interactive (hover for values)
- [ ] Export chart as PNG option

---

## Phase 5: Testing (TDD)

### US-P5-001: Unit Tests - Scraper
**As** a developer
**I want** scraper tests
**So that** parsing doesn't break

**Test Cases:**
- [ ] `test_parse_decisive_appraiser_title()` - Hebrew title parsing
- [ ] `test_parse_appeals_committee_title()` - Different format
- [ ] `test_extract_block_plot()` - גוש/חלקה extraction
- [ ] `test_extract_committee()` - ועדה name extraction
- [ ] `test_handle_pagination()` - Multiple pages
- [ ] `test_scraper_api_settings()` - ultra_premium, wait_for

---

### US-P5-002: Integration Tests - Pinecone
**As** a developer
**I want** Pinecone integration tests
**So that** vectors are stored correctly

**Test Cases:**
- [ ] `test_upsert_single_document()` - Basic upsert
- [ ] `test_upsert_with_metadata()` - All fields
- [ ] `test_query_by_filter()` - committee filter
- [ ] `test_query_semantic()` - Embedding similarity
- [ ] `test_no_duplicates()` - contentHash check

---

### US-P5-003: E2E Tests - Chat Flow
**As** a developer
**I want** end-to-end chat tests
**So that** the full flow works

**Test Cases:**
- [ ] `test_simple_query()` - "מה זה היטל השבחה?"
- [ ] `test_specific_search()` - "החלטות בגוש 6158"
- [ ] `test_analytical_query()` - "כמה החלטות בתל אביב?"
- [ ] `test_citation_format()` - Response contains [S0]
- [ ] `test_hallucination_detection()` - Grounding badge present
- [ ] `test_error_handling()` - Invalid input graceful fail

---

## Implementation Order (Ralph Loop)

```
Phase 1: Discovery
  └─► US-P1-001: Analyze existing system
  └─► US-P1-002: Data gap analysis

Phase 2: Indexing (CRITICAL PATH)
  └─► US-P2-003: Pinecone schema (design first)
  └─► US-P2-001: Full indexer workflow
  └─► US-P2-002: PDF content extraction

Phase 3: RAG Refinement
  └─► US-P3-001: Query understanding
  └─► US-P3-002: Source attribution
  └─► US-P3-003: Analytical queries
  └─► US-P3-004: Hallucination detection

Phase 4: Frontend
  └─► US-P4-001: Professional UI
  └─► US-P4-002: Source display
  └─► US-P4-003: Interactive citations
  └─► US-P4-004: Analytics dashboard

Phase 5: Testing
  └─► US-P5-001: Scraper tests
  └─► US-P5-002: Pinecone tests
  └─► US-P5-003: E2E tests
```

---

## File Structure

```
automation-shamai/
├── chatbot/
│   ├── PRD.md                    # This file
│   ├── progress.txt              # Ralph Loop progress
│   ├── frontend/
│   │   ├── index.html            # Main UI
│   │   ├── styles.css            # Styling
│   │   └── app.js                # Frontend logic
│   └── tests/
│       ├── test_scraper.js       # Scraper tests
│       ├── test_pinecone.js      # Pinecone tests
│       └── test_e2e.js           # E2E tests
├── workflows/
│   ├── 1-full-indexer.json       # Full indexing workflow
│   ├── 2-daily-update.json       # Incremental updates
│   ├── 3-rag-chatbot.json        # RAG + hallucination (EXISTS)
│   └── chatbot-frontend.html     # Current frontend (EXISTS)
└── mcp-server/                    # Existing MCP server
```

---

## n8n Workflow IDs (Reference)

| Workflow | ID | Purpose |
|----------|-----|---------|
| Workflow 1 | oqihIkB7Ur9WVJZG | (To be analyzed) |
| Workflow 2 | kTZqcClvtUspeC28 | (To be analyzed) |
| Workflow 3 | McOa9j15PRy8AZ8v | (To be analyzed) |
| RAG Chatbot | (local file) | RAG + Hallucination Detection |

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Documents indexed | >20,000 |
| Pinecone coverage | >95% of all gov.il decisions |
| Query latency | <3 seconds |
| Citation accuracy | 100% of sources verifiable |
| Grounding ratio | >80% claims grounded |
| User satisfaction | Can answer "statistics for Tel Aviv 2024" |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| ScraperAPI rate limits | 1 req/sec, resume capability |
| Pinecone metadata size limit (40KB) | Truncate large PDFs, store summary |
| Hebrew parsing errors | Comprehensive regex tests |
| Hallucination in statistics | Use Pinecone filters, not AI generation |
| PDF extraction failures | Fallback to title-only indexing |

---

*PRD Version: 1.0*
*Created: 2026-01-21*
*Target: Full indexing + refined chatbot for legal professionals*
