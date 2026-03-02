import { NextRequest, NextResponse } from 'next/server';
import { getElasticClient, DECISIONS_INDEX, PARAMETERS_INDEX } from '@/lib/elasticsearch';
import { preprocessQuery } from '@/lib/query-preprocessor';
import { extractBatch, type ColumnDef, type ExtractionResult, type ExtractedValue } from '@/lib/ai-extractor';
import type { DatabaseType } from '@/types/api';

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

interface CompareRequest {
  query: string;
  committee?: string;
  limit?: number;
  /** Pre-fetched result IDs from main search — skips re-searching */
  resultIds?: string[];
  /** Custom columns — overrides auto-detected preset */
  columns?: ColumnDef[];
}

interface ClaimValue {
  display: string | null;
  numeric: number | null;
  unit: string | null;
  quote: string | null;
}

/** Row with dynamic values keyed by column key */
interface CompareRow {
  id: string;
  title: string;
  database: DatabaseType;
  committee: string | null;
  year: string | null;
  appraiser: string | null;
  url: string | null;
  /** Dynamic values keyed by column key */
  values: Record<string, ClaimValue>;
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
  /** Columns used for extraction — UI renders from this */
  columns: ColumnDef[];
  /** What param_type was queried (null if AI extraction) */
  paramType: string | null;
  /** Human-readable label for the value column */
  valueLabel: string;
  /** Data source: 'parameters' or 'ai' */
  source: 'parameters' | 'ai';
}

// ──────────────────────────────────────────────────────────────────
// Column presets per query type
// ──────────────────────────────────────────────────────────────────

const COLUMN_PRESETS: Record<string, ColumnDef[]> = {
  dispute: [
    { key: 'partyA', label: 'טענת צד א׳', prompt: 'מה הסכום או הערך שצד א (המבקש/הבעלים/המערער) טוען? חפש ב"טענות המבקש" או "שומת הבעלים".' },
    { key: 'partyB', label: 'טענת צד ב׳', prompt: 'מה הסכום או הערך שצד ב (המשיבה/הוועדה) טוען? חפש ב"טענות המשיבה" או "שומת הוועדה".' },
    { key: 'ruling', label: 'הכרעה', prompt: 'מה ההכרעה הסופית של השמאי/הוועדה? חפש ב"הכרעה", "קביעה", "סיכום".' },
  ],
  betterment: [
    { key: 'ownerValue', label: 'שומת הבעלים', prompt: 'מה שווי הנכס לפי שומת הבעלים (המבקש)? חפש ב"טענות המבקש" או "שומת הבעלים".' },
    { key: 'committeeValue', label: 'שומת הוועדה', prompt: 'מה שווי הנכס לפי שומת הוועדה (המשיבה)? חפש ב"טענות המשיבה" או "שומת הוועדה".' },
    { key: 'ruling', label: 'הכרעה', prompt: 'מה ההכרעה הסופית של השמאי המכריע? חפש ב"הכרעה", "קביעה".' },
  ],
  landValue: [
    { key: 'valueBefore', label: 'שווי לפני', prompt: 'מה שווי הקרקע/הנכס לפני התכנית (מצב קודם)? חפש "שווי במצב קודם" או "שווי לפני".' },
    { key: 'valueAfter', label: 'שווי אחרי', prompt: 'מה שווי הקרקע/הנכס אחרי התכנית (מצב חדש/מאושר)? חפש "שווי במצב חדש" או "שווי אחרי".' },
    { key: 'ruling', label: 'הכרעה', prompt: 'מה ההכרעה הסופית — שווי הקרקע שנקבע? חפש ב"הכרעה", "קביעה".' },
  ],
  pricePerMeter: [
    { key: 'partyA', label: 'שווי למ"ר צד א׳', prompt: 'מה המחיר למ"ר לפי צד א (המבקש/הבעלים)?' },
    { key: 'partyB', label: 'שווי למ"ר צד ב׳', prompt: 'מה המחיר למ"ר לפי צד ב (המשיבה/הוועדה)?' },
    { key: 'ruling', label: 'הכרעה', prompt: 'מה המחיר למ"ר שנקבע בהכרעה?' },
  ],
  compensation: [
    { key: 'claimedAmount', label: 'סכום נתבע', prompt: 'מה סכום הפיצוי שנתבע (נדרש) על ידי המבקש?' },
    { key: 'offeredAmount', label: 'סכום מוצע', prompt: 'מה סכום הפיצוי שהוצע על ידי המשיבה/הוועדה?' },
    { key: 'ruling', label: 'הכרעה', prompt: 'מה סכום הפיצוי שנפסק בהכרעה?' },
  ],
  transactions: [
    { key: 'location', label: 'מיקום', prompt: 'מהו מיקום עסקת ההשוואה? רחוב, שכונה או עיר.' },
    { key: 'price', label: 'מחיר', prompt: 'מהו המחיר/שווי של עסקת ההשוואה?' },
    { key: 'date', label: 'תאריך', prompt: 'מה תאריך עסקת ההשוואה?' },
  ],
};

/** Detect which column preset fits the query */
function detectPreset(query: string): string {
  if (query.includes('היטל') || query.includes('השבחה')) return 'betterment';
  if (query.includes('פיצוי') || query.includes('ירידת ערך')) return 'compensation';
  if (query.includes('עסקאות השוואה') || query.includes('נתוני השוואה')) return 'transactions';
  if (query.includes('למ"ר') || query.includes('למטר') || query.includes('מחיר למ')) return 'pricePerMeter';
  if (query.includes('שווי קרקע') || query.includes('לדונם') || query.includes('שווי') || query.includes('ערך')) return 'landValue';
  return 'dispute';
}

// ──────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────

const MAX_COMPARE = 50;
const MAX_AI_DOCS = 40;
const PDF_TEXT_CAP = 80000;

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
  if (query.includes('לדונם') || query.includes('שווי קרקע') || query.includes('מחיר קרקע')) {
    return { paramType: 'land_value', subtypePrefix: null, valueLabel: 'שווי קרקע' };
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
// Year detection
// ──────────────────────────────────────────────────────────────────

function detectYear(query: string): string | null {
  const match = query.match(/\b(20[0-2]\d)\b/);
  return match ? match[1] : null;
}

function stripYear(query: string, year: string): string {
  return query.replace(year, '').replace(/\s+/g, ' ').trim();
}

// ──────────────────────────────────────────────────────────────────
// Stats — calculated on the last column (usually ruling/הכרעה)
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
    const year = detectYear(body.query);

    // Determine columns — custom from UI, or auto-detect preset
    const presetName = detectPreset(body.query);
    const columns: ColumnDef[] = body.columns ?? COLUMN_PRESETS[presetName] ?? COLUMN_PRESETS.dispute;

    // Try parameters index for coefficients (structured, no AI needed)
    const mapping = mapQueryToParamType(body.query);
    if (mapping && mapping.paramType === 'coefficient') {
      const result = await queryParametersIndex(es, mapping, committee, year, limit, body.resultIds);
      if (result.rows.length >= 3) {
        // Parameters path — single value column mapped to "ruling" key
        const paramColumn: ColumnDef = { key: 'value', label: mapping.valueLabel, prompt: '' };
        const statsValues = result.rows.map(r => r.values['value']?.numeric ?? null);
        const stats = calculateStats(statsValues);
        return NextResponse.json({
          rows: result.rows,
          total: result.rows.length,
          committee,
          stats,
          columns: [paramColumn],
          paramType: mapping.paramType,
          valueLabel: mapping.valueLabel,
          source: 'parameters',
        } satisfies CompareResponse);
      }
    }

    // AI extraction path
    const result = await aiExtractionPath(es, body.query, preprocessed, committee, year, limit, columns, body.resultIds);
    // Stats on the last column (usually ruling/הכרעה)
    const lastColKey = columns[columns.length - 1].key;
    const statsValues = result.rows.map(r => r.values[lastColKey]?.numeric ?? null);
    const stats = calculateStats(statsValues);

    return NextResponse.json({
      rows: result.rows,
      total: result.rows.length,
      committee,
      stats,
      columns,
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
  year: string | null,
  limit: number,
  resultIds?: string[],
): Promise<{ rows: CompareRow[] }> {
  try {
    let decisionIds: string[] | null = resultIds?.length ? resultIds : null;
    if (!decisionIds && (committee || year)) {
      const decFilter: object[] = [];
      if (committee) decFilter.push({ match: { committee: { query: committee, operator: 'and' as const } } });
      if (year) decFilter.push({ term: { year } });
      const decSearch = await es.search({
        index: DECISIONS_INDEX,
        size: 1000,
        _source: false,
        query: { bool: { filter: decFilter } },
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

      rows.push({
        id: doc._id!,
        title,
        database: (meta.database as DatabaseType) || 'decisive_appraiser',
        committee: (meta.committee as string) || null,
        year: (meta.year as string) || null,
        appraiser: (meta.appraiser as string) || null,
        url: (meta.url as string) || null,
        values: {
          value: { display, numeric: valueNum ?? null, unit, quote: context },
        },
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
  year: string | null,
  limit: number,
  columns: ColumnDef[],
  resultIds?: string[],
): Promise<{ rows: CompareRow[] }> {
  const { cleanedQuery, expandedTerms, detectedPhrases, detectedCities } = preprocessed;

  // Build search term for AI (strip city + year)
  let textQuery = cleanedQuery;
  if (committee) {
    textQuery = textQuery.replace(committee, '').replace(/\s+/g, ' ').trim();
  }
  if (year) {
    textQuery = stripYear(textQuery, year);
  }

  let docIds: string[];
  let metadataMap: Map<string, Record<string, unknown>>;

  if (resultIds && resultIds.length > 0) {
    docIds = resultIds.slice(0, limit);

    const metaRes = await es.mget({
      index: DECISIONS_INDEX,
      ids: docIds,
      _source_includes: ['title', 'database', 'committee', 'year', 'appraiser', 'url'],
    });
    metadataMap = new Map();
    for (const doc of metaRes.docs as any[]) {
      if (doc.found) metadataMap.set(doc._id!, doc._source as Record<string, unknown>);
    }
  } else {
    const textFields = ['pdf_text^3', 'title^2', 'committee', 'appraiser', 'case_type'];
    const shouldClauses: object[] = [];

    for (const phrase of detectedPhrases) {
      if (committee && detectedCities.includes(phrase)) continue;
      shouldClauses.push({
        multi_match: { query: phrase, fields: textFields, type: 'phrase', boost: 5 },
      });
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
    if (committee) filterClauses.push({ match: { committee: { query: committee, operator: 'and' as const } } });
    if (year) filterClauses.push({ term: { year } });

    const fetchSize = Math.min(limit, MAX_AI_DOCS);
    const searchRes = await es.search({
      index: DECISIONS_INDEX,
      size: fetchSize,
      _source: ['title', 'database', 'committee', 'year', 'appraiser', 'url'],
      query: {
        bool: {
          must: [{ bool: { should: shouldClauses, minimum_should_match: 1 } }],
          filter: filterClauses.length > 0 ? filterClauses : undefined,
        },
      },
    });

    const hits = searchRes.hits.hits as any[];
    if (hits.length === 0) return { rows: [] };

    docIds = hits.map((h: any) => h._id as string);
    metadataMap = new Map();
    for (const h of hits) {
      metadataMap.set(h._id as string, h._source as Record<string, unknown>);
    }
  }

  if (docIds.length === 0) return { rows: [] };

  // Fetch pdf_text for all docs
  const mgetRes = await es.mget({
    index: DECISIONS_INDEX,
    ids: docIds,
    _source_includes: ['pdf_text'],
  });

  const docsForAI: { id: string; pdfText: string }[] = [];
  for (const doc of mgetRes.docs as any[]) {
    if (doc.found && doc._source?.pdf_text) {
      const text = (doc._source.pdf_text as string).substring(0, PDF_TEXT_CAP);
      if (text.length > 500) {
        docsForAI.push({ id: doc._id!, pdfText: text });
      }
    }
  }

  if (docsForAI.length === 0) return { rows: [] };

  // Extract with AI — pass dynamic columns
  const searchTerm = textQuery || originalQuery;
  const extractions = await extractBatch(searchTerm, columns, docsForAI);

  // Build rows
  const emptyValue: ClaimValue = { display: null, numeric: null, unit: null, quote: null };
  const rowsWithData: CompareRow[] = [];
  const rowsWithout: CompareRow[] = [];
  const seenTitles = new Set<string>();

  for (const id of docIds) {
    const meta = metadataMap.get(id);
    if (!meta) continue;

    const title = (meta.title as string) || '';
    if (seenTitles.has(title)) continue;
    seenTitles.add(title);

    const extraction = extractions.get(id);
    const hasData = extraction?.hasData ?? false;

    const values: Record<string, ClaimValue> = {};
    for (const col of columns) {
      if (hasData && extraction) {
        const ev = extraction.values[col.key];
        values[col.key] = ev ? {
          display: ev.display,
          numeric: ev.numeric,
          unit: ev.unit,
          quote: ev.quote,
        } : emptyValue;
      } else {
        values[col.key] = emptyValue;
      }
    }

    const row: CompareRow = {
      id,
      title,
      database: (meta.database as DatabaseType) || 'decisive_appraiser',
      committee: (meta.committee as string) || null,
      year: (meta.year as string) || null,
      appraiser: (meta.appraiser as string) || null,
      url: (meta.url as string) || null,
      values,
    };

    if (hasData) rowsWithData.push(row);
    else rowsWithout.push(row);
  }

  return { rows: [...rowsWithData, ...rowsWithout] };
}
