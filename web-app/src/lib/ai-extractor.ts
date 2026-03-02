/**
 * AI-powered value extraction from Hebrew legal PDF text.
 * Supports dynamic column definitions — the caller decides what to extract.
 */
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// ──────────────────────────────────────────────────────────────────
// Provider
// ──────────────────────────────────────────────────────────────────

type Provider = 'openai' | 'anthropic';

function getProvider(): Provider {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  throw new Error('Either OPENAI_API_KEY or ANTHROPIC_API_KEY must be set');
}

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (openaiClient) return openaiClient;
  openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (anthropicClient) return anthropicClient;
  anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  return anthropicClient;
}

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

/** A column the user wants to extract */
export interface ColumnDef {
  key: string;       // unique id, e.g. "partyA", "valueBefore"
  label: string;     // Hebrew header, e.g. "שומת הבעלים"
  prompt: string;    // What to ask the AI, e.g. "מה הסכום שצד א' טוען?"
}

/** Extracted value for a single column */
export interface ExtractedValue {
  display: string | null;
  numeric: number | null;
  unit: string | null;
  quote: string | null;
}

/** Result for one document — values keyed by column key */
export interface ExtractionResult {
  values: Record<string, ExtractedValue>;
  hasData: boolean;
}

const EMPTY_VALUE: ExtractedValue = { display: null, numeric: null, unit: null, quote: null };

// ──────────────────────────────────────────────────────────────────
// Prompt builder — dynamic columns
// ──────────────────────────────────────────────────────────────────

const SYSTEM_MSG = `אתה מחלץ נתונים מספריים מהחלטות שמאי מקרקעין בישראל.
אל תחלץ מספרי גוש, חלקה, תאריכים, או מספרי תיק.
כל ערך חייב להיות מלווה בציטוט מדויק מהטקסט.
אם לא מצאת ערך — החזר null.
החזר JSON בלבד.`;

function buildPrompt(searchTerm: string, columns: ColumnDef[], pdfText: string): string {
  const colInstructions = columns.map((col, i) =>
    `${i + 1}. **${col.label}** — ${col.prompt}`
  ).join('\n');

  const jsonTemplate: Record<string, string> = {};
  for (const col of columns) {
    jsonTemplate[col.key] = '{"value":<number|null>,"unit":"<string|null>","quote":"<ציטוט|null>"}';
  }
  const jsonExample = '{' + columns.map(col =>
    `"${col.key}":{"value":null,"unit":null,"quote":null}`
  ).join(',') + '}';

  return `נושא החיפוש: "${searchTerm}"

חלץ מהטקסט את הערכים הבאים:
${colInstructions}

החזר JSON בפורמט (value=מספר, unit=יחידה, quote=ציטוט מדויק):
${jsonExample}

הטקסט:
${pdfText}`;
}

// ──────────────────────────────────────────────────────────────────
// Parse response
// ──────────────────────────────────────────────────────────────────

interface LLMValue {
  value: number | null;
  unit: string | null;
  quote: string | null;
}

function parseValue(raw: LLMValue | null | undefined): ExtractedValue {
  if (!raw || (raw.value === null && !raw.quote)) return EMPTY_VALUE;

  let display: string | null = null;
  if (raw.value !== null) {
    display = raw.value.toLocaleString('he-IL');
    if (raw.unit) display += ` ${raw.unit}`;
  }

  return {
    display,
    numeric: raw.value ?? null,
    unit: raw.unit ?? null,
    quote: raw.quote ?? null,
  };
}

function parseResponse(text: string, columns: ColumnDef[]): ExtractionResult {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { values: {}, hasData: false };

    const parsed = JSON.parse(jsonMatch[0]);
    const values: Record<string, ExtractedValue> = {};
    let hasData = false;

    for (const col of columns) {
      const v = parseValue(parsed[col.key]);
      values[col.key] = v;
      if (v.display) hasData = true;
    }

    return { values, hasData };
  } catch {
    return { values: {}, hasData: false };
  }
}

// ──────────────────────────────────────────────────────────────────
// LLM call
// ──────────────────────────────────────────────────────────────────

const TEXT_CAP = 30000;

async function callLLM(prompt: string, provider: Provider): Promise<string> {
  if (provider === 'openai') {
    const response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 800,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_MSG },
        { role: 'user', content: prompt },
      ],
    });
    return response.choices[0]?.message?.content || '';
  } else {
    const response = await getAnthropic().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: SYSTEM_MSG,
      messages: [{ role: 'user', content: prompt }],
    });
    const content = response.content[0];
    return content.type === 'text' ? content.text : '';
  }
}

async function extractFromDocument(
  searchTerm: string,
  columns: ColumnDef[],
  pdfText: string,
  provider: Provider,
): Promise<ExtractionResult> {
  try {
    const truncated = pdfText.substring(0, TEXT_CAP);
    const prompt = buildPrompt(searchTerm, columns, truncated);
    const text = await callLLM(prompt, provider);
    return parseResponse(text, columns);
  } catch (error) {
    console.error('[ai-extractor] Extraction failed:', (error as Error).message);
    return { values: {}, hasData: false };
  }
}

// ──────────────────────────────────────────────────────────────────
// Batch extraction
// ──────────────────────────────────────────────────────────────────

const MAX_CONCURRENT = 10;

export async function extractBatch(
  searchTerm: string,
  columns: ColumnDef[],
  documents: { id: string; pdfText: string }[],
): Promise<Map<string, ExtractionResult>> {
  const provider = getProvider();
  const results = new Map<string, ExtractionResult>();

  for (let i = 0; i < documents.length; i += MAX_CONCURRENT) {
    const chunk = documents.slice(i, i + MAX_CONCURRENT);
    const promises = chunk.map(async (doc) => {
      const result = await extractFromDocument(searchTerm, columns, doc.pdfText, provider);
      results.set(doc.id, result);
    });
    await Promise.all(promises);
  }

  return results;
}
