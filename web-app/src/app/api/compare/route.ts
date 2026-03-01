import { NextRequest, NextResponse } from 'next/server';
import { getElasticClient, DECISIONS_INDEX, PARAMETERS_INDEX } from '@/lib/elasticsearch';
import { generateQueryEmbedding } from '@/lib/embeddings';
import { preprocessQuery } from '@/lib/query-preprocessor';
import { extractSections, getSearchTermValue, extractValueFromFullText, formatExtractedValue, getPageNumber } from '@/lib/section-extractor';
import type { DatabaseType } from '@/types/api';

interface CompareRequest {
  query: string;
  committee?: string;
  limit?: number;
}

interface ValueWithContext {
  display: string | null;
  numeric: number | null;
  context: string | null;
  page: number | null;
}

interface CompareRow {
  id: string;
  title: string;
  database: DatabaseType;
  committee: string | null;
  year: string | null;
  appraiser: string | null;
  url: string | null;
  partyA: ValueWithContext;
  partyB: ValueWithContext;
  ruling: ValueWithContext;
}

interface CompareStats {
  count: number;
  avg: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

/** Query type detection for parameters index and dynamic columns */
interface QueryTypeInfo {
  paramType: string | null;
  subtypePrefix: string | null;
  columnType: 'coefficient' | 'price' | 'transaction' | 'general';
}

interface CompareResponse {
  rows: CompareRow[];
  total: number;
  committee: string | null;
  stats: CompareStats;
  queryType: QueryTypeInfo;
  /** Source of data: 'parameters' = from decision_parameters index, 'extraction' = on-the-fly regex */
  source: 'parameters' | 'extraction';
}

const MAX_COMPARE = 50;
const PDF_TEXT_CAP = 50000;

/** Normalize param_subtype variants to a canonical prefix for querying */
const SUBTYPE_NORMALIZATION: Record<string, string> = {
  'דחייה': 'דחי',
  'דחיה': 'דחי',
  'דחייה של': 'דחי',
  'דחיה של': 'דחי',
  'שוליות': 'שולי',
  'שוליות של': 'שולי',
  'התאמה': 'התאמ',
  'התאמה של': 'התאמ',
  'הפחתה': 'הפחת',
  'הפחתה של': 'הפחת',
  'מיקום': 'מיקום',
  'מושעא': 'מוש',
  'מושע': 'מוש',
  'מרתף': 'מרתף',
  'משוקלל': 'משוקלל',
  'קומה': 'קומ',
  'גודל': 'גודל',
  'ניצול': 'ניצול',
  'סחירות': 'סחיר',
  'בינוי': 'בינוי',
  'פיתוח': 'פיתוח',
};

/** Detect query type from search terms */
function detectQueryType(query: string): QueryTypeInfo {
  // Coefficients
  if (query.includes('מקדם')) {
    // Extract the specific coefficient type
    const match = query.match(/מקדם\s+([\u0590-\u05FF]+)/);
    if (match) {
      const coeffType = match[1];
      // Try to normalize to a prefix
      const prefix = SUBTYPE_NORMALIZATION[coeffType] || coeffType.substring(0, 3);
      return { paramType: 'coefficient', subtypePrefix: prefix, columnType: 'coefficient' };
    }
    return { paramType: 'coefficient', subtypePrefix: null, columnType: 'coefficient' };
  }

  // Prices
  if (query.includes('למ"ר') || query.includes('למטר') || query.includes('שווי') && query.includes('מ"ר')) {
    return { paramType: 'price_per_meter', subtypePrefix: null, columnType: 'price' };
  }
  if (query.includes('לדונם') || query.includes('שווי') && query.includes('דונם')) {
    return { paramType: 'land_value', subtypePrefix: null, columnType: 'price' };
  }
  if (query.includes('מחיר') || query.includes('שווי') || query.includes('ערך')) {
    return { paramType: 'price_per_meter', subtypePrefix: null, columnType: 'price' };
  }

  // Betterment levy / compensation (monetary amounts)
  if (query.includes('היטל')) {
    return { paramType: null, subtypePrefix: null, columnType: 'price' };
  }
  if (query.includes('פיצוי')) {
    return { paramType: null, subtypePrefix: null, columnType: 'price' };
  }

  // Transactions
  if (query.includes('עסקאות השוואה') || query.includes('נתוני השוואה')) {
    return { paramType: 'comparison_transaction', subtypePrefix: null, columnType: 'transaction' };
  }

  return { paramType: null, subtypePrefix: null, columnType: 'general' };
}

/** Calculate statistics from numeric ruling values */
function calculateStats(rows: CompareRow[]): CompareStats {
  const values = rows
    .map(r => r.ruling.numeric)
    .filter((v): v is number => v !== null && !isNaN(v));

  if (values.length === 0) {
    return { count: rows.length, avg: null, median: null, min: null, max: null };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const avg = sum / values.length;
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];

  return {
    count: rows.length,
    avg: Math.round(avg * 1000) / 1000,
    median: Math.round(median * 1000) / 1000,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as CompareRequest;

    if (!body.query || body.query.trim().length === 0) {
      return NextResponse.json({ error: 'נדרשת שאילתת חיפוש' }, { status: 400 });
    }

    const limit = Math.min(body.limit ?? MAX_COMPARE, MAX_COMPARE);
    const es = getElasticClient();

    // Preprocess query
    const preprocessed = preprocessQuery(body.query);
    const { cleanedQuery, expandedTerms, detectedPhrases, detectedCities } = preprocessed;

    // Determine committee: explicit param > auto-detected from query
    const committee = body.committee || (detectedCities.length > 0 ? detectedCities[0] : null);

    // Detect query type for parameters index and dynamic columns
    const queryType = detectQueryType(body.query);

    // Build committee filter clause (reused in both paths)
    const committeeFilter = committee
      ? [{ match: { committee: { query: committee, operator: 'and' as const } } }]
      : [];

    // Try parameters index first for typed queries (coefficient, price_per_meter, etc.)
    if (queryType.paramType && ['coefficient', 'price_per_meter', 'land_value'].includes(queryType.paramType)) {
      const paramsResult = await tryParametersIndex(es, queryType, committeeFilter, limit);
      if (paramsResult && paramsResult.rows.length >= 5) {
        const stats = calculateStats(paramsResult.rows);
        return NextResponse.json({
          rows: paramsResult.rows,
          total: paramsResult.rows.length,
          committee,
          stats,
          queryType,
          source: 'parameters',
        } satisfies CompareResponse);
      }
    }

    // Fall back to on-the-fly extraction
    // Build query for compare: when committee detected, use filter (strict) instead of boost
    const textFields = ['pdf_text^3', 'title^2', 'committee', 'appraiser', 'case_type'];
    const shouldClauses: object[] = [];

    // Exact phrase matches
    for (const phrase of detectedPhrases) {
      // Skip city phrases from text query — they're handled by the filter
      if (committee && detectedCities.includes(phrase)) continue;
      shouldClauses.push({
        multi_match: { query: phrase, fields: textFields, type: 'phrase', boost: 5 },
      });
    }

    // Build cleanedQuery without city for text matching (avoid double-matching)
    let textQuery = cleanedQuery;
    if (committee) {
      textQuery = textQuery.replace(committee, '').replace(/\s+/g, ' ').trim();
    }

    if (textQuery.length > 0) {
      shouldClauses.push({
        multi_match: { query: textQuery, fields: textFields, type: 'best_fields', operator: 'and', boost: 3 },
      });
      shouldClauses.push({
        multi_match: { query: textQuery, fields: textFields, type: 'best_fields', minimum_should_match: '2<-1', boost: 1 },
      });
    }

    for (const term of expandedTerms) {
      shouldClauses.push({
        multi_match: { query: term, fields: textFields, type: 'phrase', boost: 0.5 },
      });
    }

    // Build filter clauses
    const filterClauses: object[] = [...committeeFilter];

    const bm25Query = {
      bool: {
        must: [{ bool: { should: shouldClauses, minimum_should_match: 1 } }],
        filter: filterClauses.length > 0 ? filterClauses : undefined,
      },
    };

    // Generate embedding for hybrid search
    const embedding = await generateQueryEmbedding(body.query);

    // Fetch IDs + metadata (no pdf_text yet)
    const fetchSize = Math.min(Math.ceil(limit * 1.5), 75);

    const searchParams: Record<string, unknown> = {
      index: DECISIONS_INDEX,
      size: fetchSize,
      _source: { excludes: ['pdf_text_embedding', 'pdf_text'] },
    };

    if (embedding) {
      searchParams.retriever = {
        rrf: {
          retrievers: [
            { standard: { query: bm25Query } },
            {
              knn: {
                field: 'pdf_text_embedding',
                query_vector: embedding,
                k: fetchSize,
                num_candidates: 200,
                filter: filterClauses.length > 0 ? { bool: { filter: filterClauses } } : undefined,
              },
            },
          ],
          rank_window_size: 100,
          rank_constant: 60,
        },
      };
    } else {
      searchParams.query = bm25Query;
    }

    const searchResponse = await es.search(searchParams as any);
    const hits = searchResponse.hits.hits as any[];

    if (hits.length === 0) {
      return NextResponse.json({
        rows: [],
        total: 0,
        committee,
        stats: { count: 0, avg: null, median: null, min: null, max: null },
        queryType,
        source: 'extraction',
      } satisfies CompareResponse);
    }

    // Bulk fetch pdf_text for all hits via _mget
    const docIds = hits.map((h: any) => h._id as string);
    const mgetResponse = await es.mget({
      index: DECISIONS_INDEX,
      ids: docIds,
      _source_includes: ['pdf_text'],
    });

    // Build map of id → pdf_text
    const pdfTexts = new Map<string, string>();
    for (const doc of mgetResponse.docs as any[]) {
      if (doc.found && doc._source?.pdf_text) {
        const text = doc._source.pdf_text as string;
        pdfTexts.set(doc._id!, text.substring(0, PDF_TEXT_CAP));
      }
    }

    // Extract sections server-side and build rows
    const rows: CompareRow[] = [];
    const seenIds = new Set<string>();
    const seenTitles = new Set<string>();

    for (const hit of hits) {
      const id = hit._id as string;
      if (seenIds.has(id)) continue; // Deduplicate (RRF can return same doc from both retrievers)
      seenIds.add(id);
      const title = ((hit._source as Record<string, unknown>).title as string) || '';
      if (seenTitles.has(title)) continue; // Deduplicate same decision indexed twice
      seenTitles.add(title);
      const src = hit._source as Record<string, unknown>;
      const pdfText = pdfTexts.get(id);
      if (!pdfText) continue;

      const pdfLength = pdfText.length;
      const extraction = extractSections(id, pdfText, textQuery || body.query);

      // For typed queries (coefficient, price), extract all columns.
      // For general/unknown queries, only extract ruling — partyA/partyB
      // are unreliable without a known value type and show random garbage.
      const isTypedQuery = queryType.columnType !== 'general';
      const partyAVal = isTypedQuery ? getSearchTermValue(extraction.partyA, textQuery) : null;
      const partyBVal = isTypedQuery ? getSearchTermValue(extraction.partyB, textQuery) : null;
      let rulingVal = getSearchTermValue(extraction.ruling, textQuery);

      // When section-specific extraction yields nothing, try extracting
      // values directly from the full text near the search term
      if (!partyAVal && !partyBVal && !rulingVal && textQuery) {
        const fullTextVal = extractValueFromFullText(pdfText, textQuery);
        if (fullTextVal) {
          rulingVal = fullTextVal;
        }
      }

      // Keep rows with at least one value
      if (!partyAVal && !partyBVal && !rulingVal) continue;

      rows.push({
        id,
        title: (src.title as string) || '',
        database: src.database as DatabaseType,
        committee: (src.committee as string) || null,
        year: (src.year as string) || null,
        appraiser: (src.appraiser as string) || null,
        url: (src.url as string) || null,
        partyA: {
          display: partyAVal ? formatExtractedValue(partyAVal) : null,
          numeric: partyAVal?.numeric ?? null,
          context: partyAVal?.context ?? null,
          page: partyAVal?.charIndex != null ? getPageNumber(partyAVal.charIndex, pdfLength) : null,
        },
        partyB: {
          display: partyBVal ? formatExtractedValue(partyBVal) : null,
          numeric: partyBVal?.numeric ?? null,
          context: partyBVal?.context ?? null,
          page: partyBVal?.charIndex != null ? getPageNumber(partyBVal.charIndex, pdfLength) : null,
        },
        ruling: {
          display: rulingVal ? formatExtractedValue(rulingVal) : null,
          numeric: rulingVal?.numeric ?? null,
          context: rulingVal?.context ?? null,
          page: rulingVal?.charIndex != null ? getPageNumber(rulingVal.charIndex, pdfLength) : null,
        },
      });

      if (rows.length >= limit) break;
    }

    const stats = calculateStats(rows);

    const response: CompareResponse = {
      rows,
      total: rows.length,
      committee,
      stats,
      queryType,
      source: 'extraction',
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('[/api/compare] Error:', error);
    const message = error instanceof Error ? error.message : 'שגיאה בהשוואה';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Try to fetch comparison data from the decision_parameters index.
 * Returns null if not enough data or query type doesn't match.
 */
async function tryParametersIndex(
  es: any,
  queryType: QueryTypeInfo,
  committeeFilter: object[],
  limit: number
): Promise<{ rows: CompareRow[] } | null> {
  try {
    // Build parameters query
    const paramsMust: object[] = [
      { term: { param_type: queryType.paramType } },
    ];

    if (queryType.subtypePrefix) {
      paramsMust.push({ prefix: { param_subtype: queryType.subtypePrefix } });
    }

    // First, get decision IDs that match the committee filter
    let decisionIds: string[] | null = null;
    if (committeeFilter.length > 0) {
      const decisionSearch = await es.search({
        index: DECISIONS_INDEX,
        size: 200,
        _source: false,
        query: { bool: { filter: committeeFilter } },
      });
      decisionIds = (decisionSearch.hits.hits as any[]).map((h: any) => h._id);
      if (decisionIds.length === 0) return null;
    }

    // Query parameters index
    const paramsQuery: any = {
      bool: {
        must: paramsMust,
        ...(decisionIds ? { filter: [{ terms: { decision_id: decisionIds } }] } : {}),
      },
    };

    const paramsResponse = await es.search({
      index: PARAMETERS_INDEX,
      query: paramsQuery,
      size: Math.min(limit * 3, 200), // Fetch extra to account for grouping
      sort: [{ confidence: 'desc' }],
      _source: ['decision_id', 'param_subtype', 'value_numeric', 'value_text', 'unit', 'confidence', 'context_snippet'],
    });

    const paramHits = paramsResponse.hits.hits as any[];
    if (paramHits.length === 0) return null;

    // Group by decision_id, take highest-confidence value per decision
    const byDecision = new Map<string, any>();
    for (const hit of paramHits) {
      const src = hit._source as Record<string, unknown>;
      const decId = src.decision_id as string;
      if (!byDecision.has(decId)) {
        byDecision.set(decId, src);
      }
    }

    if (byDecision.size === 0) return null;

    // Fetch decision metadata for all matched decisions
    const matchedIds = [...byDecision.keys()].slice(0, limit);
    const metaResponse = await es.mget({
      index: DECISIONS_INDEX,
      ids: matchedIds,
      _source_includes: ['title', 'database', 'committee', 'year', 'appraiser', 'url'],
    });

    const rows: CompareRow[] = [];
    const seenTitles = new Set<string>();

    for (const doc of metaResponse.docs as any[]) {
      if (!doc.found) continue;
      const meta = doc._source as Record<string, unknown>;
      const title = (meta.title as string) || '';
      if (seenTitles.has(title)) continue;
      seenTitles.add(title);

      const param = byDecision.get(doc._id!);
      if (!param) continue;

      const valueNumeric = param.value_numeric as number | null;
      const valueText = param.value_text as string || null;
      const contextSnippet = param.context_snippet as string || null;

      let display: string | null = null;
      if (valueNumeric !== null && !isNaN(valueNumeric)) {
        display = valueNumeric.toLocaleString('he-IL');
      } else if (valueText) {
        display = valueText;
      }

      rows.push({
        id: doc._id!,
        title,
        database: (meta.database as DatabaseType) || 'decisive_appraiser',
        committee: (meta.committee as string) || null,
        year: (meta.year as string) || null,
        appraiser: (meta.appraiser as string) || null,
        url: (meta.url as string) || null,
        partyA: { display: null, numeric: null, context: null, page: null },
        partyB: { display: null, numeric: null, context: null, page: null },
        ruling: {
          display,
          numeric: valueNumeric ?? null,
          context: contextSnippet,
          page: null,
        },
      });

      if (rows.length >= limit) break;
    }

    return { rows };
  } catch (error) {
    console.error('[/api/compare] Parameters index query failed:', error);
    return null;
  }
}
