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
  MCPToolResult
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
היטל השבחה, פיצויים, ירידת ערך, הפקעה, תכנית מתאר, שינוי ייעוד, היתר בניה, תמ"א 38, פינוי בינוי, תב"ע

## חשוב / Important Guidelines
- Extract ONLY parameters the user explicitly mentioned
- Don't invent block/plot numbers if not stated
- Don't assume database if no keywords match the table above
- For date ranges, convert Hebrew years (תשפ"ד = 2024) to Gregorian

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
