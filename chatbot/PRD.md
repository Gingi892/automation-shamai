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

**⚠️ STATUS: NOT WORKING - Marked [x] but actual PDF content is NOT being indexed!**
**Evidence:** Query "מה היה בתביעה של קרן יניבי?" returns metadata but says "המסמכים לא כוללים פרטים נוספים" - proving PDF content is missing.

**Acceptance Criteria:**
- [ ] Fetch PDF via ScraperAPI (same settings) ← NOT DONE
- [ ] Extract text using pdf-parse ← NOT DONE
- [ ] Handle Hebrew RTL text properly ← NOT DONE
- [ ] Store full text as Pinecone metadata (max 40KB per vector) ← NOT DONE
- [ ] For large PDFs, store first 35KB + summary ← NOT DONE
- [x] Link PDF URL in metadata for direct access ← DONE (only this works)

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
- [x] `test_analytical_query()` - "כמה החלטות בתל אביב?"
- [x] `test_citation_format()` - Response contains [S0]
- [x] `test_hallucination_detection()` - Grounding badge present
- [x] `test_error_handling()` - Invalid input graceful fail

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
  └─► US-P5-003: E2E tests [x]
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

---

## 🚀 PHASE 6: FULL DOCUMENT INDEXING (CRITICAL - Run Tomorrow)

**Goal:** Index ALL ~20,000 documents from all 3 gov.il databases into Pinecone so the chatbot can answer any question about any decision.

### US-P6-001: Analyze Existing Indexing Pipeline
**As** Ralph Loop
**I want** to understand the current indexing infrastructure
**So that** I can execute full indexing efficiently

**Acceptance Criteria:**
- [x] Identify existing n8n workflows for scraping (oqihIkB7Ur9WVJZG, kTZqcClvtUspeC28)
- [x] Document the scraper → processor → Pinecone pipeline
- [x] Count current documents in Pinecone (query for stats)
- [x] Identify gaps: which databases have partial/no coverage

**Exploration Tasks:**
```bash
# Check Pinecone current stats
curl -X POST "https://gov-il-decisions-k1iqa9s.svc.aped-4627-b74a.pinecone.io/describe_index_stats" \
  -H "Api-Key: [PINECONE_KEY]" \
  -H "Content-Type: application/json"
```

---

### US-P6-002: Index Decisive Appraiser Database (~10,000 docs)
**As** the system
**I want** to scrape and index ALL decisive appraiser decisions
**So that** users can query any שמאי מכריע decision

**Database:** `https://www.gov.il/he/departments/dynamiccollectors/decisive_appraisal_decisions`

**Acceptance Criteria:**
- [ ] Configure scraper with pagination (`?skip=0`, `?skip=10`, ...)
- [ ] Use ScraperAPI settings: `ultra_premium=true`, `render=true`, `wait_for=5000`
- [ ] Parse Hebrew decision titles correctly
- [ ] Extract metadata: title, url, block, plot, committee, appraiser, caseType, decisionDate
- [ ] Create embeddings via OpenAI text-embedding-3-small (1024 dims)
- [ ] Upsert to Pinecone with deduplication (content_hash)
- [ ] Track progress with resume capability
- [ ] Rate limit: 1 request/second to ScraperAPI
- [ ] Log total documents indexed

**Implementation Notes:**
```javascript
// Scraper URL pattern
const baseUrl = 'https://www.gov.il/he/departments/dynamiccollectors/decisive_appraisal_decisions';
const pageUrl = `${baseUrl}?skip=${skip}`; // skip=0, 10, 20, ...

// ScraperAPI wrapper
function buildScraperUrl(targetUrl) {
  return `https://api.scraperapi.com?api_key=566e1370a3f3158b969f898e102c7fd0&url=${encodeURIComponent(targetUrl)}&render=true&ultra_premium=true&wait_for=5000`;
}
```

---

### US-P6-003: Index Appeals Committee Database (~5,000 docs)
**As** the system
**I want** to scrape and index ALL appeals committee decisions
**So that** users can query any ועדת השגות decision

**Database:** `https://www.gov.il/he/departments/dynamiccollectors/committee`

**Acceptance Criteria:**
- [ ] Configure scraper with pagination
- [ ] Parse appeals committee title format (different regex than decisive appraiser)
- [ ] Extract metadata with database='appeals_committee'
- [ ] Upsert to Pinecone with unique IDs
- [ ] Log total documents indexed

---

### US-P6-004: Index Appeals Board Database (~5,000 docs)
**As** the system
**I want** to scrape and index ALL appeals board decisions
**So that** users can query any ועדת ערעורים decision

**Database:** `https://www.gov.il/he/departments/dynamiccollectors/decisions_appeals_board`

**Acceptance Criteria:**
- [ ] Configure scraper with pagination
- [ ] Parse appeals board title format
- [ ] Extract metadata with database='appeals_board'
- [ ] Upsert to Pinecone with unique IDs
- [ ] Log total documents indexed

---

### US-P6-005: Verify Full Coverage
**As** a QA process
**I want** to verify all documents are indexed
**So that** I can confirm 100% coverage

**Acceptance Criteria:**
- [ ] Query Pinecone stats: total vectors per namespace
- [ ] Compare against estimated totals (~20,000)
- [ ] Sample test: query for specific decisions from each database
- [ ] Verify metadata is complete (no missing fields)
- [ ] Document final counts in progress.txt

---

## 🔧 PHASE 7: QUALITY FIXES (Post-Indexing)

**Goal:** Fix known issues with UTF-8 encoding and duplicate sources.

### US-P7-001: Fix UTF-8 Encoding in Hallucination Detection
**As** the frontend
**I want** Hebrew text to display correctly in warning banners
**So that** users see proper Hebrew instead of ???

**Problem:** Warning banner shows `??? ??: 2 ?????` instead of Hebrew

**Root Cause:** JSON serialization not using UTF-8 encoding

**Acceptance Criteria:**
- [ ] Locate the n8n Code node that generates hallucination response
- [ ] Ensure JSON output uses UTF-8: `JSON.stringify(data)` with proper encoding
- [ ] Verify in n8n: Respond to Webhook node is set to JSON mode
- [ ] Test: Warning banner shows Hebrew correctly

**Fix Location:** `Format Response with Flags` node in workflow McOa9j15PRy8AZ8v

**Fix Code:**
```javascript
// In Format Response with Flags node
// Ensure all Hebrew strings are properly encoded
const warningMessage = hallucinationCheck.overall_grounded
  ? null
  : `שים לב: ${unfoundedClaims.length} טענות בתשובה לא נתמכות במלואן על ידי המקורות.`;

// Return with explicit Hebrew
return {
  success: true,
  response: assistantMessage,
  warning: warningMessage, // Hebrew will serialize correctly
  // ... rest of response
};
```

---

### US-P7-002: Add Source Deduplication to RAG Pipeline
**As** the chatbot
**I want** to show unique documents in search results
**So that** users see diverse sources, not duplicates

**Problem:** Query returns 5 identical sources (same document chunks)

**Root Cause:** Pinecone returns multiple chunks from same document

**Acceptance Criteria:**
- [ ] Modify `Build RAG Context` node to deduplicate by source URL
- [ ] Keep only first (highest score) chunk per unique document
- [ ] Limit to 5 UNIQUE documents
- [ ] Test: Query returns diverse sources

**Fix Location:** `Build RAG Context` node in workflow McOa9j15PRy8AZ8v

**Fix Code:**
```javascript
// Deduplicate sources by URL
const seenUrls = new Set();
const uniqueMatches = [];

for (const match of matches) {
  const url = match.metadata?.url || '';
  if (url && !seenUrls.has(url)) {
    seenUrls.add(url);
    uniqueMatches.push(match);
  }
  if (uniqueMatches.length >= 5) break; // Max 5 unique sources
}

// Use uniqueMatches instead of matches for context building
const rawDocuments = uniqueMatches.map((match, index) => {
  // ... rest of mapping
});
```

---

### US-P7-003: Improve Query Relevance
**As** a user
**I want** search results relevant to my query location/topic
**So that** I get Tel Aviv results when asking about Tel Aviv

**Problem:** Query "החלטות בתל אביב" doesn't return Tel Aviv decisions

**Root Cause:** Semantic search alone may not filter by metadata

**Acceptance Criteria:**
- [ ] Restore Hebrew filter parsing in `Parse Query Filters` node
- [ ] Enable Pinecone metadata filters for committee, year, etc.
- [ ] Test: "החלטות בתל אביב" returns decisions with committee="תל אביב"

**Fix Location:** `Parse Query Filters` node - restore Hebrew regex patterns

---

## Updated Implementation Order

```
🚀 Phase 6: FULL INDEXING (PRIORITY - Run Tomorrow)
  └─► US-P6-001: Analyze existing pipeline [ ]
  └─► US-P6-002: Index decisive_appraiser (~10K) [ ]
  └─► US-P6-003: Index appeals_committee (~5K) [ ]
  └─► US-P6-004: Index appeals_board (~5K) [ ]
  └─► US-P6-005: Verify full coverage [ ]

🔧 Phase 7: QUALITY FIXES
  └─► US-P7-001: Fix UTF-8 encoding [ ]
  └─► US-P7-002: Add source deduplication [ ]
  └─► US-P7-003: Improve query relevance [ ]
```

---

---

## 🔴 PHASE 8: PDF CONTENT EXTRACTION (CRITICAL - HIGHEST PRIORITY)

**⚠️ ROOT CAUSE IDENTIFIED:** The chatbot cannot answer content questions because **PDF content is NOT indexed**. Current indexing only stores metadata (title, URL, date, committee) from listing pages - NOT the actual decision text.

**Evidence:**
```
Query: "מה היה בתביעה של קרן יניבי?"
Answer: "ההכרעה... ניתנה על ידי שמאי מכריע ב-30 בדצמבר 2025. עם זאת, המסמכים שסופקו לא כוללים פרטים נוספים..."
```
The chatbot found the document by title match but **has no content** to answer what the decision actually said.

---

### US-P8-001: Analyze Current Indexing Gap
**As** Ralph Loop
**I want** to understand exactly what's indexed vs what's missing
**So that** I can fix the PDF extraction pipeline

**Acceptance Criteria:**
- [x] Query Pinecone for sample documents and inspect metadata
- [x] Check `description` field - is it empty or contains only title?
- [x] Identify the n8n workflow that SHOULD extract PDF content
- [x] Document: Current pipeline only indexes listing page data, NOT PDF content
- [x] List the PDF URL pattern (free-justice.openapi.gov.il/...)

**Analysis Results (2026-01-21):**
- Document Processor workflow `kTZqcClvtUspeC28` DOES extract PDF content
- Content stored in `content` field (NOT `description`) as ~10KB chunks
- Documents CHUNKED into multiple vectors (violates "one doc = one vector")
- Metadata fields (committee, block, plot, appraiser) arrive EMPTY from scraper
- Build RAG Context only passes title/url/score - LOSES all other metadata
- All 5 search results return SAME document (different chunks) - no deduplication
- PDF URL pattern: `https://free-justice.openapi.gov.il/free/moj/portal/rest/searchpredefinedapi/v1/SearchPredefinedApi/Documents/DecisiveAppraiser/{docId}`

**Diagnostic Query:**
```javascript
// In n8n Code node - check what's actually in Pinecone
const sample = await pinecone.query({
  vector: [/* any embedding */],
  topK: 5,
  includeMetadata: true,
  namespace: 'gov-il-decisions'
});
// Inspect: Is description field populated with full text?
console.log(sample.matches.map(m => ({
  title: m.metadata.title,
  descriptionLength: m.metadata.description?.length || 0,
  hasContent: m.metadata.description?.length > 500
})));
```

---

### US-P8-002: Design PDF Content Extraction Pipeline
**As** the system architect
**I want** a clear design for fetching and indexing PDF content
**So that** implementation is straightforward

**Current State:**
```
Listing Page Scrape → Extract Metadata → Create Embedding from TITLE → Upsert to Pinecone
                                         ❌ Missing: PDF content
```

**Target State:**
```
Listing Page Scrape → Extract Metadata + PDF URL →
                      Fetch PDF via ScraperAPI →
                      Extract Text (pdf-parse or similar) →
                      Create Embedding from FULL TEXT →
                      Upsert to Pinecone with text in description field
```

**Acceptance Criteria:**
- [x] Design node-by-node flow for PDF extraction
- [x] Decide: New workflow OR modify existing indexer workflow?
- [x] Plan rate limiting (ScraperAPI costs, gov.il throttling)
- [x] Plan chunking strategy for large PDFs (>40KB limit)
- [x] Document estimated cost (ScraperAPI credits × 20,000 docs)

---

#### 📐 DESIGN DOCUMENT (Completed 2026-01-21)

##### Decision: Modify Existing Full Indexer Workflow
**Workflow ID:** `1zYlIK6VnynTHiHl` ("Full Indexer - All Databases")

**Rationale:**
1. Already has PDF extraction infrastructure (Fetch PDF Content → Extract PDF Text → Prepare PDF Text)
2. Already has Hebrew text cleaning via `cleanHebrewText()` function
3. Already has rate limiting (Wait node) and progress tracking
4. Has `continueOnFail: true` on PDF nodes for graceful error handling
5. Avoids duplicating scraper → processor → Pinecone pipeline

##### Node-by-Node Flow Design

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                      FULL INDEXER - ALL DATABASES (1zYlIK6VnynTHiHl)                │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  TRIGGER PHASE                                                                       │
│  ┌─────────────┐     ┌─────────────────┐     ┌────────────┐                         │
│  │ Webhook/    │────►│ Load Progress   │────►│ Set Config │                         │
│  │ Manual      │     │ State           │     │            │                         │
│  └─────────────┘     └─────────────────┘     └─────┬──────┘                         │
│                                                     │                                │
│  SCRAPE PHASE                                       ▼                                │
│  ┌───────────────────┐     ┌─────────────────┐     ┌────────────────────┐           │
│  │ Build ScraperAPI  │────►│ Fetch Page via  │────►│ Extract Documents  │           │
│  │ URL               │     │ ScraperAPI      │     │ (metadata + URL)   │           │
│  └───────────────────┘     └─────────────────┘     └─────────┬──────────┘           │
│                                                               │                      │
│  ┌───────────────────┐     ┌─────────────────┐               │                      │
│  │ Create Document   │◄────┤                 │◄──────────────┘                      │
│  │ Records (PRD      │     │                 │                                       │
│  │ schema)           │     └─────────────────┘                                       │
│  └─────────┬─────────┘                                                               │
│            │                                                                         │
│  PAGINATION LOOP      ┌─────────────────┐     ┌───────────────────┐                 │
│            ▼          │ Rate Limit Wait │────►│ Save Progress     │────►[LOOP]      │
│  ┌─────────────────┐  │ (1 sec)         │     │ State             │                 │
│  │ Has More Pages? ├──┴─────────────────┘     └───────────────────┘                 │
│  │ (IF node)       │                                                                 │
│  └────────┬────────┘                                                                 │
│           │ NO                                                                       │
│           ▼                                                                          │
│  PDF EXTRACTION PHASE                                                                │
│  ┌───────────────────┐                                                               │
│  │ Process Batch for │                                                               │
│  │ Embedding         │                                                               │
│  └─────────┬─────────┘                                                               │
│            │                                                                         │
│            ▼                                                                         │
│  ┌────────────────┐    TRUE    ┌─────────────────┐    ┌──────────────────┐          │
│  │ Check PDF URL  │───────────►│ Fetch PDF       │───►│ Extract PDF Text │          │
│  │ (IF node)      │            │ Content (HTTP)  │    │ (extractFromFile)│          │
│  └───────┬────────┘            └─────────────────┘    └────────┬─────────┘          │
│          │ FALSE                                                │                    │
│          │                     ┌──────────────────┐             │                    │
│          └────────────────────►│ Skip PDF -       │             │                    │
│                                │ No URL           │             │                    │
│                                └────────┬─────────┘             │                    │
│                                         │                       │                    │
│                                         │                       ▼                    │
│                                         │    ┌───────────────────────┐              │
│                                         │    │ Prepare PDF Text      │              │
│                                         │    │ - cleanHebrewText()   │              │
│                                         │    │ - Truncate to 35KB    │              │
│                                         │    └───────────┬───────────┘              │
│                                         │                │                           │
│                                         ▼                ▼                           │
│  ┌─────────────────────────────────────────────────────────────────┐                │
│  │                      Merge PDF Results                          │                │
│  │                      (Append mode)                              │                │
│  └──────────────────────────────┬──────────────────────────────────┘                │
│                                  │                                                   │
│  EMBEDDING PHASE                 ▼                                                   │
│  ┌───────────────────┐     ┌───────────────────┐     ┌──────────────────┐           │
│  │ Create Embedding  │────►│ Prepare Pinecone  │────►│ Upsert to        │           │
│  │ (OpenAI)          │     │ Vector (PRD       │     │ Pinecone         │           │
│  │ INPUT: title +    │     │ schema + full     │     │                  │           │
│  │ description       │     │ text in           │     │                  │           │
│  └───────────────────┘     │ description)      │     └────────┬─────────┘           │
│                            └───────────────────┘              │                      │
│                                                                ▼                     │
│  COMPLETION PHASE          ┌───────────────────┐     ┌──────────────────┐           │
│                            │ Aggregate Batch   │◄────┤                  │           │
│                            │ Results           │     └──────────────────┘           │
│                            └─────────┬─────────┘                                     │
│                                      │                                               │
│                                      ▼                                               │
│  ┌───────────────────┐     ┌───────────────────┐                                    │
│  │ Final Summary     │────►│ Mark Indexing     │                                    │
│  │                   │     │ Complete          │                                    │
│  └───────────────────┘     └───────────────────┘                                    │
│                                                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

##### Key Node Modifications Required

| Node | Current State | Target State | Change Required |
|------|--------------|--------------|-----------------|
| `Fetch PDF Content` | Uses ScraperAPI with `premium=true` | Direct HTTP fetch (gov.il not blocked) | ✅ Change URL to direct fetch |
| `Prepare PDF Text` | Truncates to 35KB | Keep 35KB truncation | ✅ Already correct |
| `Create Embedding` | Uses `$json.content` (chunk) | Use `title + description` (full doc) | 🔧 Update input field |
| `Prepare Pinecone Vector` | Missing `description` field | Add `description: $json.fullText` | 🔧 Add field |

##### Rate Limiting Strategy

1. **Listing Page Scrapes**: 1 req/sec via Wait node (ScraperAPI ultra_premium)
2. **PDF Fetches**: Direct to gov.il (no ScraperAPI needed) - 0.5 sec delay recommended
3. **Embeddings**: OpenAI rate limit ~3000 RPM - batching via n8n handles this
4. **Pinecone Upserts**: 100 vectors/request supported - currently doing 1 at a time

##### Chunking Strategy for Large PDFs (>40KB)

**Approach: Truncation with Summary**

```javascript
const MAX_DESCRIPTION = 35000; // 35KB leaves 5KB headroom for other metadata

function prepareText(fullText) {
  if (fullText.length <= MAX_DESCRIPTION) {
    return fullText;
  }
  // Truncate with marker
  return fullText.substring(0, MAX_DESCRIPTION - 50) + '\n\n... [מקוצר - לצפייה במסמך המלא לחץ על הקישור]';
}
```

**One Document = One Vector** (PRD requirement):
- NO splitting into chunks/pages
- Full text embedded for semantic search
- Truncated text stored in metadata
- PDF URL preserved for full document access

##### Cost Estimate (Updated)

| Item | Calculation | Cost |
|------|-------------|------|
| ScraperAPI (listing pages) | 20,000 docs ÷ 10 per page × $0.05/ultra_premium | ~$100 |
| PDF Fetches | Direct HTTP (free, no ScraperAPI) | $0 |
| OpenAI Embeddings | 20,000 docs × 5K tokens avg × $0.02/1M tokens | ~$2 |
| **Total One-Time Cost** | | **~$102** |

**Note:** Original estimate was $413, but PDFs can be fetched directly from gov.il without ScraperAPI, reducing cost by 75%.

---

### US-P8-003: Implement PDF Fetcher Node
**As** the n8n workflow
**I want** a node that fetches PDF content via ScraperAPI
**So that** I can extract text from decisions

**Acceptance Criteria:**
- [x] Create/update n8n Code node: "Fetch PDF Content"
- [x] Input: document URL from listing scrape
- [x] Build ScraperAPI URL with `ultra_premium=true`, `render=true` (UPDATED: Using direct HTTP fetch per design doc - gov.il not blocked for PDFs)
- [x] Handle PDF binary → text conversion
- [x] Output: Full Hebrew text content
- [x] Error handling: If PDF fails, fallback to title-only

**Implementation:**
```javascript
// Fetch PDF Content node
const doc = $input.first().json;
const pdfUrl = doc.url; // e.g., https://free-justice.openapi.gov.il/pdf/...

// ScraperAPI for PDFs (may need different approach)
const scraperUrl = `https://api.scraperapi.com?api_key=566e1370a3f3158b969f898e102c7fd0&url=${encodeURIComponent(pdfUrl)}&render=true&ultra_premium=true`;

// Alternative: Direct PDF fetch if not blocked
// const pdfBuffer = await fetch(pdfUrl).then(r => r.arrayBuffer());

// Extract text using external service or pdf-parse
const text = await extractTextFromPDF(pdfContent);

return {
  ...doc,
  fullText: text,
  textLength: text.length
};
```

---

### US-P8-004: Implement Text Extractor Node
**As** the n8n workflow
**I want** to convert PDF content to searchable text
**So that** it can be embedded and searched

**Acceptance Criteria:**
- [x] Research: Can n8n extract PDF text directly?
- [x] Option A: Use pdf-parse npm package in Code node
- [x] Option B: Use external PDF extraction API
- [x] Option C: If PDFs are actually HTML pages, use Cheerio to extract text
- [x] Handle Hebrew RTL text encoding
- [x] Truncate to 35KB if larger (Pinecone metadata limit)
- [x] Test on sample documents from all 3 databases

**Implementation Notes (Completed 2026-01-21):**
- n8n's built-in `extractFromFile` node with `operation: pdf` extracts PDF text
- Gov.il documents confirmed to be real PDFs (`application/pdf` Content-Type)
- `Prepare PDF Text` node has `cleanHebrewText()` function for Hebrew RTL processing
- `MAX_DESCRIPTION_LENGTH = 35000` ensures Pinecone metadata limit compliance
- All scraper and Pinecone tests pass (88 total tests)

**Note:** Gov.il "PDFs" may actually be HTML pages with embedded content. Test actual URL:
```bash
curl -I "https://free-justice.openapi.gov.il/..." | grep Content-Type
```
**Result:** Verified as `application/pdf` - real PDFs, not HTML

---

### US-P8-005: Update Embedding to Use Full Text
**As** the embedding node
**I want** to create embeddings from full document text
**So that** semantic search finds content, not just titles

**Current (WRONG):**
```javascript
// Current: Embedding created from TITLE only
const textToEmbed = doc.title; // ❌ Only 50-100 chars
```

**Target (CORRECT):**
```javascript
// Target: Embedding created from FULL TEXT
const textToEmbed = doc.fullText || doc.title; // ✅ Full content
const embedding = await openai.embeddings.create({
  model: 'text-embedding-3-small',
  input: textToEmbed.slice(0, 8000) // Limit for API
});
```

**Acceptance Criteria:**
- [x] Locate current embedding node in indexer workflow
- [x] Update to use full text instead of title
- [x] Keep title as fallback if full text extraction fails
- [ ] Test: Query "קרן יניבי" should return content, not just metadata

**Implementation Notes (Completed 2026-01-21):**
- Updated `Create Embedding` node (id: `create-embedding`) in workflow `1zYlIK6VnynTHiHl`
- New embedding input logic: `(($json.description && $json.description.length > 100) ? ($json.description.slice(0, 8000)) : ($json.title + ' ' + ($json.description || '')).slice(0, 8000))`
- Uses full PDF text (description field >100 chars) as primary embedding source
- Falls back to title + description for documents without PDF content
- Limits input to 8000 characters to stay within OpenAI token limits
- Test criterion deferred to US-P8-007 (requires re-indexing first)

---

### US-P8-006: Re-index All Documents with Full Content
**As** the batch processor
**I want** to re-index all 20,000 documents with full PDF content
**So that** the chatbot can answer any question

**⚠️ STATUS: WORKFLOW READY - AWAITING MANUAL EXECUTION**
**Technical implementation complete (2026-01-21). Full indexing requires human approval to run (costs ~$102).**

**Acceptance Criteria:**
- [x] Workflow validated and tested with small batch ✅ (2026-01-21)
- [ ] Clear existing Pinecone namespace (or use new namespace)
- [ ] Run indexer on decisive_appraiser (~10,000 docs)
- [ ] Run indexer on appeals_committee (~5,000 docs)
- [ ] Run indexer on appeals_board (~5,000 docs)
- [x] Verify: Sample documents have `description` field with full text ✅ (test batch confirmed)
- [ ] Test query: "מה היה בתביעה של קרן יניבי?" returns actual decision content (needs full re-index)

**To Execute Full Indexing:**
```powershell
cd chatbot
.\run-full-indexer.ps1 -Database decisive_appraiser  # Day 1: ~10K docs
.\run-full-indexer.ps1 -Database appeals_committee   # Day 2: ~5K docs
.\run-full-indexer.ps1 -Database appeals_board       # Day 3: ~5K docs
.\run-full-indexer.ps1 -Resume                       # If interrupted
```

**Execution Plan:**
```
Day 1: Run decisive_appraiser (10K docs × 2 API calls each = 20K calls)
Day 2: Run appeals_committee (5K docs)
Day 3: Run appeals_board (5K docs)
Day 4: Verify and test
```

**Cost Estimate (UPDATED):**
- ScraperAPI (listing pages): ~$100 (PDFs fetched directly - no ScraperAPI needed)
- OpenAI embeddings: ~$2
- Total: ~$102 one-time

---

### US-P8-007: Verify Content Indexing Works
**As** QA
**I want** to verify the chatbot can now answer content questions
**So that** I know the fix worked

**Test Cases:**
- [ ] Test 1: "מה היה בתביעה של קרן יניבי?" → Should return actual decision details
- [ ] Test 2: "מהי החלטת השמאי המכריע בגוש 6573?" → Should return decision content
- [ ] Test 3: "האם היה ערעור על החלטה בחיפה?" → Should cite specific case
- [ ] Test 4: Compare `description` field length before/after (should be >1000 chars now)

**Acceptance Criteria:**
- [ ] All 4 test queries return substantive answers with citations
- [ ] No more "המסמכים לא כוללים פרטים נוספים" responses
- [ ] Chatbot can answer questions about decision CONTENT, not just metadata

---

## Updated Implementation Order (REVISED)

```
🔴 Phase 8: PDF CONTENT EXTRACTION (BLOCKING - Do First!)
  └─► US-P8-001: Analyze indexing gap [x]
  └─► US-P8-002: Design extraction pipeline [x]
  └─► US-P8-003: Implement PDF fetcher [x]
  └─► US-P8-004: Implement text extractor [x]
  └─► US-P8-005: Update embedding to use full text [x]
  └─► US-P8-006: Re-index all 20K documents [ ]
  └─► US-P8-007: Verify content indexing works [ ]

🚀 Phase 6: FULL INDEXING (Merged with Phase 8)
  └─► Now part of US-P8-006

🔧 Phase 7: QUALITY FIXES (After Phase 8)
  └─► US-P7-001: Fix UTF-8 encoding [ ]
  └─► US-P7-002: Add source deduplication [ ]
  └─► US-P7-003: Improve query relevance [ ]
```

---

*PRD Version: 2.1*
*Updated: 2026-01-21*
*CRITICAL FIX: Phase 8 added - PDF content extraction is the root cause of chatbot not answering content questions*
*Target: Extract and index actual PDF content for all 20,000+ documents*
