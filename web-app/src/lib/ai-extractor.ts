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

כללים:
- אל תחלץ מספרי גוש, חלקה, תאריכים, או מספרי תיק.
- חלץ סכומים כספיים, מחירים, שווי, מקדמים, שיעורים ואחוזים.
- כל ערך חייב להיות מלווה בציטוט מדויק מהטקסט.
- אם לא מצאת ערך — החזר null עבור כל השדות.
- ליחידת מטבע כתוב "שח" (בלי גרשיים) או "אחוז" לפי העניין.
- החזר JSON תקין בלבד. אין markdown, אין הסברים.`;

function buildPrompt(searchTerm: string, columns: ColumnDef[], pdfText: string): string {
  const colInstructions = columns.map((col, i) =>
    `${i + 1}. "${col.key}" — ${col.label}: ${col.prompt}`
  ).join('\n');

  const jsonExample = '{\n' + columns.map(col =>
    `  "${col.key}": { "value": 12345, "unit": "שח", "quote": "ציטוט מדויק מהטקסט" }`
  ).join(',\n') + '\n}';

  return `נושא החיפוש: "${searchTerm}"

חלץ מהטקסט את הערכים הבאים:
${colInstructions}

פורמט התשובה — JSON בלבד, בלי markdown:
${jsonExample}

אם ערך לא נמצא, החזר null עבור כל השדות של אותו מפתח.
ליחידת מטבע: "שח" (בלי גרשיים). לאחוזים: "אחוז".

המסמך:
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

/**
 * Sanitize LLM JSON response before parsing.
 * Fixes common issues like ש"ח (Hebrew shekel abbreviation containing a quote).
 */
function sanitizeJson(text: string): string {
  // Remove markdown code fences
  let clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');

  // Fix ש"ח → שח (the double-quote inside breaks JSON)
  // Match ש"ח that's inside a JSON string value (preceded by non-quote content)
  clean = clean.replace(/ש"ח/g, 'שח');

  // Fix מ"ר → מר
  clean = clean.replace(/מ"ר/g, 'מר');

  // Fix סה"כ → סהכ
  clean = clean.replace(/סה"כ/g, 'סהכ');

  // Fix ם"ר → מר (common OCR variant)
  clean = clean.replace(/ם"ר/g, 'מר');

  // Fix בע"מ → בעמ
  clean = clean.replace(/בע"מ/g, 'בעמ');

  // Fix תב"ע → תבע
  clean = clean.replace(/תב"ע/g, 'תבע');

  return clean;
}

function parseResponse(text: string, columns: ColumnDef[]): ExtractionResult {
  try {
    const sanitized = sanitizeJson(text);
    const jsonMatch = sanitized.match(/\{[\s\S]*\}/);
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
  } catch (e) {
    console.error('[ai-extractor] JSON parse failed:', (e as Error).message, 'Raw:', text.substring(0, 200));
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
      max_tokens: 1200,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_MSG },
        { role: 'user', content: prompt },
      ],
    });
    return response.choices[0]?.message?.content || '';
  } else {
    const response = await getAnthropic().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
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
