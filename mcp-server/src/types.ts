/**
 * Gov.il Land Appraisal MCP Server Types
 */

// Database types
export type DatabaseType = 'decisive_appraiser' | 'appeals_committee' | 'appeals_board';

export interface Decision {
  id: string;
  database: DatabaseType;
  title: string;
  url: string | null;
  block: string | null;        // גוש
  plot: string | null;         // חלקה
  committee: string | null;    // ועדה מקומית
  appraiser: string | null;    // שם השמאי
  caseType: string | null;     // היטל השבחה, פיצויים, etc.
  decisionDate: string | null;
  publishDate: string | null;
  contentHash: string;         // For change detection
  pdfText: string | null;      // Cached extracted PDF text
  indexedAt: string;
  relevanceScore?: number;     // FTS5 bm25 relevance score (only present when using text search)
}

export interface DecisionRow {
  id: string;
  database: string;
  title: string;
  url: string | null;
  block: string | null;
  plot: string | null;
  committee: string | null;
  appraiser: string | null;
  case_type: string | null;
  decision_date: string | null;
  publish_date: string | null;
  content_hash: string;
  pdf_text: string | null;
  indexed_at: string;
}

// Search parameters
export interface SearchParams {
  query?: string;
  database?: DatabaseType;
  committee?: string;
  block?: string;
  plot?: string;
  appraiser?: string;
  caseType?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
  semanticSearch?: boolean;
}

export interface SearchResult {
  decisions: Decision[];
  totalCount: number;
  hasMore: boolean;
  query: SearchParams;
  rankedByRelevance: boolean;  // True when results are ordered by FTS5 relevance score
}

// Scraper types
export interface ScraperConfig {
  apiKey: string;
  baseUrls: Record<DatabaseType, string>;
  pageSize: number;
  maxPages: number;
  delayMs: number;
}

export interface ScrapedPage {
  html: string;
  database: DatabaseType;
  page: number;
  timestamp: Date;
}

export interface ParsedDecision {
  title: string;
  url: string | null;
  block: string | null;
  plot: string | null;
  committee: string | null;
  appraiser: string | null;
  caseType: string | null;
  decisionDate: string | null;
  publishDate: string | null;
}

// Indexer types
export interface IndexerProgress {
  database: DatabaseType;
  currentPage: number;
  totalPages: number | null;
  documentsIndexed: number;
  startTime: Date;
  status: 'running' | 'completed' | 'failed' | 'paused';
  error?: string;
}

export interface IndexerStats {
  totalDocuments: number;
  byDatabase: Record<DatabaseType, number>;
  lastIndexedAt: string | null;
  lastUpdateAt: string | null;
}

// MCP Tool types
export interface MCPToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

// Query clarification types
export type AmbiguityType = 'missing_database' | 'vague_location' | 'unclear_date_range' | 'ambiguous_case_type' | 'missing_search_terms';

export interface ClarificationOption {
  value: string;
  label: string;           // Hebrew label for display
  labelEn?: string;        // Optional English label
}

export interface ClarificationPrompt {
  ambiguityType: AmbiguityType;
  question: string;        // Hebrew question
  questionEn?: string;     // Optional English question
  options: ClarificationOption[];
  allowMultiple?: boolean; // Whether multiple options can be selected
  allowFreeText?: boolean; // Whether user can provide free text instead
}

export interface ClarifyQueryInput {
  originalQuery: string;   // The user's original Hebrew query
  previousClarifications?: string[];  // Ambiguity types already clarified (to avoid asking again)
}

export interface ClarifyQueryResult {
  needsClarification: boolean;
  clarifications: ClarificationPrompt[];
  detectedAmbiguities: AmbiguityType[];
  suggestedParams?: Partial<SearchParams>;  // Parameters that could be extracted despite ambiguity
  originalQuery: string;
}

// Answer construction types (US-006)
export type ConfidenceLevel = 'confident' | 'uncertain';

export interface CitedSource {
  index: number;          // S0, S1, etc.
  decisionId: string;
  title: string;
  pdfUrl: string | null;
  database: DatabaseType;
  relevanceScore?: number;
  excerpt?: string;       // Relevant quote from decision (if from PDF content)
}

export interface CitedClaim {
  text: string;           // The claim text
  citations: number[];    // Indices of sources supporting this claim [0, 1] means [S0], [S1]
  confidence: ConfidenceLevel;
}

export interface ConstructAnswerInput {
  question: string;           // The user's original question
  decisions: Decision[];      // Search results to cite from
  pdfExcerpts?: Array<{       // Optional excerpts from PDF content
    decisionId: string;
    excerpt: string;
  }>;
}

export interface QuotedExcerpt {
  sourceIndex: number;            // Which source this excerpt came from [S0], [S1], etc.
  decisionId: string;
  excerpt: string;                // The actual quoted text from the PDF
  context?: string;               // Optional context about what this excerpt addresses
}

export interface ConstructAnswerResult {
  formattedAnswer: string;        // Answer with inline citations [S0], [S1], etc.
  sources: CitedSource[];         // Sources section
  claims: CitedClaim[];           // Individual claims with their citations
  quotedExcerpts: QuotedExcerpt[]; // Direct quotes from PDF content for answer construction
  overallConfidence: ConfidenceLevel;
  noResultsWarning?: string;      // "לא נמצאו החלטות רלוונטיות" when applicable
}

// Database configuration
export const DATABASE_CONFIG: Record<DatabaseType, { name: string; url: string }> = {
  decisive_appraiser: {
    name: 'שמאי מכריע',
    url: 'https://www.gov.il/he/departments/dynamiccollectors/decisive_appraisal_decisions'
  },
  appeals_committee: {
    name: 'ועדת השגות',
    url: 'https://www.gov.il/he/departments/dynamiccollectors/objections_committee_decisions'
  },
  appeals_board: {
    name: 'ועדת ערעורים',
    url: 'https://www.gov.il/he/departments/dynamiccollectors/appellate_committee_decisions'
  }
};

// Utility type for converting database row to Decision
export function rowToDecision(row: DecisionRow, relevanceScore?: number): Decision {
  const decision: Decision = {
    id: row.id,
    database: row.database as DatabaseType,
    title: row.title,
    url: row.url,
    block: row.block,
    plot: row.plot,
    committee: row.committee,
    appraiser: row.appraiser,
    caseType: row.case_type,
    decisionDate: row.decision_date,
    publishDate: row.publish_date,
    contentHash: row.content_hash,
    pdfText: row.pdf_text,
    indexedAt: row.indexed_at
  };

  // Only include relevanceScore when provided (from FTS5 search)
  if (relevanceScore !== undefined) {
    // bm25() returns negative values, normalize to positive (higher = more relevant)
    decision.relevanceScore = -relevanceScore;
  }

  return decision;
}
