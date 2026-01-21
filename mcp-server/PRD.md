# PRD: Gov.il Decisive Appraiser MCP Server

## Overview

A focused MCP server for Claude Desktop that indexes and searches **only** the Israeli "Decisive Appraiser" (שמאי מכריע) database from gov.il. The server enables Claude to answer analytical queries in Hebrew by maintaining a local SQLite database of all decisions and their PDF content.

**Target Database:** https://www.gov.il/he/departments/dynamiccollectors/decisive_appraisal_decisions

**User:** Claude Desktop (via MCP protocol)

**ScraperAPI Key:** `566e1370a3f3158b969f898e102c7fd0`

---

## Technical Constraints (CRITICAL)

### ScraperAPI Requirements
Gov.il is a protected site that requires specific ScraperAPI settings:

```javascript
const params = {
  api_key: SCRAPER_API_KEY,
  url: targetUrl,
  render: 'true',           // JavaScript rendering required
  ultra_premium: 'true',    // REQUIRED - premium alone returns 500 errors
  wait_for: '5000'          // Wait 5 seconds for Angular to render content
};
```

### Decision Title Format
Decisions follow this Hebrew format:
```
הכרעת שמאי מכריע מיום DD-MM-YYYY בעניין [caseType] [party] נ ועדה מקומית [committee] ג [block] ח [plot] - [appraiser]
```

Example:
```
הכרעת שמאי מכריע מיום 15-01-2024 בעניין היטל השבחה נ ועדה מקומית תל אביב יפו ג 6158 ח 25 - כהן יוסף
```

### PDF URL Format
PDFs are accessed via the free-justice API (NO .pdf extension):
```
https://free-justice.openapi.gov.il/free/moj/portal/rest/searchpredefinedapi/v1/SearchPredefinedApi/Documents/DecisiveAppraiser/{docId}
```

### Node.js Compatibility
- Use `sql.js` (pure JavaScript SQLite) - NOT `better-sqlite3`
- better-sqlite3 native bindings fail on Node.js v24+
- sql.js works on all Node.js versions without compilation

---

## User Stories

### US-001: Index All Decisions (P0)
**As** Ralph Loop
**I want** to fetch and index all decisions from the decisive_appraiser database
**So that** the local database contains searchable data

**Acceptance Criteria:**
- [x] Scraper fetches pages from `?skip=0`, `?skip=10`, `?skip=20`, etc.
- [x] Uses ScraperAPI with `ultra_premium=true` and `wait_for=5000`
- [x] Parses Hebrew titles using regex patterns for the exact format
- [x] Extracts: title, url, block, plot, committee, appraiser, caseType, decisionDate
- [x] Stores decisions in SQLite with content_hash for deduplication
- [x] Saves progress to resume if interrupted
- [x] Handles pagination until no more results
- [x] Run via: `npm run index-all`

**Implementation Notes:**
```javascript
// Regex for decision titles
const TITLE_REGEX = /הכרעת שמאי מכריע מיום (\d{2}-\d{2}-\d{4}) בעניין ([^נ]+)נ ([^ג]+)ג (\d+) ח (\d+)\s*-?\s*(.+)?/;

// URL builder
function buildScraperUrl(targetUrl) {
  const params = new URLSearchParams({
    api_key: process.env.SCRAPER_API_KEY,
    url: targetUrl,
    render: 'true',
    ultra_premium: 'true',
    wait_for: '5000'
  });
  return `https://api.scraperapi.com?${params}`;
}
```

---

### US-002: Search Decisions (P0)
**As** Claude Desktop
**I want** to search decisions by various criteria
**So that** I can find relevant decisions for user queries

**Acceptance Criteria:**
- [x] MCP tool `search_decisions` with parameters:
  - `query`: Free text search (Hebrew)
  - `committee`: Filter by local committee name
  - `block`: Filter by block number (גוש)
  - `plot`: Filter by plot number (חלקה)
  - `appraiser`: Filter by appraiser name
  - `caseType`: Filter by case type (היטל השבחה, פיצויים, ירידת ערך)
  - `fromDate`, `toDate`: Date range filters
  - `limit`, `offset`: Pagination
- [x] Returns decisions with all metadata
- [x] Fast response (<100ms) from local SQLite

---

### US-003: Read PDF Content (P0)
**As** Claude Desktop
**I want** to read the full text of decision PDFs
**So that** I can answer detailed questions about specific cases

**Acceptance Criteria:**
- [x] MCP tool `read_pdf` with `id` parameter
- [x] Fetches PDF from free-justice API via ScraperAPI
- [x] Extracts Hebrew text using pdf-parse
- [x] Caches extracted text in database (`pdf_text` column)
- [x] Returns cached text on subsequent calls
- [x] Handles right-to-left Hebrew text properly

**Implementation Notes:**
```javascript
// PDF URL construction
const pdfUrl = `https://free-justice.openapi.gov.il/free/moj/portal/rest/searchpredefinedapi/v1/SearchPredefinedApi/Documents/DecisiveAppraiser/${docId}`;

// Fetch via ScraperAPI (same ultra_premium settings)
const scraperUrl = buildScraperUrl(pdfUrl);
```

---

### US-004: Get Statistics (P1)
**As** Claude Desktop
**I want** to get database statistics
**So that** I can answer questions like "how many decisions in Tel Aviv?"

**Acceptance Criteria:**
- [ ] MCP tool `get_statistics`
- [ ] Returns:
  - Total decision count
  - Breakdown by committee (top 20)
  - Breakdown by case type
  - Breakdown by year
  - Date range of indexed decisions
- [ ] Claude can answer: "כמה החלטות יש בתל אביב ב-2024?"

---

### US-005: List Committees (P1)
**As** Claude Desktop
**I want** to list all committees in the database
**So that** users can see which areas have decisions

**Acceptance Criteria:**
- [ ] MCP tool `list_committees`
- [ ] Returns all unique committee names with decision counts
- [ ] Sorted alphabetically

---

### US-006: Analytics Queries (P1)
**As** Claude Desktop
**I want** to answer analytical questions
**So that** users get useful insights

**Example Queries:**
- "מה ממוצע ההחלטות בתל אביב ב-2025?" (Average decisions in Tel Aviv 2025)
- "מי השמאי עם הכי הרבה החלטות?" (Appraiser with most decisions)
- "באילו ועדות יש הכי הרבה תיקי היטל השבחה?" (Committees with most betterment levy cases)

**Acceptance Criteria:**
- [ ] MCP tool `get_analytics` with `query_type` parameter:
  - `decisions_by_committee`: Count per committee
  - `decisions_by_year`: Count per year
  - `decisions_by_appraiser`: Count per appraiser
  - `decisions_by_case_type`: Count per case type
  - `avg_decisions_per_month`: Monthly average
- [ ] Returns structured data Claude can use to answer questions

---

### US-007: Incremental Updates (P2)
**As** the system
**I want** to check for new decisions daily
**So that** the database stays current

**Acceptance Criteria:**
- [ ] Script checks first 5 pages (50 decisions)
- [ ] Uses content_hash to detect new decisions
- [ ] Only inserts decisions not already in database
- [ ] Run via: `npm run daily-update`

---

## File Structure

```
mcp-server/
├── src/
│   ├── index.ts          # MCP server entry point
│   ├── database.ts       # SQLite operations (sql.js)
│   ├── scraper.ts        # ScraperAPI fetching
│   ├── parser.ts         # HTML parsing and title extraction
│   ├── pdf-extractor.ts  # PDF text extraction
│   └── types.ts          # TypeScript types
├── scripts/
│   ├── index-all.ts      # Full indexing script
│   └── daily-update.ts   # Incremental update script
├── data/
│   └── decisions.db      # SQLite database file
├── package.json
└── tsconfig.json
```

---

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT,
  block TEXT,
  plot TEXT,
  committee TEXT,
  appraiser TEXT,
  case_type TEXT,
  decision_date TEXT,
  publish_date TEXT,
  content_hash TEXT NOT NULL UNIQUE,
  pdf_text TEXT,
  indexed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_committee ON decisions(committee);
CREATE INDEX idx_block_plot ON decisions(block, plot);
CREATE INDEX idx_appraiser ON decisions(appraiser);
CREATE INDEX idx_case_type ON decisions(case_type);
CREATE INDEX idx_decision_date ON decisions(decision_date);

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
```

---

## Claude Desktop Configuration

Add to `~/.config/Claude/claude_desktop_config.json` (Mac/Linux) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "gov-il-land-appraisal": {
      "command": "npx",
      "args": ["tsx", "C:/Users/user/automation-shamai/mcp-server/src/index.ts"],
      "env": {
        "SCRAPER_API_KEY": "566e1370a3f3158b969f898e102c7fd0"
      }
    }
  }
}
```

---

## MCP Tools Summary

| Tool | Description | Parameters |
|------|-------------|------------|
| `search_decisions` | Search decisions by criteria | query, committee, block, plot, appraiser, caseType, fromDate, toDate, limit, offset |
| `get_decision` | Get single decision by ID | id |
| `read_pdf` | Extract PDF text content | id, maxPages |
| `get_statistics` | Get database statistics | none |
| `list_committees` | List all committees | limit |
| `list_appraisers` | List all appraisers | limit |
| `get_analytics` | Run analytical queries | query_type |
| `health_check` | Verify server health | verbose |
| `trigger_update` | Manual incremental update | pagesToCheck |

---

## Testing Checklist

After Ralph Loop completes implementation:

1. **Database Population Test**
   ```bash
   npm run index-all
   # Should index 10,000+ decisions over ~1-2 hours
   ```

2. **MCP Server Startup Test**
   ```bash
   npx tsx src/index.ts
   # Should start without errors, logs to stderr
   ```

3. **Claude Desktop Integration Test**
   - Restart Claude Desktop after config change
   - Ask: "כמה החלטות שמאי מכריע יש במאגר?"
   - Should respond with statistics

4. **Search Test**
   - Ask: "מצא החלטות בתל אביב מ-2024"
   - Should return relevant decisions with titles

5. **PDF Reading Test**
   - After search, ask: "קרא את ההחלטה הראשונה"
   - Should extract and show Hebrew PDF content

---

## Success Metrics

- [ ] Database contains 10,000+ indexed decisions
- [ ] Search returns results in <100ms
- [ ] PDF text extraction works for Hebrew content
- [ ] Claude Desktop can answer: "מה ממוצע ההחלטות בתל אביב?"
- [ ] Health check returns `healthy: true`

---

## Implementation Order (for Ralph Loop)

1. **US-001**: Index all decisions - creates the foundation
2. **US-002**: Search decisions - enables basic querying
3. **US-003**: Read PDF content - enables detailed analysis
4. **US-004**: Get statistics - enables analytical queries
5. **US-005**: List committees - helper for search
6. **US-006**: Analytics queries - enables complex questions
7. **US-007**: Incremental updates - keeps data fresh

---

*PRD Version: 2.0 - Focused on decisive_appraiser only*
*Last Updated: 2026-01-21*
