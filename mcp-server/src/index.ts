#!/usr/bin/env node
/**
 * Gov.il Land Appraisal MCP Server
 * Provides access to Israeli land appraisal decisions with full database access
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js';

import { getDatabase, closeDatabase, DecisionDatabase } from './database.js';
import { getEmbeddings, EmbeddingsManager } from './embeddings.js';
import { createIndexer } from './indexer.js';
import { createPdfExtractor, PdfExtractor, PdfExtractionResult } from './pdf-extractor.js';
import {
  DatabaseType,
  SearchParams,
  DATABASE_CONFIG,
  MCPToolResult,
  AmbiguityType,
  ClarificationPrompt,
  ClarifyQueryInput,
  ClarifyQueryResult,
  Decision,
  ConfidenceLevel,
  CitedSource,
  CitedClaim,
  QuotedExcerpt,
  ConstructAnswerInput,
  ConstructAnswerResult
} from './types.js';

// Configuration
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '';

// Initialize database (nullable for graceful unavailability handling)
let db: DecisionDatabase | null = null;
let embeddings: EmbeddingsManager | null = null;

/**
 * Helper function to check if database is available and return appropriate error response.
 * Used by all handlers that require database access.
 * @returns Error response if database unavailable, null if database is available
 */
function checkDatabaseAvailable(): MCPToolResult | null {
  if (!db) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Database unavailable',
          errorHe: 'מסד הנתונים אינו זמין',
          suggestion: 'The database is not initialized or has been closed. Please restart the MCP server. If the problem persists, check that the database file exists at ~/.gov-il-mcp/decisions.db and has proper permissions.',
          suggestionHe: 'מסד הנתונים לא אותחל או נסגר. אנא הפעל מחדש את שרת ה-MCP. אם הבעיה נמשכת, בדוק שקובץ מסד הנתונים קיים ב-~/.gov-il-mcp/decisions.db ויש הרשאות מתאימות.',
          possibleCauses: [
            'Server startup failed to initialize database',
            'Database file is missing or corrupted',
            'Insufficient permissions to access database directory',
            'Disk space is full'
          ],
          possibleCausesHe: [
            'הפעלת השרת נכשלה באתחול מסד הנתונים',
            'קובץ מסד הנתונים חסר או פגום',
            'אין הרשאות מספיקות לגישה לתיקיית מסד הנתונים',
            'הדיסק מלא'
          ]
        })
      }],
      isError: true
    };
  }
  return null;
}

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: 'search_decisions',
    description: `Search Israeli land appraisal decisions across three government databases.

## מאגרים / Databases
| Hebrew Keywords | Database ID | Description |
|-----------------|-------------|-------------|
| "שמאי מכריע", "הכרעה", "הכרעת שמאי" | decisive_appraiser | ~10,000+ הכרעות שמאי מכריע |
| "השגה", "ועדת השגות" | appeals_committee | ~5,000+ החלטות ועדת השגות |
| "ערעור", "ועדת ערעורים", "ערר" | appeals_board | ~5,000+ החלטות ועדת ערעורים |

**Default**: If database unclear from query, use decisive_appraiser (largest dataset).

## דוגמאות שאילתות / Query Examples
| User Query (Hebrew) | Expected Parameters |
|---------------------|---------------------|
| "החלטות בנתניה" | { committee: "נתניה" } |
| "גוש 6158 חלקה 25" | { block: "6158", plot: "25" } |
| "היטל השבחה תל אביב" | { caseType: "היטל השבחה", committee: "תל אביב" } |
| "ערעורים מ-2024" | { database: "appeals_board", fromDate: "2024-01-01" } |
| "שמאי מכריע כהן" | { database: "decisive_appraiser", appraiser: "כהן" } |
| "פיצויים על הפקעה" | { caseType: "פיצויים" } |
| "החלטות השגה בירושלים 2023" | { database: "appeals_committee", committee: "ירושלים", fromDate: "2023-01-01", toDate: "2023-12-31" } |
| "ירידת ערך רעננה" | { caseType: "ירידת ערך", committee: "רעננה" } |

## סוגי תיקים נפוצים / Common Case Types
| Case Type (Hebrew) | English | Description |
|-------------------|---------|-------------|
| היטל השבחה | Betterment Levy | Tax on property value increase due to planning changes |
| פיצויים | Compensation | Compensation for planning restrictions or damages |
| ירידת ערך | Depreciation | Claims for property value decrease due to planning |
| הפקעה | Expropriation | Land expropriation for public purposes |
| תכנית מתאר | Master Plan | Disputes related to master/outline plans |
| שינוי ייעוד | Zoning Change | Land use/zoning designation changes |
| היתר בניה | Building Permit | Building permit related disputes |
| תמ"א 38 | TAMA 38 | National earthquake reinforcement program disputes |
| פינוי בינוי | Urban Renewal | Urban renewal/evacuation-construction projects |
| תב"ע | Zoning Plan | Local zoning/building plan disputes |

**Mapping tip**: When user mentions these terms, use exact Hebrew value for caseType parameter.

## הנחיות חשובות / Important Guidelines (CRITICAL)
**אל תמציא פרמטרים שהמשתמש לא ציין / Don't invent parameters user didn't mention:**
- Extract ONLY parameters the user explicitly mentioned in their query
- Don't invent block/plot numbers if not stated - leave them empty
- Don't assume database if no keywords match the table above - use default
- Don't add caseType unless user mentioned a specific case type
- Don't guess committee/city names - only use what user wrote
- For date ranges, convert Hebrew years (תשפ"ד = 2024) to Gregorian
- When in doubt, use FEWER parameters rather than guessing

Returns results in <100ms from pre-indexed local database.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'שאילתת חיפוש חופשי (תומך בעברית) / Free text search query (Hebrew supported)'
        },
        database: {
          type: 'string',
          enum: ['decisive_appraiser', 'appeals_committee', 'appeals_board'],
          description: 'סינון לפי מאגר מסוים / Filter by specific database: decisive_appraiser=שמאי מכריע, appeals_committee=ועדת השגות, appeals_board=ועדת ערעורים'
        },
        committee: {
          type: 'string',
          description: 'סינון לפי ועדה מקומית (לדוגמה: תל אביב, ירושלים, חיפה) / Filter by local committee name'
        },
        block: {
          type: 'string',
          description: 'סינון לפי מספר גוש (לדוגמה: 6158) / Filter by block number'
        },
        plot: {
          type: 'string',
          description: 'סינון לפי מספר חלקה (לדוגמה: 25) / Filter by plot number'
        },
        appraiser: {
          type: 'string',
          description: 'סינון לפי שם השמאי (לדוגמה: כהן, לוי) / Filter by appraiser name'
        },
        caseType: {
          type: 'string',
          description: 'סינון לפי סוג תיק (לדוגמה: היטל השבחה, פיצויים, ירידת ערך) / Filter by case type'
        },
        fromDate: {
          type: 'string',
          description: 'סינון מתאריך (פורמט: YYYY-MM-DD או DD-MM-YYYY) / Filter decisions from this date'
        },
        toDate: {
          type: 'string',
          description: 'סינון עד תאריך (פורמט: YYYY-MM-DD או DD-MM-YYYY) / Filter decisions until this date'
        },
        limit: {
          type: 'number',
          description: 'מספר תוצאות מקסימלי (ברירת מחדל: 50, מקסימום: 500) / Maximum number of results',
          default: 50
        },
        offset: {
          type: 'number',
          description: 'דילוג על תוצאות (לדפדוף) / Skip this many results (for pagination)',
          default: 0
        },
        semanticSearch: {
          type: 'boolean',
          description: 'חיפוש סמנטי/AI במקום חיפוש מילות מפתח / Use semantic/AI search instead of keyword search',
          default: false
        }
      }
    }
  },
  {
    name: 'get_decision',
    description: `קבלת פרטי החלטה מלאים לפי מזהה / Get complete details of a specific decision by its ID.

## מתי להשתמש / When to Use
- After search_decisions returns results, use this to get full details of a specific decision
- When user asks about a specific decision they already know
- To verify decision details before citing in an answer

## מידע מוחזר / Returned Information
| Field | Hebrew | Description |
|-------|--------|-------------|
| id | מזהה | Unique decision identifier |
| title | כותרת | Full decision title |
| url | קישור | Link to PDF document |
| database | מאגר | Source database (decisive_appraiser/appeals_committee/appeals_board) |
| block | גוש | Block number if available |
| plot | חלקה | Plot number if available |
| committee | ועדה | Local committee name |
| appraiser | שמאי | Appraiser name if available |
| caseType | סוג תיק | Case type (היטל השבחה, פיצויים, etc.) |
| decisionDate | תאריך החלטה | Date of the decision |
| publishDate | תאריך פרסום | Publication date |

## דוגמה / Example
Input: { "id": "decisive_appraiser_12345" }
Output: Full decision object with all available fields

## הערות / Notes
- Returns null/error if decision ID not found
- Use read_pdf to get the actual decision text content`,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'מזהה ההחלטה הייחודי / The unique decision ID (e.g., "decisive_appraiser_12345")'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'get_decision_pdf',
    description: `קבלת קישור ל-PDF של ההחלטה / Get the PDF URL for a specific decision document.

## מתי להשתמש / When to Use
- To provide user with direct link to the official decision document
- Before calling read_pdf to verify PDF is available
- When user wants to download or view the original document

## ההבדל בין get_decision_pdf ל-read_pdf / Difference from read_pdf
| Tool | Purpose | Returns |
|------|---------|---------|
| get_decision_pdf | Get link to PDF | URL only (fast, no API key needed) |
| read_pdf | Extract text from PDF | Full text content (requires SCRAPER_API_KEY) |

## פלט / Output
Returns JSON with:
- id: Decision identifier
- title: Decision title
- pdfUrl: Direct URL to PDF document (gov.il)
- database: Source database

## דוגמה / Example
Input: { "id": "decisive_appraiser_12345" }
Output: { "id": "...", "title": "...", "pdfUrl": "https://free-justice.openapi.gov.il/...", "database": "decisive_appraiser" }

## שגיאות אפשריות / Possible Errors
- Decision not found: Invalid ID
- No PDF URL available: Some decisions may not have PDF links`,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'מזהה ההחלטה הייחודי / The unique decision ID'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'read_pdf',
    description: `קריאת תוכן PDF של החלטה / Read and extract text content from a decision's PDF document.

Use this tool when you need to:
- Get the full text of a specific decision for detailed analysis
- Quote specific passages from the decision document
- Answer questions that require reading the actual decision content

## שימוש / Usage
1. First get decision ID from search_decisions or get_decision
2. Call read_pdf with the decision ID
3. Optionally limit pages for faster extraction

## פלט / Output
Returns:
- fullText: The complete extracted text (Hebrew with RTL handling)
- pageCount: Total pages in the PDF
- extractedPages: Number of pages actually extracted
- cached: Whether the text was retrieved from cache

## Performance Notes
- First extraction requires download via ScraperAPI (SCRAPER_API_KEY required)
- Subsequent reads are cached locally (instant)
- Use maxPages for faster extraction of large documents`,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'מזהה ההחלטה (ID) / The decision ID to read PDF from'
        },
        maxPages: {
          type: 'number',
          description: 'מספר עמודים מקסימלי לחילוץ (0 = הכל, ברירת מחדל: 0) / Maximum pages to extract (0 = all, default: 0)'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'get_statistics',
    description: `קבלת סטטיסטיקות על מאגר ההחלטות / Get statistics about the indexed decisions database.

## מתי להשתמש / When to Use
- To provide user with overview of available data
- To check database health and recency
- When user asks "how many decisions" or "what's available"

## מידע מוחזר / Returned Information
| Field | Hebrew | Description |
|-------|--------|-------------|
| totalDocuments | סה"כ מסמכים | Total number of indexed decisions |
| byDatabase | לפי מאגר | Breakdown by database with Hebrew names |
| lastIndexedAt | אינדוקס אחרון | When the database was last fully indexed |
| lastUpdateAt | עדכון אחרון | When incremental update last ran |

## פירוט מאגרים / Database Breakdown
| Database ID | Hebrew Name | Est. Size |
|-------------|-------------|-----------|
| decisive_appraiser | שמאי מכריע | ~10,000+ |
| appeals_committee | ועדת השגות | ~5,000+ |
| appeals_board | ועדת ערעורים | ~5,000+ |

## דוגמת פלט / Example Output
{
  "totalDocuments": 20000,
  "byDatabase": [
    { "database": "decisive_appraiser", "name": "שמאי מכריע", "count": 10500 },
    { "database": "appeals_committee", "name": "ועדת השגות", "count": 5200 },
    { "database": "appeals_board", "name": "ועדת ערעורים", "count": 4300 }
  ],
  "lastIndexedAt": "2024-01-15T10:30:00Z",
  "lastUpdateAt": "2024-01-20T08:00:00Z"
}`,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'list_committees',
    description: `רשימת כל הוועדות המקומיות במאגר / List all local committees (ועדות מקומיות) that have decisions in the database.

## מתי להשתמש / When to Use
- To show user which cities/committees are available in the database
- To help user select a valid committee name for filtering
- When user asks "which areas have decisions" or "show me available cities"

## מידע מוחזר / Returned Information
- count: Total number of unique committees
- committees: Array of committee names (Hebrew strings)

## דוגמאות ועדות נפוצות / Common Committee Examples
| Hebrew | English |
|--------|---------|
| תל אביב יפו | Tel Aviv-Yafo |
| ירושלים | Jerusalem |
| חיפה | Haifa |
| באר שבע | Beer Sheva |
| נתניה | Netanya |
| ראשון לציון | Rishon LeZion |
| פתח תקווה | Petah Tikva |
| אשדוד | Ashdod |
| הרצליה | Herzliya |
| רעננה | Ra'anana |

## שימוש בתוצאות / Using Results
Use the returned committee name (exactly as spelled) in search_decisions committee parameter:
\`\`\`json
{ "committee": "תל אביב יפו" }
\`\`\`

## דוגמת פלט / Example Output
{
  "count": 150,
  "committees": ["תל אביב יפו", "ירושלים", "חיפה", ...]
}`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'מספר ועדות מקסימלי להחזרה (ברירת מחדל: 100) / Maximum number of committees to return',
          default: 100
        }
      }
    }
  },
  {
    name: 'list_appraisers',
    description: `רשימת כל השמאים במאגר / List all appraisers (שמאים) that have decisions in the database.

## מתי להשתמש / When to Use
- To show user which appraisers have decisions in the database
- To help user select a valid appraiser name for filtering
- When user asks "which appraisers are available" or wants to search by appraiser

## מידע מוחזר / Returned Information
- count: Total number of unique appraisers
- appraisers: Array of appraiser names (Hebrew strings)

## שימוש בתוצאות / Using Results
Use the returned appraiser name (exactly as spelled) in search_decisions appraiser parameter:
\`\`\`json
{ "appraiser": "כהן" }
\`\`\`

## הערה חשובה / Important Note
Appraiser names appear in the decisive_appraiser database primarily.
Appeals committee and appeals board decisions may not have appraiser information.

## דוגמת פלט / Example Output
{
  "count": 85,
  "appraisers": ["כהן יוסף", "לוי דוד", "גרוס משה", ...]
}

## טיפים לחיפוש / Search Tips
- Search by last name (שם משפחה) is more reliable: { "appraiser": "כהן" }
- Full name if known: { "appraiser": "כהן יוסף" }
- Partial matches work: "כהן" will find "כהן יוסף", "כהן דוד", etc.`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'מספר שמאים מקסימלי להחזרה (ברירת מחדל: 100) / Maximum number of appraisers to return',
          default: 100
        }
      }
    }
  },
  {
    name: 'compare_decisions',
    description: `השוואת מספר החלטות זו לזו / Compare multiple decisions side by side.

## מתי להשתמש / When to Use
- When user wants to compare similar cases
- To analyze patterns across multiple decisions
- To show consistency or variations in rulings
- When analyzing decisions from same block/plot over time

## דוגמאות שימוש / Usage Examples

### השוואת החלטות באותו גוש / Comparing decisions in same block:
User: "השווה את ההחלטות בגוש 6158"
1. First search: search_decisions({ block: "6158" })
2. Then compare: compare_decisions({ ids: ["id1", "id2", "id3"] })

### השוואת פסיקות אותו שמאי / Comparing same appraiser's rulings:
User: "איך שמאי כהן פסק בתיקים דומים?"
1. First search: search_decisions({ appraiser: "כהן", caseType: "היטל השבחה" })
2. Then compare: compare_decisions({ ids: [...] })

## מידע מוחזר / Returned Information
| Field | Description |
|-------|-------------|
| count | Number of valid decisions found |
| requestedIds | Original IDs requested |
| foundIds | IDs that were found |
| decisions | Full decision objects for comparison |

## טיפים להשוואה יעילה / Tips for Effective Comparison
- Compare 2-5 decisions for clarity
- Choose decisions with similar attributes (same caseType, same area)
- Look for: outcome patterns, valuation methods, reasoning differences

## שגיאות אפשריות / Possible Errors
- If no valid IDs found: Returns error
- If some IDs invalid: Returns only found decisions, lists missing IDs`,
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'רשימת מזהי החלטות להשוואה (2-10 מזהים מומלץ) / Array of decision IDs to compare (2-10 IDs recommended)'
        }
      },
      required: ['ids']
    }
  },
  {
    name: 'semantic_search',
    description: `חיפוש סמנטי בשפה טבעית באמצעות AI / Search for decisions using natural language and AI embeddings.

## מתי להשתמש vs search_decisions / When to Use vs search_decisions

| Scenario | Use | Reason |
|----------|-----|--------|
| "גוש 6158 חלקה 25" | search_decisions | Exact parameters available |
| "היטל השבחה בתל אביב" | search_decisions | Clear keywords and filters |
| "פיצויים על הפקעה ליד הים" | semantic_search | Conceptual, location-based |
| "תיקים דומים לשלי" | semantic_search | Requires understanding |
| "מה המגמה בפסיקות" | semantic_search | Pattern/trend questions |

## יתרונות החיפוש הסמנטי / Advantages of Semantic Search
- מבין הקשר / Understands context
- מוצא דומיות מושגית / Finds conceptual similarity
- עובד טוב עם עברית חופשית / Works well with free Hebrew text
- מדרג לפי רלוונטיות אמיתית / Ranks by true relevance

## מגבלות / Limitations
- דורש הגדרת embeddings / Requires embeddings setup
- איטי יותר מחיפוש רגיל / Slower than keyword search
- לא זמין אם לא הוגדר / Not available if not configured

## דוגמאות שאילתות מתאימות / Suitable Query Examples
| Query | Why Semantic Works Better |
|-------|---------------------------|
| "תיקים שהשמאי פסק לטובת הועדה" | Understands "לטובת" concept |
| "מקרים של הפקעה לצורכי ציבור" | Conceptual understanding |
| "החלטות עם פיצוי גבוה" | Relative term understanding |

## פלט / Output
Results include relevanceScore (0-1) indicating semantic similarity to query.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'שאילתת חיפוש בשפה טבעית (עברית מומלץ) / Natural language search query (Hebrew recommended)'
        },
        limit: {
          type: 'number',
          description: 'מספר תוצאות מקסימלי (ברירת מחדל: 20) / Maximum number of results',
          default: 20
        },
        database: {
          type: 'string',
          enum: ['decisive_appraiser', 'appeals_committee', 'appeals_board'],
          description: 'סינון לפי מאגר מסוים (אופציונלי) / Filter by specific database (optional): decisive_appraiser=שמאי מכריע, appeals_committee=ועדת השגות, appeals_board=ועדת ערעורים'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'trigger_update',
    description: `הפעלת עדכון לשליפת החלטות חדשות מ-gov.il / Trigger an incremental update to fetch new decisions from gov.il.

## מתי להשתמש / When to Use
- When user asks "check for new decisions"
- When database needs to be refreshed with latest data
- When user suspects missing recent decisions
- NOT for routine use - updates run automatically via cron

## דרישות / Requirements
- SCRAPER_API_KEY environment variable must be set
- Internet access to gov.il

## איך זה עובד / How It Works
1. Checks first N pages of each database (most recent decisions)
2. Compares content hash to detect new decisions
3. Adds only decisions not already in database
4. Updates lastUpdateAt timestamp

## פרמטרים / Parameters
| Parameter | Default | Description |
|-----------|---------|-------------|
| pagesToCheck | 5 | Number of recent pages to scan per database |

Pages × 10 items = decisions checked per database
Example: pagesToCheck=5 → ~50 recent decisions per database → ~150 total

## פלט / Output
{
  "success": true,
  "newDecisionsFound": 12,
  "byDatabase": {
    "decisive_appraiser": 5,
    "appeals_committee": 4,
    "appeals_board": 3
  },
  "timestamp": "2024-01-20T10:30:00Z"
}

## עדכון אוטומטי / Automatic Updates
Daily cron job runs: \`npm run daily-update\`
This tool is for manual/on-demand updates only.

## שגיאות אפשריות / Possible Errors
- Missing SCRAPER_API_KEY: Cannot fetch from gov.il
- Network error: gov.il unreachable
- Scraping blocked: ScraperAPI issue`,
    inputSchema: {
      type: 'object',
      properties: {
        pagesToCheck: {
          type: 'number',
          description: 'מספר עמודים אחרונים לבדוק להחלטות חדשות (ברירת מחדל: 5, מומלץ: 3-10) / Number of recent pages to check for new decisions (default: 5, recommended: 3-10)',
          default: 5
        }
      }
    }
  },
  {
    name: 'clarify_query',
    description: `זיהוי עמימות בשאילתה והצעת שאלות הבהרה / Detect ambiguity in user query and suggest clarification questions.

Use this tool BEFORE searching when the user's query is ambiguous or incomplete.

## סוגי עמימות / Ambiguity Types
| Type | Hebrew | When to Detect |
|------|--------|----------------|
| missing_database | חסר מאגר | No database keywords (שמאי מכריע/השגה/ערעור) |
| vague_location | מיקום עמום | No specific city/committee or block/plot |
| unclear_date_range | טווח תאריכים לא ברור | Year mentioned but unclear if range |
| ambiguous_case_type | סוג תיק לא ברור | General legal terms without specific case type |
| missing_search_terms | חסרים מונחי חיפוש | Query too short or generic |

## Usage Flow
1. User provides query → Call clarify_query first
2. If needsClarification=true → Present clarification questions to user
3. User answers → Use answers to refine search_decisions parameters
4. Call search_decisions with refined parameters

## Example
Query: "החלטות בתל אביב"
→ Detects: missing_database (no שמאי מכריע/השגה/ערעור keyword)
→ Returns clarification: "באיזה מאגר לחפש?" with options

## Avoiding Repeated Questions
Pass previousClarifications array with ambiguity types already resolved to avoid asking the same question twice.`,
    inputSchema: {
      type: 'object',
      properties: {
        originalQuery: {
          type: 'string',
          description: 'השאילתה המקורית של המשתמש בעברית / The original user query in Hebrew'
        },
        previousClarifications: {
          type: 'array',
          items: { type: 'string' },
          description: 'סוגי עמימות שכבר הובהרו (למניעת שאלות חוזרות) / Ambiguity types already clarified to avoid re-asking'
        }
      },
      required: ['originalQuery']
    }
  },
  {
    name: 'construct_answer',
    description: `בניית תשובה מובנית עם ציטוטים למקורות / Construct a structured answer with inline citations to source documents.

Use this tool AFTER searching to format your response with proper citations.

## Citation Format
- Inline citations: [S0], [S1], [S2], etc. (S = Source)
- Each citation refers to a source in the sources array by index
- Place citation immediately after the claim it supports

## Output Structure
Returns a structured response with:
1. **formattedAnswer**: The answer text with inline [S0], [S1] citations
2. **sources**: Array of cited sources with decision ID, title, PDF URL, relevance score
3. **claims**: Individual claims with their supporting citations
4. **overallConfidence**: "confident" (בטוח) or "uncertain" (ייתכן)
5. **noResultsWarning**: Hebrew warning when no relevant results found

## Usage Examples

### Example 1: Simple answer with citations
Input decisions from search → construct_answer formats as:
"לפי הכרעת השמאי המכריע [S0], נקבע כי היטל ההשבחה..."

### Example 2: Multiple sources
"ישנן מספר החלטות בנושא [S0][S1]. בהחלטה הראשונה [S0] נקבע..."

### Example 3: Quoting PDF content
When pdfExcerpts provided:
"השמאי קבע: \"...הפיצוי יעמוד על 50,000 ש\"ח...\" [S0]"

## Confidence Indicators
- "בטוח" (confident): Multiple matching decisions, clear consensus
- "ייתכן" (uncertain): Few results, conflicting decisions, or extrapolation

## No Results
When decisions array is empty:
- noResultsWarning: "לא נמצאו החלטות רלוונטיות לשאילתה זו"
- Suggest: refining search, trying different database, or clarifying query`,
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'השאלה המקורית של המשתמש / The user\'s original question'
        },
        decisions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              url: { type: 'string' },
              database: { type: 'string' },
              relevanceScore: { type: 'number' }
            }
          },
          description: 'תוצאות החיפוש לציטוט / Search results to cite from'
        },
        pdfExcerpts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              decisionId: { type: 'string' },
              excerpt: { type: 'string' }
            }
          },
          description: 'ציטוטים מתוך תוכן ה-PDF (אופציונלי) / Excerpts from PDF content (optional)'
        }
      },
      required: ['question', 'decisions']
    }
  },
  {
    name: 'health_check',
    description: `בדיקת תקינות השרת והתקנה / Verify MCP server setup and health status.

## מתי להשתמש / When to Use
- After first installation to verify setup is complete
- When troubleshooting connection issues
- When Claude appears unable to access decisions
- To check if database is populated
- To verify SCRAPER_API_KEY is configured for live updates

## מה נבדק / What Is Checked
| Component | Check | Description |
|-----------|-------|-------------|
| Database | Connection | Can connect to SQLite database |
| Database | Populated | Has decisions indexed |
| Database | FTS5 | Full-text search working |
| API Key | Configured | SCRAPER_API_KEY set for updates |
| Embeddings | Available | ChromaDB/semantic search ready |

## פלט / Output Format
{
  "healthy": true,
  "status": {
    "database": { "connected": true, "decisionCount": 10500, "fts5Working": true },
    "scraperApi": { "configured": true },
    "embeddings": { "available": true },
    "server": { "version": "2.0.0", "uptime": "5m" }
  },
  "issues": [],
  "suggestions": []
}

## פלט עם בעיות / Output with Issues
{
  "healthy": false,
  "status": { ... },
  "issues": ["Database is empty - run npm run index-all"],
  "issuesHe": ["מסד הנתונים ריק - הרץ npm run index-all"],
  "suggestions": ["Set SCRAPER_API_KEY for live updates"],
  "suggestionsHe": ["הגדר SCRAPER_API_KEY לעדכונים חיים"]
}`,
    inputSchema: {
      type: 'object',
      properties: {
        verbose: {
          type: 'boolean',
          description: 'פירוט מלא כולל סטטיסטיקות לפי מאגר / Include detailed statistics per database',
          default: false
        }
      }
    }
  }
];

// Tool handlers
async function handleSearchDecisions(params: SearchParams): Promise<MCPToolResult> {
  // Check database availability
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const searchParams: SearchParams = {
    query: params.query,
    database: params.database,
    committee: params.committee,
    block: params.block,
    plot: params.plot,
    appraiser: params.appraiser,
    caseType: params.caseType,
    fromDate: params.fromDate,
    toDate: params.toDate,
    limit: Math.min(params.limit || 50, 500),
    offset: params.offset || 0,
    semanticSearch: params.semanticSearch
  };

  // Use semantic search if requested and available
  if (searchParams.semanticSearch && searchParams.query && embeddings) {
    const semanticResults = await embeddings.search(
      searchParams.query,
      searchParams.limit || 20,
      searchParams.database ? { database: searchParams.database } : undefined
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          searchType: 'semantic',
          query: searchParams.query,
          totalCount: semanticResults.length,
          decisions: semanticResults.map(r => ({
            ...r.decision,
            relevanceScore: r.score
          }))
        }, null, 2)
      }]
    };
  }

  // Regular search
  const result = db!.search(searchParams);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        searchType: 'keyword',
        query: searchParams,
        totalCount: result.totalCount,
        hasMore: result.hasMore,
        decisions: result.decisions
      }, null, 2)
    }]
  };
}

async function handleGetDecision(params: { id: string }): Promise<MCPToolResult> {
  // Check database availability
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const decision = db!.getDecision(params.id);

  if (!decision) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Decision not found',
          id: params.id,
          suggestion: 'Use search_decisions tool first to find valid decision IDs. Try searching by committee, block/plot, or case type.',
          suggestionHe: 'השתמש בכלי search_decisions כדי למצוא מזהי החלטות תקינים. נסה לחפש לפי ועדה, גוש/חלקה, או סוג תיק.'
        })
      }],
      isError: true
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(decision, null, 2)
    }]
  };
}

async function handleGetDecisionPdf(params: { id: string }): Promise<MCPToolResult> {
  // Check database availability
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const decision = db!.getDecision(params.id);

  if (!decision) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Decision not found',
          id: params.id,
          suggestion: 'Use search_decisions tool first to find valid decision IDs. Try searching by committee, block/plot, or case type.',
          suggestionHe: 'השתמש בכלי search_decisions כדי למצוא מזהי החלטות תקינים. נסה לחפש לפי ועדה, גוש/חלקה, או סוג תיק.'
        })
      }],
      isError: true
    };
  }

  if (!decision.url) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'No PDF URL available for this decision',
          id: params.id,
          title: decision.title,
          suggestion: 'This decision was indexed without a PDF link. Try get_decision to see available metadata, or search for similar decisions that may have PDFs.',
          suggestionHe: 'החלטה זו נוספה למאגר ללא קישור ל-PDF. נסה get_decision לראות מידע זמין, או חפש החלטות דומות שיש להן PDF.'
        })
      }],
      isError: true
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        id: decision.id,
        title: decision.title,
        pdfUrl: decision.url,
        database: decision.database
      }, null, 2)
    }]
  };
}

async function handleReadPdf(params: { id: string; maxPages?: number }): Promise<MCPToolResult> {
  // Check database availability
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  // Check for SCRAPER_API_KEY first
  if (!SCRAPER_API_KEY) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'SCRAPER_API_KEY environment variable not set',
          suggestion: 'Set SCRAPER_API_KEY to enable PDF reading'
        })
      }],
      isError: true
    };
  }

  const decision = db!.getDecision(params.id);

  if (!decision) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Decision not found',
          id: params.id,
          suggestion: 'Use search_decisions tool first to find valid decision IDs. Try searching by committee, block/plot, or case type.',
          suggestionHe: 'השתמש בכלי search_decisions כדי למצוא מזהי החלטות תקינים. נסה לחפש לפי ועדה, גוש/חלקה, או סוג תיק.'
        })
      }],
      isError: true
    };
  }

  if (!decision.url) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'No PDF URL available for this decision',
          id: params.id,
          title: decision.title,
          suggestion: 'This decision was indexed without a PDF link. Try get_decision to see available metadata, or search for similar decisions that may have PDFs.',
          suggestionHe: 'החלטה זו נוספה למאגר ללא קישור ל-PDF. נסה get_decision לראות מידע זמין, או חפש החלטות דומות שיש להן PDF.'
        })
      }],
      isError: true
    };
  }

  try {
    // Create PDF extractor with database for caching
    const pdfExtractor = createPdfExtractor(SCRAPER_API_KEY, {
      maxPages: params.maxPages || 0,
      database: db!
    });

    // Extract with caching support
    const result = await pdfExtractor.extractWithCache(decision.id, decision.url);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          id: decision.id,
          title: decision.title,
          fullText: result.fullText,
          pageCount: result.pageCount,
          extractedPages: result.extractedPages,
          cached: result.cached,
          textLength: result.fullText.length
        }, null, 2)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Failed to read PDF',
          id: params.id,
          message: error instanceof Error ? error.message : String(error),
          suggestion: 'PDF extraction failed. Possible causes: (1) PDF is corrupted or password-protected, (2) Network timeout - try again, (3) gov.il server temporarily unavailable. Try get_decision_pdf to verify the URL is valid.',
          suggestionHe: 'חילוץ ה-PDF נכשל. סיבות אפשריות: (1) PDF פגום או מוגן בסיסמה, (2) פסק זמן ברשת - נסה שוב, (3) שרת gov.il אינו זמין זמנית. נסה get_decision_pdf לוודא שהכתובת תקינה.'
        })
      }],
      isError: true
    };
  }
}

async function handleGetStatistics(): Promise<MCPToolResult> {
  // Check database availability
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const stats = db!.getStats();

  const databaseNames: Record<DatabaseType, string> = {
    decisive_appraiser: 'שמאי מכריע',
    appeals_committee: 'ועדת השגות',
    appeals_board: 'ועדת ערעורים'
  };

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        totalDocuments: stats.totalDocuments,
        byDatabase: Object.entries(stats.byDatabase).map(([key, count]) => ({
          database: key,
          name: databaseNames[key as DatabaseType],
          count
        })),
        // US-004: Breakdown by committee (top 20)
        byCommittee: stats.byCommittee,
        // US-004: Breakdown by case type
        byCaseType: stats.byCaseType,
        // US-004: Breakdown by year
        byYear: stats.byYear,
        // US-004: Date range of indexed decisions
        dateRange: {
          oldest: stats.oldestDecision,
          newest: stats.newestDecision
        },
        lastIndexedAt: stats.lastIndexedAt,
        lastUpdateAt: stats.lastUpdateAt
      }, null, 2)
    }]
  };
}

async function handleListCommittees(params: { limit?: number }): Promise<MCPToolResult> {
  // Check database availability
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const committees = db!.getDistinctValues('committee', params.limit || 100);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        count: committees.length,
        committees
      }, null, 2)
    }]
  };
}

async function handleListAppraisers(params: { limit?: number }): Promise<MCPToolResult> {
  // Check database availability
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const appraisers = db!.getDistinctValues('appraiser', params.limit || 100);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        count: appraisers.length,
        appraisers
      }, null, 2)
    }]
  };
}

async function handleCompareDecisions(params: { ids: string[] }): Promise<MCPToolResult> {
  // Check database availability
  const dbError = checkDatabaseAvailable();
  if (dbError) return dbError;

  const decisions = params.ids.map(id => db!.getDecision(id)).filter(d => d !== null);

  if (decisions.length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'No valid decisions found for the provided IDs',
          providedIds: params.ids,
          suggestion: 'None of the provided IDs exist in the database. Use search_decisions to find valid decision IDs first. Minimum 2 IDs required for comparison.',
          suggestionHe: 'אף אחד מהמזהים שסופקו לא קיים במאגר. השתמש ב-search_decisions כדי למצוא מזהי החלטות תקינים. נדרשים לפחות 2 מזהים להשוואה.'
        })
      }],
      isError: true
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        count: decisions.length,
        requestedIds: params.ids,
        foundIds: decisions.map(d => d!.id),
        decisions: decisions
      }, null, 2)
    }]
  };
}

async function handleSemanticSearch(params: { query: string; limit?: number; database?: DatabaseType }): Promise<MCPToolResult> {
  if (!embeddings) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Semantic search is not available.',
          suggestion: 'Use regular search_decisions tool instead'
        })
      }],
      isError: true
    };
  }

  const results = await embeddings.search(
    params.query,
    params.limit || 20,
    params.database ? { database: params.database } : undefined
  );

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        query: params.query,
        count: results.length,
        results: results.map(r => ({
          ...r.decision,
          relevanceScore: r.score
        }))
      }, null, 2)
    }]
  };
}

async function handleTriggerUpdate(params: { pagesToCheck?: number }): Promise<MCPToolResult> {
  if (!SCRAPER_API_KEY) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'SCRAPER_API_KEY environment variable not set',
          suggestion: 'Set SCRAPER_API_KEY to enable live updates from gov.il'
        })
      }],
      isError: true
    };
  }

  try {
    const indexer = createIndexer({
      scraperApiKey: SCRAPER_API_KEY,
      continueOnError: true
    });

    await indexer.initialize();
    const results = await indexer.updateRecent(params.pagesToCheck || 5);

    const summary: Record<string, number> = {};
    let totalNew = 0;
    for (const [dbName, count] of results) {
      summary[dbName] = count;
      totalNew += count;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          newDecisionsFound: totalNew,
          byDatabase: summary,
          timestamp: new Date().toISOString()
        }, null, 2)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Failed to update',
          message: error instanceof Error ? error.message : String(error),
          suggestion: 'Update failed. Possible causes: (1) gov.il is temporarily unavailable, (2) Network connectivity issues, (3) ScraperAPI rate limit reached. Try again later or reduce pagesToCheck parameter.',
          suggestionHe: 'העדכון נכשל. סיבות אפשריות: (1) gov.il אינו זמין זמנית, (2) בעיות קישוריות, (3) הגעה למגבלת ScraperAPI. נסה שוב מאוחר יותר או הקטן את פרמטר pagesToCheck.'
        })
      }],
      isError: true
    };
  }
}

async function handleHealthCheck(params: { verbose?: boolean }): Promise<MCPToolResult> {
  const startTime = Date.now();
  const issues: string[] = [];
  const issuesHe: string[] = [];
  const suggestions: string[] = [];
  const suggestionsHe: string[] = [];

  // Check database status
  let databaseStatus: {
    connected: boolean;
    decisionCount: number;
    fts5Working: boolean;
    path?: string;
    error?: string;
  } = {
    connected: false,
    decisionCount: 0,
    fts5Working: false
  };

  if (db) {
    try {
      // Test database connection
      const stats = db.getStats();
      databaseStatus.connected = true;
      databaseStatus.decisionCount = stats.totalDecisions;
      databaseStatus.path = db.getDbPath();

      // Test FTS5 by running a simple search
      try {
        db.search({ query: 'test', limit: 1 });
        databaseStatus.fts5Working = true;
      } catch {
        databaseStatus.fts5Working = false;
        issues.push('FTS5 full-text search is not working properly');
        issuesHe.push('חיפוש טקסט מלא FTS5 אינו עובד כראוי');
      }

      if (stats.totalDecisions === 0) {
        issues.push('Database is empty - run "npm run index-all" to populate');
        issuesHe.push('מסד הנתונים ריק - הרץ "npm run index-all" לאכלוס');
        suggestions.push('Run: SCRAPER_API_KEY=your_key npm run index-all');
        suggestionsHe.push('הרץ: SCRAPER_API_KEY=your_key npm run index-all');
      }
    } catch (error) {
      databaseStatus.connected = false;
      databaseStatus.error = error instanceof Error ? error.message : String(error);
      issues.push(`Database connection failed: ${databaseStatus.error}`);
      issuesHe.push(`חיבור למסד הנתונים נכשל: ${databaseStatus.error}`);
    }
  } else {
    issues.push('Database not initialized');
    issuesHe.push('מסד הנתונים לא אותחל');
    suggestions.push('Restart the MCP server. Check ~/.gov-il-mcp/decisions.db exists.');
    suggestionsHe.push('הפעל מחדש את שרת ה-MCP. בדוק ש-~/.gov-il-mcp/decisions.db קיים.');
  }

  // Check ScraperAPI status
  const scraperApiStatus: {
    configured: boolean;
    keyPresent: boolean;
  } = {
    configured: !!SCRAPER_API_KEY,
    keyPresent: !!SCRAPER_API_KEY
  };

  if (!SCRAPER_API_KEY) {
    suggestions.push('Set SCRAPER_API_KEY environment variable for live updates from gov.il');
    suggestionsHe.push('הגדר משתנה סביבה SCRAPER_API_KEY לעדכונים חיים מ-gov.il');
  }

  // Check embeddings status
  const embeddingsStatus: {
    available: boolean;
    error?: string;
  } = {
    available: !!embeddings
  };

  if (!embeddings) {
    suggestions.push('Embeddings/semantic search not available. This is optional but enhances search.');
    suggestionsHe.push('חיפוש סמנטי/embeddings לא זמין. זה אופציונלי אך משפר את החיפוש.');
  }

  // Server info
  const serverStatus = {
    version: '2.0.0',
    uptimeMs: Date.now() - startTime,
    nodeVersion: process.version
  };

  // Build detailed stats if verbose
  let detailedStats: Record<string, unknown> | undefined;
  if (params.verbose && db) {
    try {
      const stats = db.getStats();
      detailedStats = {
        byDatabase: stats.byDatabase,
        recentDecisions: stats.recentDecisions,
        lastUpdateAt: stats.lastUpdateAt,
        oldestDecision: stats.oldestDecision
      };
    } catch {
      // Ignore errors for verbose stats
    }
  }

  const healthy = databaseStatus.connected && databaseStatus.decisionCount > 0;

  const result: Record<string, unknown> = {
    healthy,
    status: {
      database: databaseStatus,
      scraperApi: scraperApiStatus,
      embeddings: embeddingsStatus,
      server: serverStatus
    },
    issues,
    issuesHe,
    suggestions,
    suggestionsHe
  };

  if (detailedStats) {
    result.detailedStats = detailedStats;
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }],
    isError: !healthy
  };
}

// Clarification prompts for different ambiguity types
const CLARIFICATION_PROMPTS: Record<AmbiguityType, ClarificationPrompt> = {
  missing_database: {
    ambiguityType: 'missing_database',
    question: 'באיזה מאגר לחפש?',
    questionEn: 'Which database should we search?',
    options: [
      { value: 'decisive_appraiser', label: 'שמאי מכריע', labelEn: 'Decisive Appraiser' },
      { value: 'appeals_committee', label: 'ועדת השגות', labelEn: 'Appeals Committee' },
      { value: 'appeals_board', label: 'ועדת ערעורים', labelEn: 'Appeals Board' },
      { value: 'all', label: 'כל המאגרים', labelEn: 'All databases' }
    ],
    allowMultiple: true
  },
  vague_location: {
    ambiguityType: 'vague_location',
    question: 'האם תרצה לצמצם לאזור מסוים?',
    questionEn: 'Would you like to narrow down to a specific area?',
    options: [
      { value: 'specify_city', label: 'ציין עיר/ועדה', labelEn: 'Specify city/committee' },
      { value: 'specify_block', label: 'ציין גוש וחלקה', labelEn: 'Specify block and plot' },
      { value: 'no_location', label: 'חפש בכל הארץ', labelEn: 'Search nationwide' }
    ],
    allowFreeText: true
  },
  unclear_date_range: {
    ambiguityType: 'unclear_date_range',
    question: 'לאיזה טווח תאריכים לחפש?',
    questionEn: 'What date range should we search?',
    options: [
      { value: 'last_year', label: 'שנה אחרונה', labelEn: 'Last year' },
      { value: 'last_3_years', label: '3 שנים אחרונות', labelEn: 'Last 3 years' },
      { value: 'last_5_years', label: '5 שנים אחרונות', labelEn: 'Last 5 years' },
      { value: 'all_time', label: 'כל הזמן', labelEn: 'All time' }
    ],
    allowFreeText: true
  },
  ambiguous_case_type: {
    ambiguityType: 'ambiguous_case_type',
    question: 'איזה סוג תיק מעניין אותך?',
    questionEn: 'What type of case interests you?',
    options: [
      { value: 'היטל השבחה', label: 'היטל השבחה', labelEn: 'Betterment Levy' },
      { value: 'פיצויים', label: 'פיצויים', labelEn: 'Compensation' },
      { value: 'ירידת ערך', label: 'ירידת ערך', labelEn: 'Depreciation' },
      { value: 'all_types', label: 'כל סוגי התיקים', labelEn: 'All case types' }
    ],
    allowFreeText: true
  },
  missing_search_terms: {
    ambiguityType: 'missing_search_terms',
    question: 'השאילתה קצרה מדי. מה בדיוק אתה מחפש?',
    questionEn: 'The query is too short. What exactly are you looking for?',
    options: [
      { value: 'add_details', label: 'אוסיף פרטים נוספים', labelEn: 'I will add more details' },
      { value: 'show_recent', label: 'הצג החלטות אחרונות', labelEn: 'Show recent decisions' },
      { value: 'show_statistics', label: 'הצג סטטיסטיקות', labelEn: 'Show statistics' }
    ],
    allowFreeText: true
  }
};

// Database keywords for detection
const DATABASE_KEYWORDS: Record<DatabaseType, string[]> = {
  decisive_appraiser: ['שמאי מכריע', 'הכרעה', 'הכרעת שמאי', 'מכריע'],
  appeals_committee: ['השגה', 'ועדת השגות', 'השגות'],
  appeals_board: ['ערעור', 'ועדת ערעורים', 'ערר', 'ערעורים']
};

// Case type keywords
const CASE_TYPE_KEYWORDS = [
  'היטל השבחה', 'פיצויים', 'ירידת ערך', 'הפקעה',
  'תכנית מתאר', 'שינוי ייעוד', 'היתר בניה',
  'תמ"א 38', 'פינוי בינוי', 'תב"ע'
];

// Year pattern for date detection
const YEAR_PATTERN = /\b(19|20)\d{2}\b|תשפ"?[א-ת]|תש[פע]"?[א-ת]/;

// Block/plot pattern
const BLOCK_PLOT_PATTERN = /גוש\s*\d+|חלקה\s*\d+|ג['׳]?\s*\d+|ח['׳]?\s*\d+/;

async function handleClarifyQuery(params: ClarifyQueryInput): Promise<MCPToolResult> {
  const { originalQuery, previousClarifications = [] } = params;
  const query = originalQuery.trim();

  const detectedAmbiguities: AmbiguityType[] = [];
  const clarifications: ClarificationPrompt[] = [];
  const suggestedParams: Partial<SearchParams> = {};

  // Check for minimum query length
  if (query.length < 3) {
    if (!previousClarifications.includes('missing_search_terms')) {
      detectedAmbiguities.push('missing_search_terms');
    }
  }

  // Check for database keywords
  let hasDbKeyword = false;
  for (const [dbType, keywords] of Object.entries(DATABASE_KEYWORDS)) {
    for (const keyword of keywords) {
      if (query.includes(keyword)) {
        hasDbKeyword = true;
        suggestedParams.database = dbType as DatabaseType;
        break;
      }
    }
    if (hasDbKeyword) break;
  }

  if (!hasDbKeyword && !previousClarifications.includes('missing_database')) {
    detectedAmbiguities.push('missing_database');
  }

  // Check for location specificity (city names or block/plot)
  const hasBlockPlot = BLOCK_PLOT_PATTERN.test(query);
  // Common Israeli cities - check if query mentions any
  const commonCities = ['תל אביב', 'ירושלים', 'חיפה', 'באר שבע', 'רעננה', 'נתניה', 'הרצליה', 'פתח תקווה', 'ראשון לציון', 'אשדוד'];
  const hasCityName = commonCities.some(city => query.includes(city));

  if (!hasBlockPlot && !hasCityName && query.length > 10 && !previousClarifications.includes('vague_location')) {
    // Only suggest location clarification for longer queries that don't have location info
    detectedAmbiguities.push('vague_location');
  }

  // Check for date/year mentions without clear range
  const hasYear = YEAR_PATTERN.test(query);
  const hasDateRange = query.includes('מ-') || query.includes('עד') || query.includes('בין') ||
                       query.includes('מתאריך') || query.includes('לתאריך');

  if (hasYear && !hasDateRange && !previousClarifications.includes('unclear_date_range')) {
    detectedAmbiguities.push('unclear_date_range');
  }

  // Check for case type specificity
  const hasCaseType = CASE_TYPE_KEYWORDS.some(caseType => query.includes(caseType));
  // General legal terms that might need clarification
  const generalTerms = ['החלטות', 'פסיקות', 'תיקים', 'עניינים'];
  const hasGeneralTerms = generalTerms.some(term => query.includes(term));

  if (!hasCaseType && hasGeneralTerms && !previousClarifications.includes('ambiguous_case_type')) {
    detectedAmbiguities.push('ambiguous_case_type');
  }

  // Build clarification prompts for detected ambiguities
  for (const ambiguity of detectedAmbiguities) {
    clarifications.push(CLARIFICATION_PROMPTS[ambiguity]);
  }

  // Extract any parameters we could determine despite ambiguity
  if (hasCaseType) {
    for (const caseType of CASE_TYPE_KEYWORDS) {
      if (query.includes(caseType)) {
        suggestedParams.caseType = caseType;
        break;
      }
    }
  }

  if (hasCityName) {
    for (const city of commonCities) {
      if (query.includes(city)) {
        suggestedParams.committee = city;
        break;
      }
    }
  }

  // Extract block/plot if present
  const blockMatch = query.match(/גוש\s*(\d+)|ג['׳]?\s*(\d+)/);
  if (blockMatch) {
    suggestedParams.block = blockMatch[1] || blockMatch[2];
  }

  const plotMatch = query.match(/חלקה\s*(\d+)|ח['׳]?\s*(\d+)/);
  if (plotMatch) {
    suggestedParams.plot = plotMatch[1] || plotMatch[2];
  }

  const result: ClarifyQueryResult = {
    needsClarification: clarifications.length > 0,
    clarifications,
    detectedAmbiguities,
    suggestedParams: Object.keys(suggestedParams).length > 0 ? suggestedParams : undefined,
    originalQuery: query
  };

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }]
  };
}

/**
 * Generate claims from sources with citation mappings.
 * Each claim is linked to the specific decision(s) that support it.
 * This helps Claude construct accurate, well-cited answers.
 */
function generateClaimsFromSources(
  question: string,
  decisions: Decision[],
  sources: CitedSource[],
  pdfExcerpts: Array<{ decisionId: string; excerpt: string }>
): CitedClaim[] {
  const claims: CitedClaim[] = [];

  // Group decisions by shared attributes to identify common themes
  const decisionsByBlock = new Map<string, number[]>();
  const decisionsByCommittee = new Map<string, number[]>();
  const decisionsByCaseType = new Map<string, number[]>();
  const decisionsByAppraiser = new Map<string, number[]>();

  decisions.forEach((decision, index) => {
    if (decision.block) {
      const key = decision.block;
      if (!decisionsByBlock.has(key)) decisionsByBlock.set(key, []);
      decisionsByBlock.get(key)!.push(index);
    }
    if (decision.committee) {
      const key = decision.committee;
      if (!decisionsByCommittee.has(key)) decisionsByCommittee.set(key, []);
      decisionsByCommittee.get(key)!.push(index);
    }
    if (decision.caseType) {
      const key = decision.caseType;
      if (!decisionsByCaseType.has(key)) decisionsByCaseType.set(key, []);
      decisionsByCaseType.get(key)!.push(index);
    }
    if (decision.appraiser) {
      const key = decision.appraiser;
      if (!decisionsByAppraiser.has(key)) decisionsByAppraiser.set(key, []);
      decisionsByAppraiser.get(key)!.push(index);
    }
  });

  // Generate claims based on location (block/plot) if present in query
  const hasLocationQuery = /גוש|חלקה|ג['׳]|ח['׳]|\d{4,}/.test(question);
  if (hasLocationQuery) {
    decisionsByBlock.forEach((indices, block) => {
      const relevantDecisions = indices.map(i => decisions[i]);
      const hasHighRelevance = relevantDecisions.some(d => (d.relevanceScore || 0) > 0.6);
      claims.push({
        text: `נמצאו ${indices.length} החלטות בגוש ${block}`,
        citations: indices,
        confidence: hasHighRelevance ? 'confident' : 'uncertain'
      });
    });
  }

  // Generate claims based on committee/location
  const hasCommitteeQuery = /ועדה|עירייה|רשות|מקומי/.test(question);
  const hasCityQuery = /תל אביב|ירושלים|חיפה|באר שבע|נתניה|רעננה|הרצליה|רמת גן|פתח תקווה|אשדוד/.test(question);
  if (hasCommitteeQuery || hasCityQuery) {
    decisionsByCommittee.forEach((indices, committee) => {
      if (indices.length >= 1) {
        const relevantDecisions = indices.map(i => decisions[i]);
        const avgRelevance = relevantDecisions.reduce((sum, d) => sum + (d.relevanceScore || 0), 0) / indices.length;
        claims.push({
          text: `${indices.length} החלטות נמצאו מועדה ${committee}`,
          citations: indices,
          confidence: avgRelevance > 0.5 ? 'confident' : 'uncertain'
        });
      }
    });
  }

  // Generate claims based on case type
  const caseTypeKeywords = ['היטל השבחה', 'פיצויים', 'ירידת ערך', 'הפקעה', 'תכנית מתאר', 'שינוי ייעוד', 'היתר בניה', 'תמ"א 38', 'פינוי בינוי', 'תב"ע'];
  const queriedCaseType = caseTypeKeywords.find(ct => question.includes(ct));
  if (queriedCaseType) {
    decisionsByCaseType.forEach((indices, caseType) => {
      if (caseType.includes(queriedCaseType) || queriedCaseType.includes(caseType)) {
        const relevantDecisions = indices.map(i => decisions[i]);
        const hasHighRelevance = relevantDecisions.some(d => (d.relevanceScore || 0) > 0.6);
        claims.push({
          text: `${indices.length} החלטות עוסקות ב${caseType}`,
          citations: indices,
          confidence: hasHighRelevance ? 'confident' : 'uncertain'
        });
      }
    });
  }

  // Generate claims based on appraiser if queried
  const hasAppraiserQuery = /שמאי|מעריך/.test(question);
  if (hasAppraiserQuery) {
    decisionsByAppraiser.forEach((indices, appraiser) => {
      if (indices.length >= 1) {
        claims.push({
          text: `שמאי ${appraiser} טיפל ב-${indices.length} מקרים`,
          citations: indices,
          confidence: indices.length > 1 ? 'confident' : 'uncertain'
        });
      }
    });
  }

  // Generate claims from PDF excerpts if available
  pdfExcerpts.forEach(({ decisionId, excerpt }) => {
    const sourceIndex = sources.findIndex(s => s.decisionId === decisionId);
    if (sourceIndex >= 0 && excerpt.length > 50) {
      // Extract a meaningful claim from the excerpt
      const truncatedExcerpt = excerpt.length > 150 ? excerpt.substring(0, 150) + '...' : excerpt;
      claims.push({
        text: `מתוך ההחלטה: "${truncatedExcerpt}"`,
        citations: [sourceIndex],
        confidence: 'confident' // Direct quotes from PDF are high confidence
      });
    }
  });

  // If no specific claims were generated, create general source claims
  if (claims.length === 0 && decisions.length > 0) {
    // Create a claim for each decision with its key details
    decisions.slice(0, 5).forEach((decision, index) => {
      const details: string[] = [];
      if (decision.caseType) details.push(decision.caseType);
      if (decision.committee) details.push(`ועדה: ${decision.committee}`);
      if (decision.decisionDate) details.push(`תאריך: ${decision.decisionDate}`);

      const claimText = details.length > 0
        ? `החלטה ${index + 1}: ${details.join(', ')}`
        : `החלטה רלוונטית נמצאה: ${decision.title.substring(0, 80)}`;

      claims.push({
        text: claimText,
        citations: [index],
        confidence: (decision.relevanceScore || 0) > 0.6 ? 'confident' : 'uncertain'
      });
    });
  }

  return claims;
}

/**
 * Format a PDF excerpt for quotation in the answer.
 * Cleans up the text and adds proper Hebrew quotation marks.
 * @param excerpt - Raw excerpt from PDF
 * @param maxLength - Maximum length before truncation (default 500)
 * @returns Formatted excerpt with quotation marks
 */
function formatPdfExcerpt(excerpt: string, maxLength: number = 500): string {
  // Clean up the excerpt
  let cleaned = excerpt
    .replace(/\s+/g, ' ')           // Normalize whitespace
    .replace(/\n{3,}/g, '\n\n')     // Limit consecutive newlines
    .trim();

  // Truncate if needed, breaking at word boundary
  if (cleaned.length > maxLength) {
    const truncated = cleaned.substring(0, maxLength);
    const lastSpace = truncated.lastIndexOf(' ');
    cleaned = (lastSpace > maxLength * 0.8 ? truncated.substring(0, lastSpace) : truncated) + '...';
  }

  // Add Hebrew quotation marks (״...״) for Hebrew text, or standard for English
  const isHebrew = /[\u0590-\u05FF]/.test(cleaned);
  if (isHebrew) {
    return `״${cleaned}״`;
  }
  return `"${cleaned}"`;
}

/**
 * Extract key phrases from PDF excerpt that may answer the user's question.
 * Looks for monetary amounts, percentages, dates, and legal determinations.
 */
function extractKeyPhrasesFromExcerpt(excerpt: string): string[] {
  const phrases: string[] = [];

  // Extract monetary amounts (Israeli shekel patterns)
  const moneyMatches = excerpt.match(/[\d,]+\s*(?:ש"ח|שקל|₪|שקלים)/g);
  if (moneyMatches) phrases.push(...moneyMatches);

  // Extract percentages
  const percentMatches = excerpt.match(/\d+(?:\.\d+)?%/g);
  if (percentMatches) phrases.push(...percentMatches);

  // Extract dates (DD/MM/YYYY or DD.MM.YYYY patterns)
  const dateMatches = excerpt.match(/\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}/g);
  if (dateMatches) phrases.push(...dateMatches);

  // Extract legal determination keywords
  const determinationKeywords = [
    'נקבע כי', 'הוחלט', 'נדחה', 'התקבל',
    'הפיצוי', 'ההיטל', 'השומה', 'הערך'
  ];
  for (const keyword of determinationKeywords) {
    if (excerpt.includes(keyword)) {
      // Extract surrounding context (up to 100 chars after keyword)
      const index = excerpt.indexOf(keyword);
      const contextEnd = Math.min(index + 100, excerpt.length);
      const context = excerpt.substring(index, contextEnd);
      const endPunct = context.search(/[.!?]/);
      if (endPunct > 0) {
        phrases.push(context.substring(0, endPunct + 1));
      }
    }
  }

  return [...new Set(phrases)]; // Remove duplicates
}

// Handler for constructing answers with citations (US-006)
async function handleConstructAnswer(params: ConstructAnswerInput): Promise<MCPToolResult> {
  const { question, decisions, pdfExcerpts = [] } = params;

  // Handle no results case - PRD requirement: Warn when no relevant decisions found
  if (!decisions || decisions.length === 0) {
    const noResultsWarning = 'לא נמצאו החלטות רלוונטיות';
    const formattedNoResultsAnswer = `
## ⚠️ ${noResultsWarning}
No relevant decisions found.

---

### הצעות / Suggestions:

1. **חדד את החיפוש** / Refine your search:
   - נסה מונחים אחרים או ספציפיים יותר
   - Try different or more specific terms

2. **בדוק את המאגר** / Check the database:
   - האם המאגר הנכון נבחר? (שמאי מכריע / ועדת השגות / ועדת ערעורים)
   - Is the correct database selected? (decisive_appraiser / appeals_committee / appeals_board)

3. **הבהר את השאילתה** / Clarify the query:
   - הוסף פרטים כמו גוש/חלקה, עיר, או סוג תיק
   - Add details like block/plot, city, or case type

---

**רמת ביטחון / Confidence Level**: 🟡 ייתכן / Uncertain
`.trim();

    const result: ConstructAnswerResult = {
      formattedAnswer: formattedNoResultsAnswer,
      sources: [],
      claims: [],
      quotedExcerpts: [],
      overallConfidence: 'uncertain',
      confidenceIndicator: 'ייתכן',  // Uncertain when no results found
      noResultsWarning: noResultsWarning
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  }

  // Build sources array with inline citation indices [S0], [S1], etc.
  const sources: CitedSource[] = decisions.map((decision, index) => {
    // Find matching PDF excerpt if available
    const excerptMatch = pdfExcerpts.find(e => e.decisionId === decision.id);

    return {
      index,
      decisionId: decision.id,
      title: decision.title,
      pdfUrl: decision.url,
      database: decision.database,
      relevanceScore: decision.relevanceScore,
      excerpt: excerptMatch?.excerpt
    };
  });

  // Determine overall confidence based on:
  // - Number of results (more = more confident)
  // - Relevance scores (higher = more confident)
  // - Consistency of results (same database = more confident)
  let overallConfidence: ConfidenceLevel = 'uncertain';

  if (decisions.length >= 3) {
    // Multiple decisions support confidence
    const avgRelevance = decisions.reduce((sum, d) => sum + (d.relevanceScore || 0), 0) / decisions.length;
    if (avgRelevance > 0.5 || decisions.length >= 5) {
      overallConfidence = 'confident';
    }
  } else if (decisions.length >= 1) {
    // Single decision with high relevance
    const topRelevance = decisions[0].relevanceScore || 0;
    if (topRelevance > 0.8) {
      overallConfidence = 'confident';
    }
  }

  // Build formatted answer template with citation placeholders
  // Claude will use this structure to build actual answers
  const citationGuide = sources.map(s => `[S${s.index}]`).join(', ');

  // Build quoted excerpts from PDF content
  const quotedExcerpts: QuotedExcerpt[] = pdfExcerpts.map(({ decisionId, excerpt }) => {
    const sourceIndex = sources.findIndex(s => s.decisionId === decisionId);
    const keyPhrases = extractKeyPhrasesFromExcerpt(excerpt);

    return {
      sourceIndex: sourceIndex >= 0 ? sourceIndex : 0,
      decisionId,
      excerpt: formatPdfExcerpt(excerpt),
      context: keyPhrases.length > 0
        ? `נתונים מרכזיים: ${keyPhrases.slice(0, 3).join(', ')}`
        : undefined
    };
  });

  // Build quoted excerpts section for answer construction
  let quotedExcerptsSection = '';
  if (quotedExcerpts.length > 0) {
    const excerptItems = quotedExcerpts.map(qe => {
      const source = sources.find(s => s.decisionId === qe.decisionId);
      const sourceRef = qe.sourceIndex >= 0 ? `[S${qe.sourceIndex}]` : '';
      return `
### ציטוט מ-${sourceRef}
> ${qe.excerpt}

${qe.context ? `**${qe.context}**` : ''}
מקור: ${source?.title || qe.decisionId}`;
    }).join('\n\n');

    quotedExcerptsSection = `
## ציטוטים מתוך ה-PDF / Quoted Excerpts from PDF Content

השתמש בציטוטים הבאים בתשובתך כדי לבסס טענות:
Use these quotes in your answer to support claims:

${excerptItems}

---
`;
  }

  // Build detailed sources section with all required fields per PRD
  const sourcesSection = sources.map(s => {
    const relevancePercent = s.relevanceScore !== undefined
      ? `${Math.round(s.relevanceScore * 100)}%`
      : 'N/A';
    return `
**[S${s.index}]**
- מזהה / Decision ID: \`${s.decisionId}\`
- כותרת / Title: ${s.title}
- קישור ל-PDF / PDF URL: ${s.pdfUrl || 'לא זמין / Not available'}
- ציון רלוונטיות / Relevance Score: ${relevancePercent}${s.excerpt ? `
- ציטוט / Excerpt: ${formatPdfExcerpt(s.excerpt, 200)}` : ''}`;
  }).join('\n');

  // Build confidence indicator with explanation
  const confidenceIndicator = overallConfidence === 'confident'
    ? `**🟢 בטוח / Confident**
התשובה מבוססת על ${decisions.length} מקורות עם ציוני רלוונטיות גבוהים.
This answer is based on ${decisions.length} sources with high relevance scores.`
    : `**🟡 ייתכן / Uncertain**
התשובה מבוססת על ${decisions.length} מקור(ות) עם ציוני רלוונטיות בינוניים. מומלץ לבדוק את המקורות ישירות.
This answer is based on ${decisions.length} source(s) with moderate relevance. Recommend verifying sources directly.`;

  const formattedAnswer = `
## רמת ביטחון / Confidence Level

${confidenceIndicator}

---

## מבנה התשובה / Answer Structure

השתמש בציטוטים הבאים בתשובתך / Use these citations in your answer:
${citationGuide}

---
${quotedExcerptsSection}
## מקורות / Sources Section

${sourcesSection}

---

### הנחיות לבניית תשובה / Answer Construction Guidelines:
1. הצב ציטוט [S#] מיד אחרי כל טענה / Place [S#] citation immediately after each claim
2. **ציטוט ישיר מ-PDF**: ״...טקסט...״ [S#] / Direct quote from PDF: "...text..." [S#]
3. מספר מקורות לאותה טענה: [S0][S1] / Multiple sources for same claim: [S0][S1]
4. **ציין רמת ביטחון בתשובה**: פתח ב-"${overallConfidence === 'confident' ? 'בטוח' : 'ייתכן'}:" אם נדרש / **Indicate confidence in answer**: Start with "${overallConfidence === 'confident' ? 'Confident' : 'Uncertain'}:" if needed
5. ${quotedExcerpts.length > 0 ? `**חשוב**: השתמש בציטוטים מה-PDF לעיל כדי לבסס תשובות / **Important**: Use the PDF quotes above to support answers` : 'אם יש תוכן PDF, צטט את הטקסט הרלוונטי / If PDF content available, quote the relevant text'}
`.trim();

  // Generate claims from sources with citation mappings
  // Each claim links to the specific decision(s) that support it
  const claims: CitedClaim[] = generateClaimsFromSources(question, decisions, sources, pdfExcerpts);

  // Hebrew confidence label for direct use in responses
  const hebrewConfidenceLabel = overallConfidence === 'confident' ? 'בטוח' : 'ייתכן';

  const result: ConstructAnswerResult = {
    formattedAnswer,
    sources,
    claims,
    quotedExcerpts,
    overallConfidence,
    confidenceIndicator: hebrewConfidenceLabel
  };

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }]
  };
}

// Main server setup
async function main() {
  // Initialize database (graceful handling if unavailable)
  try {
    db = await getDatabase();
    console.error('[MCP Server] Database initialized successfully');
  } catch (error) {
    console.error('[MCP Server] WARNING: Database initialization failed:', error instanceof Error ? error.message : String(error));
    console.error('[MCP Server] Server will continue but database-dependent tools will return errors.');
    console.error('[MCP Server] Check that ~/.gov-il-mcp/ directory is accessible and has write permissions.');
    db = null;
  }

  // Try to initialize embeddings (optional)
  try {
    embeddings = await getEmbeddings();
    console.error('[MCP Server] Semantic search initialized');
  } catch (error) {
    console.error('[MCP Server] Semantic search not available:', error instanceof Error ? error.message : String(error));
    embeddings = null;
  }

  const server = new Server(
    {
      name: 'gov-il-land-appraisal',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // Handle tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'search_decisions':
          return await handleSearchDecisions(args as SearchParams);

        case 'get_decision':
          return await handleGetDecision(args as { id: string });

        case 'get_decision_pdf':
          return await handleGetDecisionPdf(args as { id: string });

        case 'read_pdf':
          return await handleReadPdf(args as { id: string; maxPages?: number });

        case 'get_statistics':
          return await handleGetStatistics();

        case 'list_committees':
          return await handleListCommittees(args as { limit?: number });

        case 'list_appraisers':
          return await handleListAppraisers(args as { limit?: number });

        case 'compare_decisions':
          return await handleCompareDecisions(args as { ids: string[] });

        case 'semantic_search':
          return await handleSemanticSearch(args as { query: string; limit?: number; database?: DatabaseType });

        case 'trigger_update':
          return await handleTriggerUpdate(args as { pagesToCheck?: number });

        case 'clarify_query':
          return await handleClarifyQuery(args as unknown as ClarifyQueryInput);

        case 'construct_answer':
          return await handleConstructAnswer(args as unknown as ConstructAnswerInput);

        case 'health_check':
          return await handleHealthCheck(args as { verbose?: boolean });

        default:
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: `Unknown tool: ${name}`,
                suggestion: 'Available tools: search_decisions, get_decision, get_decision_pdf, read_pdf, get_statistics, list_committees, list_appraisers, compare_decisions, semantic_search, trigger_update, clarify_query, construct_answer, health_check',
                suggestionHe: 'כלים זמינים: search_decisions, get_decision, get_decision_pdf, read_pdf, get_statistics, list_committees, list_appraisers, compare_decisions, semantic_search, trigger_update, clarify_query, construct_answer, health_check'
              })
            }],
            isError: true
          };
      }
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'Tool execution failed',
            tool: name,
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'An unexpected error occurred. Check that all required parameters are provided and in the correct format. For search_decisions, ensure dates are in YYYY-MM-DD format.',
            suggestionHe: 'אירעה שגיאה בלתי צפויה. ודא שכל הפרמטרים הנדרשים סופקו ובפורמט הנכון. עבור search_decisions, ודא שתאריכים בפורמט YYYY-MM-DD.'
          })
        }],
        isError: true
      };
    }
  });

  // Setup transport and start server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Cleanup on exit
  process.on('SIGINT', () => {
    closeDatabase();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    closeDatabase();
    process.exit(0);
  });

  console.error('Gov.il Land Appraisal MCP Server started');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
