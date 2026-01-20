# Gov.il Land Appraisal MCP Server

MCP (Model Context Protocol) server for accessing Israeli land appraisal decisions from gov.il with full database support.

## Overview

This MCP server provides access to **20,000+ decisions** from three government databases:

- **שמאי מכריע** (Decisive Appraiser) - ~10,000+ decisions
- **ועדת השגות** (Appeals Committee) - ~5,000+ decisions
- **ועדת ערעורים** (Appeals Board) - ~5,000+ decisions

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        MCP Server                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────┐    │
│  │   SQLite    │    │   ChromaDB   │    │   Scraper       │    │
│  │  Metadata   │    │   Vectors    │    │   (ScraperAPI)  │    │
│  │  + FTS5     │    │   Embeddings │    │                 │    │
│  └──────┬──────┘    └──────┬───────┘    └────────┬────────┘    │
│         │                  │                      │             │
│         └──────────────────┼──────────────────────┘             │
│                            │                                     │
│                    ┌───────┴───────┐                            │
│                    │  MCP Tools    │                            │
│                    │  - search     │                            │
│                    │  - get_pdf    │                            │
│                    │  - compare    │                            │
│                    │  - semantic   │                            │
│                    └───────────────┘                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

```bash
cd mcp-server
npm install
npm run build
```

## Initial Indexing

Before using the server, you need to populate the database:

```bash
# Set your ScraperAPI key
export SCRAPER_API_KEY=your_api_key_here

# Run full index (takes ~3 hours)
npm run index-all

# Or with options
npx tsx scripts/index-all.ts --max-pages=100 --delay=2000
```

## Usage

### As MCP Server

Add to your Claude configuration:

```json
{
  "mcpServers": {
    "gov-il-land-appraisal": {
      "command": "node",
      "args": ["path/to/mcp-server/dist/index.js"],
      "env": {
        "SCRAPER_API_KEY": "optional_for_updates"
      }
    }
  }
}
```

### Available Tools

| Tool | Description |
|------|-------------|
| `search_decisions` | Search by committee, block/plot, appraiser, date, etc. |
| `get_decision` | Get full details of a specific decision |
| `get_decision_pdf` | Get the PDF URL for a decision |
| `get_statistics` | Get database statistics |
| `list_committees` | List all local committees |
| `list_appraisers` | List all appraisers |
| `compare_decisions` | Compare multiple decisions |
| `semantic_search` | AI-powered semantic search |
| `trigger_update` | Fetch new decisions from gov.il |

### Example Searches

```
# Search by committee
search_decisions(committee="עפולה")

# Search by block and plot
search_decisions(block="1234", plot="56")

# Search by appraiser
search_decisions(appraiser="כהן")

# Semantic search
semantic_search(query="פיצויים על הפקעת קרקע בתל אביב")

# Full-text search
search_decisions(query="היטל השבחה תמא 38")
```

## Daily Updates

Run daily to fetch new decisions:

```bash
# Via npm script
SCRAPER_API_KEY=xxx npm run daily-update

# Or directly
SCRAPER_API_KEY=xxx npx tsx scripts/daily-update.ts --pages=5
```

### Cron Setup

```bash
# Add to crontab for daily 6 AM updates
0 6 * * * cd /path/to/mcp-server && SCRAPER_API_KEY=xxx npx tsx scripts/daily-update.ts >> /var/log/govil-update.log 2>&1
```

## Database Schema

```sql
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  database TEXT NOT NULL,        -- decisive_appraiser, appeals_committee, appeals_board
  title TEXT NOT NULL,
  url TEXT,                      -- PDF URL
  block TEXT,                    -- גוש
  plot TEXT,                     -- חלקה
  committee TEXT,                -- ועדה מקומית
  appraiser TEXT,                -- שם השמאי
  case_type TEXT,                -- היטל השבחה, פיצויים, etc.
  decision_date TEXT,
  publish_date TEXT,
  content_hash TEXT,             -- For change detection
  indexed_at TIMESTAMP
);
```

## Performance

| Operation | Before (Scraping) | After (SQLite) |
|-----------|------------------|----------------|
| Search | 20-30s | <100ms |
| Results | ~20 | 20,000+ |
| API Calls | Per search | 0 (cached) |

## Dependencies

- `@modelcontextprotocol/sdk` - MCP server framework
- `better-sqlite3` - SQLite with FTS5 for Hebrew full-text search
- `chromadb` - Vector database for semantic search
- `cheerio` - HTML parsing
- ScraperAPI account (for indexing)

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SCRAPER_API_KEY` | ScraperAPI key for fetching from gov.il | For indexing/updates |

## License

MIT
