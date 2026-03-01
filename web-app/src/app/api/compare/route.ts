import { NextRequest, NextResponse } from 'next/server';
import { getElasticClient, DECISIONS_INDEX } from '@/lib/elasticsearch';
import { generateQueryEmbedding } from '@/lib/embeddings';
import { preprocessQuery } from '@/lib/query-preprocessor';
import { extractSections, getSearchTermValue, extractValueFromFullText, formatExtractedValue } from '@/lib/section-extractor';
import type { DatabaseType } from '@/types/api';

interface CompareRequest {
  query: string;
  committee?: string;
  limit?: number;
}

interface CompareRow {
  id: string;
  title: string;
  database: DatabaseType;
  committee: string | null;
  year: string | null;
  url: string | null;
  partyAValue: string | null;
  partyBValue: string | null;
  rulingValue: string | null;
  rulingNumeric: number | null;
}

interface CompareResponse {
  rows: CompareRow[];
  total: number;
  committee: string | null;
}

const MAX_COMPARE = 50;
const PDF_TEXT_CAP = 50000;

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
    const filterClauses: object[] = [];
    if (committee) {
      // Filter: match committee by text (handles "תל אביב" matching "תל אביב-יפו")
      filterClauses.push({
        match: { committee: { query: committee, operator: 'and' as const } },
      });
    }

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
      return NextResponse.json({ rows: [], total: 0, committee } satisfies CompareResponse);
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

      const extraction = extractSections(id, pdfText, textQuery || body.query);

      let partyAVal = getSearchTermValue(extraction.partyA, textQuery);
      let partyBVal = getSearchTermValue(extraction.partyB, textQuery);
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
        url: (src.url as string) || null,
        partyAValue: partyAVal ? formatExtractedValue(partyAVal) : null,
        partyBValue: partyBVal ? formatExtractedValue(partyBVal) : null,
        rulingValue: rulingVal ? formatExtractedValue(rulingVal) : null,
        rulingNumeric: rulingVal?.numeric ?? null,
      });

      if (rows.length >= limit) break;
    }

    const response: CompareResponse = {
      rows,
      total: rows.length,
      committee,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('[/api/compare] Error:', error);
    const message = error instanceof Error ? error.message : 'שגיאה בהשוואה';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
