import { NextRequest, NextResponse } from 'next/server';
import { getElasticClient, DECISIONS_INDEX, PARAMETERS_INDEX } from '@/lib/elasticsearch';
import { preprocessQuery } from '@/lib/query-preprocessor';
import { extractBatch, type AIExtractionResult, type ExtractedClaim } from '@/lib/ai-extractor';
import type { DatabaseType } from '@/types/api';

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

interface CompareRequest {
  query: string;
  committee?: string;
  limit?: number;
}

interface ClaimValue {
  display: string | null;
  numeric: number | null;
  unit: string | null;
  quote: string | null;
}

interface CompareRow {
  id: string;
  title: string;
  database: DatabaseType;
  committee: string | null;
  year: string | null;
  appraiser: string | null;
  url: string | null;
  partyA: ClaimValue;
  partyB: ClaimValue;
  ruling: ClaimValue;
}

interface CompareStats {
  count: number;
  avg: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

interface CompareResponse {
  rows: CompareRow[];
  total: number;
  committee: string | null;
  stats: CompareStats;
  /** What param_type was queried (null if AI extraction) */
  paramType: string | null;
  /** Human-readable label for the value column */
  valueLabel: string;
  /** Data source: 'parameters' or 'ai' */
  source: 'parameters' | 'ai';
}

// ──────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────

const MAX_COMPARE = 50;
/** Max docs to send to AI extraction (cost/speed control) */
const MAX_AI_DOCS = 20;
const PDF_TEXT_CAP = 35000;

// ──────────────────────────────────────────────────────────────────
// Query → param_type mapping (for parameters index path)
// ──────────────────────────────────────────────────────────────────

const SUBTYPE_NORMALIZATION: Record<string, string> = {
  'דחייה': 'דחי', 'דחיה': 'דחי',
  'שוליות': 'שולי',
  'התאמה': 'התאמ',
  'הפחתה': 'הפחת',
  'מיקום': 'מיקום',
  'מושעא': 'מוש', 'מושע': 'מוש',
  'מרתף': 'מרתף',
  'משוקלל': 'משוקלל',
  'קומה': 'קומ',
  'גודל': 'גודל',
  'ניצול': 'ניצול',
  'סחירות': 'סחיר',
  'בינוי': 'בינוי',
  'פיתוח': 'פיתוח',
  'היוון': 'היוון',
  'תחייה': 'תחיי',
};

interface QueryMapping {
  paramType: string;
  subtypePrefix: string | null;
  valueLabel: string;
}

function mapQueryToParamType(query: string): QueryMapping | null {
  if (query.includes('מקדם')) {
    const match = query.match(/מקדם\s+([\u0590-\u05FF]+)/);
    let prefix: string | null = null;
    let label = 'מקדם';
    if (match) {
      const coeffType = match[1];
      prefix = SUBTYPE_NORMALIZATION[coeffType] || coeffType.substring(0, 3);
      label = `מקדם ${coeffType}`;
    }
    return { paramType: 'coefficient', subtypePrefix: prefix, valueLabel: label };
  }
  if (query.includes('דמי סחירות')) {
    return { paramType: 'tradability_fee', subtypePrefix: null, valueLabel: 'דמי סחירות' };
  }
  if (query.includes('ריבון')) {
    return { paramType: 'sovereignty_rate', subtypePrefix: null, valueLabel: 'שיעור ריבונות' };
  }
  if (query.includes('למ"ר') || query.includes('למטר')) {
    return { paramType: 'price_per_meter', subtypePrefix: null, valueLabel: 'מחיר למ"ר' };
  }
  if (query.includes('לדונם')) {
    return { paramType: 'land_value', subtypePrefix: null, valueLabel: 'שווי לדונם' };
  }
  if (query.includes('זכויות בנייה') || query.includes('זכויות בניה')) {
    return { paramType: 'building_rights_value', subtypePrefix: null, valueLabel: 'שווי זכויות בנייה' };
  }
  if (query.includes('עסקאות השוואה') || query.includes('נתוני השוואה')) {
    return { paramType: 'comparison_transaction', subtypePrefix: null, valueLabel: 'עסקאות השוואה' };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// Stats
// ──────────────────────────────────────────────────────────────────

function calculateStats(values: (number | null)[]): CompareStats {
  const nums = values.filter((v): v is number => v !== null && !isNaN(v));
  if (nums.length === 0) {
    return { count: values.length, avg: null, median: null, min: null, max: null };
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((a, b) => a + b, 0);
  const avg = sum / nums.length;
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];

  return {
    count: values.length,
    avg: Math.round(avg * 1000) / 1000,
    median: Math.round(median * 1000) / 1000,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

// ──────────────────────────────────────────────────────────────────
// Main handler
// ──────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as CompareRequest;

    if (!body.query || body.query.trim().length === 0) {
      return NextResponse.json({ error: 'נדרשת שאילתת חיפוש' }, { status: 400 });
    }

    const limit = Math.min(body.limit ?? MAX_COMPARE, MAX_COMPARE);
    const es = getElasticClient();

    const preprocessed = preprocessQuery(body.query);
    const { detectedCities } = preprocessed;
    const committee = body.committee || (detectedCities.length > 0 ? detectedCities[0] : null);

    // Try parameters index first for structured queries (coefficients, prices)
    const mapping = mapQueryToParamType(body.query);
    if (mapping) {
      const result = await queryParametersIndex(es, mapping, committee, limit);
      if (result.rows.length >= 3) {
        const stats = calculateStats(result.rows.map(r => r.ruling.numeric));
        return NextResponse.json({
          rows: result.rows,
          total: result.rows.length,
          committee,
          stats,
          paramType: mapping.paramType,
          valueLabel: mapping.valueLabel,
          source: 'parameters',
        } satisfies CompareResponse);
      }
    }

    // Fall back to AI extraction — search for relevant documents, then extract with LLM
    const result = await aiExtractionPath(es, body.query, preprocessed, committee, limit);
    const rulingValues = result.rows.map(r => r.ruling.numeric);
    const stats = calculateStats(rulingValues);

    return NextResponse.json({
      rows: result.rows,
      total: result.rows.length,
      committee,
      stats,
      paramType: mapping?.paramType ?? null,
      valueLabel: mapping?.valueLabel ?? body.query.split(/\s+/).slice(0, 3).join(' '),
      source: 'ai',
    } satisfies CompareResponse);

  } catch (error) {
    console.error('[/api/compare] Error:', error);
    const message = error instanceof Error ? error.message : 'שגיאה בהשוואה';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ──────────────────────────────────────────────────────────────────
// Path A: Parameters index (coefficients, structured data)
// ──────────────────────────────────────────────────────────────────

async function queryParametersIndex(
  es: any,
  mapping: QueryMapping,
  committee: string | null,
  limit: number,
): Promise<{ rows: CompareRow[] }> {
  try {
    let decisionIds: string[] | null = null;
    if (committee) {
      const decSearch = await es.search({
        index: DECISIONS_INDEX,
        size: 500,
        _source: false,
        query: { bool: { filter: [{ match: { committee: { query: committee, operator: 'and' as const } } }] } },
      });
      decisionIds = (decSearch.hits.hits as any[]).map((h: any) => h._id);
      if (decisionIds.length === 0) return { rows: [] };
    }

    const must: object[] = [{ term: { param_type: mapping.paramType } }];
    if (mapping.subtypePrefix) {
      must.push({ prefix: { param_subtype: mapping.subtypePrefix } });
    }
    const filter: object[] = decisionIds ? [{ terms: { decision_id: decisionIds } }] : [];

    const paramsRes = await es.search({
      index: PARAMETERS_INDEX,
      query: { bool: { must, filter: filter.length > 0 ? filter : undefined } },
      size: Math.min(limit * 8, 1000),
      sort: [{ confidence: 'desc' }],
      _source: ['decision_id', 'param_subtype', 'value_numeric', 'value_text', 'unit', 'confidence', 'context_snippet'],
    });

    const paramHits = paramsRes.hits.hits as any[];
    if (paramHits.length === 0) return { rows: [] };

    // Group by decision — pick best value
    const byDecision = new Map<string, Record<string, unknown>>();
    for (const hit of paramHits) {
      const src = hit._source as Record<string, unknown>;
      const decId = src.decision_id as string;
      const value = src.value_numeric as number | null;
      const snippet = (src.context_snippet as string) || '';

      if (isNoise(value, snippet, mapping.paramType)) continue;

      const existing = byDecision.get(decId);
      if (!existing) {
        byDecision.set(decId, src);
      } else if (mapping.subtypePrefix) {
        const existingSnippet = (existing.context_snippet as string) || '';
        if (snippet.includes(mapping.subtypePrefix) && !existingSnippet.includes(mapping.subtypePrefix)) {
          byDecision.set(decId, src);
        }
      }
    }

    if (byDecision.size === 0) return { rows: [] };

    const matchedIds = [...byDecision.keys()].slice(0, limit);
    const metaRes = await es.mget({
      index: DECISIONS_INDEX,
      ids: matchedIds,
      _source_includes: ['title', 'database', 'committee', 'year', 'appraiser', 'url'],
    });

    const rows: CompareRow[] = [];
    const seenTitles = new Set<string>();

    for (const doc of metaRes.docs as any[]) {
      if (!doc.found) continue;
      const meta = doc._source as Record<string, unknown>;
      const title = (meta.title as string) || '';
      if (seenTitles.has(title)) continue;
      seenTitles.add(title);

      const param = byDecision.get(doc._id!);
      if (!param) continue;

      const valueNum = param.value_numeric as number | null;
      const valueText = param.value_text as string || null;
      const unit = param.unit as string || null;
      const context = param.context_snippet as string || null;

      let display: string | null = null;
      if (valueNum !== null && !isNaN(valueNum)) {
        display = valueNum.toLocaleString('he-IL');
        if (unit) display += ` ${unit}`;
      } else if (valueText) {
        display = valueText;
      }

      // Parameters index doesn't have partyA/partyB — put everything in ruling
      rows.push({
        id: doc._id!,
        title,
        database: (meta.database as DatabaseType) || 'decisive_appraiser',
        committee: (meta.committee as string) || null,
        year: (meta.year as string) || null,
        appraiser: (meta.appraiser as string) || null,
        url: (meta.url as string) || null,
        partyA: { display: null, numeric: null, unit: null, quote: null },
        partyB: { display: null, numeric: null, unit: null, quote: null },
        ruling: { display, numeric: valueNum ?? null, unit, quote: context },
      });

      if (rows.length >= limit) break;
    }

    return { rows };
  } catch (error) {
    console.error('[/api/compare] Parameters query failed:', error);
    return { rows: [] };
  }
}

function isNoise(value: number | null, snippet: string, paramType: string): boolean {
  if (value === null) return false;
  if (value > 0 && value <= 31 && /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(snippet)) return true;
  if (/גוש\s+\d|חלקה\s+\d/.test(snippet) && value > 1000 && paramType !== 'comparison_transaction') return true;
  if (paramType === 'coefficient' && (value <= 0 || value >= 10)) return true;
  if (paramType === 'price_per_meter' && value < 50) return true;
  return false;
}

// ──────────────────────────────────────────────────────────────────
// Path B: AI extraction (LLM reads the documents)
// ──────────────────────────────────────────────────────────────────

async function aiExtractionPath(
  es: any,
  originalQuery: string,
  preprocessed: ReturnType<typeof preprocessQuery>,
  committee: string | null,
  limit: number,
): Promise<{ rows: CompareRow[] }> {
  const { cleanedQuery, expandedTerms, detectedPhrases, detectedCities } = preprocessed;

  const textFields = ['pdf_text^3', 'title^2', 'committee', 'appraiser', 'case_type'];
  const shouldClauses: object[] = [];

  for (const phrase of detectedPhrases) {
    if (committee && detectedCities.includes(phrase)) continue;
    shouldClauses.push({
      multi_match: { query: phrase, fields: textFields, type: 'phrase', boost: 5 },
    });
  }

  let textQuery = cleanedQuery;
  if (committee) {
    textQuery = textQuery.replace(committee, '').replace(/\s+/g, ' ').trim();
  }

  if (textQuery.length > 0) {
    shouldClauses.push({
      multi_match: { query: textQuery, fields: textFields, type: 'best_fields', operator: 'and', boost: 3 },
    });
  }

  for (const term of expandedTerms) {
    shouldClauses.push({
      multi_match: { query: term, fields: textFields, type: 'phrase', boost: 0.5 },
    });
  }

  if (shouldClauses.length === 0) {
    shouldClauses.push({
      multi_match: { query: originalQuery, fields: textFields, type: 'best_fields', boost: 1 },
    });
  }

  const filterClauses: object[] = [];
  if (committee) {
    filterClauses.push({ match: { committee: { query: committee, operator: 'and' as const } } });
  }

  // Fetch top documents (metadata only first)
  const fetchSize = Math.min(limit, MAX_AI_DOCS);
  const searchRes = await es.search({
    index: DECISIONS_INDEX,
    size: fetchSize,
    _source: { excludes: ['pdf_text_embedding', 'pdf_text'] },
    query: {
      bool: {
        must: [{ bool: { should: shouldClauses, minimum_should_match: 1 } }],
        filter: filterClauses.length > 0 ? filterClauses : undefined,
      },
    },
  });

  const hits = searchRes.hits.hits as any[];
  if (hits.length === 0) return { rows: [] };

  // Fetch pdf_text for all hits
  const docIds = hits.map((h: any) => h._id as string);
  const mgetRes = await es.mget({
    index: DECISIONS_INDEX,
    ids: docIds,
    _source_includes: ['pdf_text'],
  });

  const pdfTexts = new Map<string, string>();
  for (const doc of mgetRes.docs as any[]) {
    if (doc.found && doc._source?.pdf_text) {
      pdfTexts.set(doc._id!, (doc._source.pdf_text as string).substring(0, PDF_TEXT_CAP));
    }
  }

  // Build documents array for AI extraction
  const docsForAI: { id: string; pdfText: string }[] = [];
  for (const id of docIds) {
    const text = pdfTexts.get(id);
    if (text && text.length > 500) { // Skip very short docs
      docsForAI.push({ id, pdfText: text });
    }
  }

  if (docsForAI.length === 0) return { rows: [] };

  // Extract with AI
  const searchTerm = textQuery || originalQuery;
  const extractions = await extractBatch(searchTerm, docsForAI);

  // Build rows — merge metadata + AI extraction
  const rows: CompareRow[] = [];
  const seenTitles = new Set<string>();

  for (const hit of hits) {
    const id = hit._id as string;
    const src = hit._source as Record<string, unknown>;
    const title = (src.title as string) || '';
    if (seenTitles.has(title)) continue;
    seenTitles.add(title);

    const extraction = extractions.get(id);
    if (!extraction || !extraction.hasData) continue;

    rows.push({
      id,
      title,
      database: (src.database as DatabaseType) || 'decisive_appraiser',
      committee: (src.committee as string) || null,
      year: (src.year as string) || null,
      appraiser: (src.appraiser as string) || null,
      url: (src.url as string) || null,
      partyA: claimToValue(extraction.partyA),
      partyB: claimToValue(extraction.partyB),
      ruling: claimToValue(extraction.ruling),
    });
  }

  return { rows };
}

function claimToValue(claim: ExtractedClaim): ClaimValue {
  return {
    display: claim.display,
    numeric: claim.numeric,
    unit: claim.unit,
    quote: claim.quote,
  };
}
