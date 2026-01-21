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

## 🚨 PHASE 0: CRITICAL FIX (DO THIS FIRST)

### US-CRITICAL-001: Fix Webhook Response Node Connection
**Priority:** BLOCKING - Chatbot cannot respond without this fix
**Status:** [x] FIXED (2026-01-21)

**Error:** `500 Internal Server Error: "No Respond to Webhook node found in the workflow"`

**Root Cause:**
The n8n workflow (ID: `McOa9j15PRy8AZ8v`) has `responseMode: "responseNode"` on the webhook, but the execution path cannot find the "Respond to Webhook" node. The local workflow JSON (`workflows/3-rag-chatbot.json`) has correct connections, but the live n8n workflow is broken.

**Fix Instructions (Manual in n8n UI):**

**Option A: Re-import the Local Workflow**
1. Go to https://a-i-do.app.n8n.cloud/workflow/McOa9j15PRy8AZ8v
2. Delete all nodes (Ctrl+A, Delete)
3. Open `C:\Users\user\automation-shamai\workflows\3-rag-chatbot.json`
4. Copy the entire JSON content
5. In n8n, paste (Ctrl+V) to import all nodes
6. Save and Activate

**Option B: Fix Connections Manually**
1. Open https://a-i-do.app.n8n.cloud/workflow/McOa9j15PRy8AZ8v
2. Verify these nodes exist:
   - `Chat Webhook` (trigger)
   - `Respond with Chat` (respondToWebhook node)
3. Trace the connection path:
   ```
   Chat Webhook → Extract User Message → Embed User Query → Query Pinecone →
   Build RAG Context → Generate AI Response → Extract Claims & Citations →
   Build Verification Prompts → [PARALLEL: Verify Posterior, Verify Prior] →
   Merge Verification Results → Compute Budget Gaps → Format Response →
   Respond with Chat
   ```
4. If any connection is missing, drag from the output dot to input dot
5. Save and Activate

**Acceptance Criteria:**
- [x] Workflow responds to POST requests at `/webhook/chat`
- [x] Response includes `success: true` and `response: "..."` fields
- [x] Test query: `curl -X POST -H "Content-Type: application/json" -d '{"message":"מה זה היטל השבחה?"}' https://a-i-do.app.n8n.cloud/webhook/chat`

**Actual Fixes Applied (2026-01-21):**
1. Added IF node connections (Check Statistics Query + Check Counting Query)
2. Fixed corrupted HTTP Request nodes (Embed User Query, Query Pinecone, Query Pinecone Stats)
3. Simplified Parse Query Filters to bypass broken Hebrew regex
4. Added bypass connection from Extract User Message → Embed User Query
5. Updated Build RAG Context to reference Extract User Message instead of Parse Query Filters

---

### US-CRITICAL-002: Simplified Fallback Workflow (If US-CRITICAL-001 Fails)
**Priority:** HIGH - Alternative if hallucination detection path is broken

If the full hallucination detection path is too complex, create a simplified version:

```
Chat Webhook → Extract Message → Embed → Query Pinecone → Build Context →
Generate AI Response → Simple Format → Respond with Chat
```

**Simplified "Simple Format" Code Node:**
```javascript
const aiResponse = $input.first().json;
const contextData = $('Build RAG Context').first().json;

return {
  success: true,
  response: aiResponse?.choices?.[0]?.message?.content || 'מצטער, לא הצלחתי לייצר תשובה.',
  sources: contextData?.relevantDocs || [],
  matchCount: contextData?.matchCount || 0
};
```

This bypasses hallucination detection but gets the chatbot working immediately.

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

## Phase 4: Frontend UI/UX (ENHANCED - Legal Chatbot Best Practices)

### Legal Chatbot UI/UX Best Practices Reference
Based on industry standards for legal technology interfaces:

1. **Trust Indicators** - Legal professionals need confidence in AI output
2. **Source Transparency** - Every claim must be traceable
3. **Professional Aesthetics** - Avoid informal/playful design
4. **Accessibility** - WCAG compliance for government/legal use
5. **Error Recovery** - Clear guidance when things go wrong
6. **Loading States** - Lawyers bill by the hour; show progress

---

### US-P4-001: Professional Legal UI
**As** a legal professional
**I want** a clean, professional interface
**So that** I can work efficiently

**Acceptance Criteria:**
- [x] Hebrew RTL layout
- [x] Dark header with title: "צ'אטבוט שמאות מכריעה"
- [x] Clean chat bubbles (user right, assistant left)
- [x] Typing indicator while loading
- [x] Error handling with Hebrew messages
- [x] Mobile responsive

---

### US-P4-002: Source Display Panel
**As** a user
**I want** sources displayed clearly
**So that** I can review and access original documents

**Acceptance Criteria:**
- [x] Collapsible sources section below each response
- [x] Each source shows:
  - Number badge [S0], [S1], etc.
  - Title (clickable → opens PDF)
  - Database label (color-coded)
  - Relevance percentage
  - Decision date
- [x] Sort by relevance (default) or date
- [x] "Open PDF" button for each source

---

### US-P4-003: Interactive Citations
**As** a user reading a response
**I want** citations to be interactive
**So that** I can quickly understand where information comes from

**Acceptance Criteria:**
- [x] [S#] tags are styled blue badges
- [x] Hover shows tooltip with:
  - Source title
  - Relevance score
  - "Click to expand" hint
- [x] Click highlights the source in the sources list
- [x] Multiple citations [S0][S1] group together
- [x] Animation: subtle highlight when hovering

---

### US-P4-004: Analytics Dashboard
**As** a researcher
**I want** to see visual analytics
**So that** I can understand data at a glance

**Acceptance Criteria:**
- [x] When response contains statistics, show chart
- [x] Chart types:
  - Bar chart for counts by category
  - Line chart for trends over time
  - Pie chart for distribution
- [x] Charts are interactive (hover for values)
- [x] Export chart as PNG option

---

### US-P4-005: Enhanced Error Handling (NEW)
**As** a user
**I want** clear error messages in Hebrew
**So that** I know what went wrong and how to recover

**Acceptance Criteria:**
- [x] Network errors show: "שגיאת חיבור - אנא בדוק את החיבור לאינטרנט"
- [x] Server errors (500) show: "שגיאה בשרת - אנא נסה שוב בעוד מספר שניות"
- [x] Empty response shows: "לא נמצאה תשובה - נסה לנסח את השאלה אחרת"
- [x] Timeout shows: "הבקשה ארכה זמן רב - אנא נסה שאלה קצרה יותר"
- [x] Retry button appears on error

**Implementation (add to frontend):**
```javascript
function showError(type) {
  const errors = {
    network: 'שגיאת חיבור - אנא בדוק את החיבור לאינטרנט',
    server: 'שגיאה בשרת - אנא נסה שוב בעוד מספר שניות',
    empty: 'לא נמצאה תשובה - נסה לנסח את השאלה אחרת',
    timeout: 'הבקשה ארכה זמן רב - אנא נסה שאלה קצרה יותר'
  };
  // Show error with retry button
}
```

---

### US-P4-006: Loading State Improvements (NEW)
**As** a user
**I want** to see progress while waiting
**So that** I know the system is working

**Acceptance Criteria:**
- [x] Animated typing indicator (3 dots)
- [x] Progress text changes every 3 seconds:
  1. "מעבד את השאלה..." (Processing question)
  2. "מחפש במאגר ההחלטות..." (Searching decisions)
  3. "מנתח את התוצאות..." (Analyzing results)
  4. "מכין תשובה מבוססת מקורות..." (Preparing sourced answer)
- [x] Subtle pulse animation on chat container
- [x] Estimated time indicator (optional)

---

### US-P4-007: Disclaimer Banner (CRITICAL for Legal)
**As** a legal platform
**I want** a clear disclaimer
**So that** users understand AI limitations

**Acceptance Criteria:**
- [x] Sticky banner at top (collapsible):
  ```
  ⚠️ הכלי מספק מידע לצורכי מחקר בלבד. אין להסתמך על התשובות כייעוץ משפטי.
  יש לאמת כל מידע מול המקורות המצוינים.
  ```
- [x] First-time popup explaining:
  - This is AI-assisted search
  - Always verify with original documents
  - Not legal advice
- [x] "הבנתי" (I understand) button to dismiss

---

### US-P4-008: Keyboard Shortcuts (NEW)
**As** a power user
**I want** keyboard shortcuts
**So that** I can work faster

**Acceptance Criteria:**
- [x] Enter → Send message
- [x] Shift+Enter → New line in message
- [x] Ctrl+K → Focus search input
- [x] Escape → Cancel loading / close modals
- [x] Arrow Up → Edit last message (optional)

---

### US-P4-009: Message History & Export (NEW)
**As** a researcher
**I want** to save my chat session
**So that** I can reference it later

**Acceptance Criteria:**
- [x] Local storage saves conversation
- [x] Export as PDF button
- [x] Export as plain text button
- [x] Clear history button with confirmation
- [x] Session persists across browser refresh

---

### US-P4-010: Mobile Responsive Fixes (NEW)
**As** a mobile user
**I want** the interface to work on my phone
**So that** I can research on the go

**Acceptance Criteria:**
- [x] Input stays at bottom on mobile
- [x] Source panel is collapsible on mobile
- [x] Touch-friendly button sizes (min 44x44px)
- [x] No horizontal scroll
- [x] Soft keyboard doesn't hide input

---

## Phase 5: Testing (TDD)

### US-P5-001: Unit Tests - Scraper
**As** a developer
**I want** scraper tests
**So that** parsing doesn't break

**Test Cases:**
- [x] `test_parse_decisive_appraiser_title()` - Hebrew title parsing
- [x] `test_parse_appeals_committee_title()` - Different format
- [x] `test_extract_block_plot()` - גוש/חלקה extraction
- [x] `test_extract_committee()` - ועדה name extraction
- [x] `test_handle_pagination()` - Multiple pages
- [x] `test_scraper_api_settings()` - ultra_premium, wait_for

---

### US-P5-002: Integration Tests - Pinecone
**As** a developer
**I want** Pinecone integration tests
**So that** vectors are stored correctly

**Test Cases:**
- [x] `test_upsert_single_document()` - Basic upsert
- [x] `test_upsert_with_metadata()` - All fields
- [x] `test_query_by_filter()` - committee filter
- [x] `test_query_semantic()` - Embedding similarity
- [x] `test_no_duplicates()` - contentHash check

---

### US-P5-003: E2E Tests - Chat Flow
**As** a developer
**I want** end-to-end chat tests
**So that** the full flow works

**Test Cases:**
- [x] `test_simple_query()` - "מה זה היטל השבחה?"
- [x] `test_specific_search()` - "החלטות בגוש 6158"
- [ ] `test_analytical_query()` - "כמה החלטות בתל אביב?"
- [ ] `test_citation_format()` - Response contains [S0]
- [ ] `test_hallucination_detection()` - Grounding badge present
- [ ] `test_error_handling()` - Invalid input graceful fail

---

## Implementation Order (Ralph Loop)

```
🚨 Phase 0: CRITICAL FIX (BLOCKING - DO THIS FIRST!)
  └─► US-CRITICAL-001: Fix Webhook Response Node Connection
  └─► US-CRITICAL-002: Simplified Fallback (if 001 fails)

Phase 1: Discovery (ALREADY DONE ✓)
  └─► US-P1-001: Analyze existing system [x]
  └─► US-P1-002: Data gap analysis [x]

Phase 2: Indexing (ALREADY DONE ✓)
  └─► US-P2-003: Pinecone schema [x]
  └─► US-P2-001: Full indexer workflow [x]
  └─► US-P2-002: PDF content extraction [x]

Phase 3: RAG Refinement (ALREADY DONE ✓)
  └─► US-P3-001: Query understanding [x]
  └─► US-P3-002: Source attribution [x]
  └─► US-P3-003: Analytical queries [x]
  └─► US-P3-004: Hallucination detection [x]

Phase 4: Frontend (EXISTING + NEW ITEMS)
  └─► US-P4-001: Professional UI [x]
  └─► US-P4-002: Source display [x]
  └─► US-P4-003: Interactive citations [x]
  └─► US-P4-004: Analytics dashboard [x]
  └─► US-P4-005: Enhanced Error Handling [x] NEW
  └─► US-P4-006: Loading State Improvements [x] NEW
  └─► US-P4-007: Disclaimer Banner [x] NEW - CRITICAL FOR LEGAL
  └─► US-P4-008: Keyboard Shortcuts [x] NEW
  └─► US-P4-009: Message History & Export [x] NEW
  └─► US-P4-010: Mobile Responsive Fixes [x] NEW

Phase 5: Testing
  └─► US-P5-001: Scraper tests [x]
  └─► US-P5-002: Pinecone tests (partial)
  └─► US-P5-003: E2E tests [ ]
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
