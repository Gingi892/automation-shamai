# Gov.il Land Appraisal MCP Server - LIVE

Real-time MCP server for searching Israeli land appraisal decisions with **PDF content extraction**.

## Features

- **Real-time scraping** - Uses Puppeteer to search gov.il
- **Dynamic selector discovery** - Automatically adapts to page structure changes
- **PDF extraction** - Reads full decision content from PDFs
- **Three databases** - Searches all gov.il land appraisal databases
- **Hebrew NL support** - Improved tool descriptions for Claude

## Installation

```powershell
cd C:\Users\user\automation-shamai\mcp-server-live
npm install
npm run build
```

## Available Tools

### 1. `search_decisions`
Search for decisions using structured parameters. Claude extracts parameters from your Hebrew query.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| database | string | Yes | `decisive_appraiser`, `appeals_committee`, or `appeals_board` |
| freeText | string | No | Free text search |
| city | string | No | City/committee name in Hebrew |
| blockNumber | string | No | Block number (גוש) |
| plotNumber | string | No | Plot number (חלקה) |
| caseType | string | No | Case type (היטל השבחה, פיצויים, etc.) |
| yearFrom | number | No | Start year |
| yearTo | number | No | End year |
| maxResults | number | No | Max results (default: 30) |

**Examples:**
```
"מצא החלטות בנתניה" → { database: "decisive_appraiser", city: "נתניה" }
"ערעורים בתל אביב" → { database: "appeals_board", city: "תל אביב" }
"השגות על היטל השבחה" → { database: "appeals_committee", caseType: "היטל השבחה" }
```

### 2. `read_decision_pdf`
Extract full text from a decision PDF.
```
Input: PDF URL from search results
Output: Complete Hebrew text of the decision
```

### 3. `list_databases`
List available databases.

### 4. `debug_page`
Debug tool to discover page structure. Use when searches return no results.

## Databases

| Database | Hebrew | Description |
|----------|--------|-------------|
| `decisive_appraiser` | שמאי מכריע | Land appraisal arbitration |
| `appeals_committee` | ועדת השגות | Appeals on valuations |
| `appeals_board` | ועדת ערעורים | Higher appeals |

## Add to Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gov-il-live": {
      "command": "node",
      "args": ["C:/Users/user/automation-shamai/mcp-server-live/dist/index.js"]
    }
  }
}
```

## Example Usage

**Simple search:**
> "מצא החלטות על היטל השבחה בתל אביב"

**With filters:**
> "החלטות בגוש 6158 מ-2024"

The MCP will:
1. Navigate to gov.il database
2. Fill in search filters (discovered dynamically)
3. Extract results
4. Return list with PDF URLs

## Troubleshooting

If searches return no results:
1. Use `debug_page` tool to inspect current page structure
2. Check if gov.il changed their page layout
3. Review console logs for selector discovery output

## Version History

- **v2.1.0** - Dynamic selector discovery, improved tool descriptions
- **v2.0.0** - Puppeteer-based search, PDF extraction

## License

MIT
