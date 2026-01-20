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

// Initialize database
let db: DecisionDatabase;
let embeddings: EmbeddingsManager | null = null;

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
    description: 'קבלת פרטי החלטה לפי מזהה / Get details of a specific decision by its ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'מזהה ההחלטה (ID) / The decision ID'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'get_decision_pdf',
    description: 'קבלת קישור ל-PDF של ההחלטה / Get the PDF URL for a specific decision. Use this to access the full decision document.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'מזהה ההחלטה (ID) / The decision ID'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'get_statistics',
    description: 'קבלת סטטיסטיקות על מאגר ההחלטות / Get statistics about the indexed decisions database',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'list_committees',
    description: 'רשימת כל הוועדות המקומיות במאגר / List all local committees (ועדות מקומיות) that have decisions in the database',
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
    description: 'רשימת כל השמאים במאגר / List all appraisers (שמאים) that have decisions in the database',
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
    description: 'השוואת מספר החלטות זו לזו / Compare multiple decisions side by side',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'רשימת מזהי החלטות להשוואה / Array of decision IDs to compare'
        }
      },
      required: ['ids']
    }
  },
  {
    name: 'semantic_search',
    description: 'חיפוש סמנטי בשפה טבעית באמצעות AI. מתאים לשאילתות מושגיות כמו "פיצויים על הפקעת קרקע ליד תל אביב" / Search for decisions using natural language and AI embeddings. Better for conceptual queries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'שאילתת חיפוש בשפה טבעית / Natural language search query'
        },
        limit: {
          type: 'number',
          description: 'מספר תוצאות מקסימלי (ברירת מחדל: 20) / Maximum number of results',
          default: 20
        },
        database: {
          type: 'string',
          enum: ['decisive_appraiser', 'appeals_committee', 'appeals_board'],
          description: 'סינון לפי מאגר מסוים / Filter by specific database: decisive_appraiser=שמאי מכריע, appeals_committee=ועדת השגות, appeals_board=ועדת ערעורים'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'trigger_update',
    description: 'הפעלת עדכון לשליפת החלטות חדשות מ-gov.il. דורש הגדרת SCRAPER_API_KEY / Trigger an update to fetch new decisions from gov.il. Requires SCRAPER_API_KEY environment variable.',
    inputSchema: {
      type: 'object',
      properties: {
        pagesToCheck: {
          type: 'number',
          description: 'מספר עמודים אחרונים לבדוק להחלטות חדשות (ברירת מחדל: 5) / Number of recent pages to check for new decisions',
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
  }
];

// Tool handlers
async function handleSearchDecisions(params: SearchParams): Promise<MCPToolResult> {
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
  const result = db.search(searchParams);

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
  const decision = db.getDecision(params.id);

  if (!decision) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: 'Decision not found', id: params.id })
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
  const decision = db.getDecision(params.id);

  if (!decision) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: 'Decision not found', id: params.id })
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
          title: decision.title
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

async function handleGetStatistics(): Promise<MCPToolResult> {
  const stats = db.getStats();

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
        lastIndexedAt: stats.lastIndexedAt,
        lastUpdateAt: stats.lastUpdateAt
      }, null, 2)
    }]
  };
}

async function handleListCommittees(params: { limit?: number }): Promise<MCPToolResult> {
  const committees = db.getDistinctValues('committee', params.limit || 100);

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
  const appraisers = db.getDistinctValues('appraiser', params.limit || 100);

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
  const decisions = params.ids.map(id => db.getDecision(id)).filter(d => d !== null);

  if (decisions.length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: 'No valid decisions found for the provided IDs' })
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
          message: error instanceof Error ? error.message : String(error)
        })
      }],
      isError: true
    };
  }
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

  // Handle no results case
  if (!decisions || decisions.length === 0) {
    const result: ConstructAnswerResult = {
      formattedAnswer: '',
      sources: [],
      claims: [],
      quotedExcerpts: [],
      overallConfidence: 'uncertain',
      noResultsWarning: 'לא נמצאו החלטות רלוונטיות לשאילתה זו. נסה לחדד את החיפוש, לבחור מאגר אחר, או להבהיר את השאילתה.'
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

  const formattedAnswer = `
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
4. ציין רמת ביטחון: ${overallConfidence === 'confident' ? 'בטוח' : 'ייתכן'} / Confidence: ${overallConfidence === 'confident' ? 'confident' : 'uncertain'}
5. ${quotedExcerpts.length > 0 ? `**חשוב**: השתמש בציטוטים מה-PDF לעיל כדי לבסס תשובות / **Important**: Use the PDF quotes above to support answers` : 'אם יש תוכן PDF, צטט את הטקסט הרלוונטי / If PDF content available, quote the relevant text'}
`.trim();

  // Generate claims from sources with citation mappings
  // Each claim links to the specific decision(s) that support it
  const claims: CitedClaim[] = generateClaimsFromSources(question, decisions, sources, pdfExcerpts);

  const result: ConstructAnswerResult = {
    formattedAnswer,
    sources,
    claims,
    quotedExcerpts,
    overallConfidence
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
  // Initialize database
  db = await getDatabase();
  console.error('Database initialized');

  // Try to initialize embeddings (optional)
  try {
    embeddings = await getEmbeddings();
    console.error('Semantic search initialized');
  } catch (error) {
    console.error('Semantic search not available:', error);
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
          return await handleClarifyQuery(args as ClarifyQueryInput);

        case 'construct_answer':
          return await handleConstructAnswer(args as ConstructAnswerInput);

        default:
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: `Unknown tool: ${name}` })
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
            message: error instanceof Error ? error.message : String(error)
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
