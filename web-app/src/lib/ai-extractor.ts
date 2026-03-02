/**
 * AI-powered value extraction from Hebrew legal PDF text.
 * Supports dynamic column definitions — the caller decides what to extract.
 *
 * Key design choices:
 * - Smart text trimming: extract relevant sections (~5-8K) instead of 30K noise
 * - gpt-4o (not mini): Hebrew legal docs need stronger comprehension
 * - JSON mode: guaranteed valid JSON response
 * - Section-aware: finds party A, party B, and ruling sections in the document
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

export interface ColumnDef {
  key: string;
  label: string;
  prompt: string;
}

export interface ExtractedValue {
  display: string | null;
  numeric: number | null;
  unit: string | null;
  quote: string | null;
}

export interface ExtractionResult {
  values: Record<string, ExtractedValue>;
  hasData: boolean;
}

const EMPTY_VALUE: ExtractedValue = { display: null, numeric: null, unit: null, quote: null };

// ──────────────────────────────────────────────────────────────────
// Smart text trimming — extract relevant sections, discard noise
// ──────────────────────────────────────────────────────────────────

/**
 * Prepare document text for AI extraction.
 * Short docs (≤30K): send everything — no trimming.
 * Long docs (>30K): first 20K + last 10K (catches party claims + ruling).
 */
const FULL_CAP = 30000;

function prepareDocText(pdfText: string): string {
  if (pdfText.length <= FULL_CAP) return pdfText;
  // Long doc: head (party claims, summary tables) + tail (ruling, conclusion)
  const head = pdfText.substring(0, 20000);
  const tail = pdfText.substring(pdfText.length - 10000);
  return head + '\n\n[... חלק מהמסמך הושמט ...]\n\n' + tail;
}

// ──────────────────────────────────────────────────────────────────
// Prompt
// ──────────────────────────────────────────────────────────────────

const SYSTEM_MSG = `אתה מומחה לחילוץ נתונים מהחלטות שמאי מקרקעין בישראל.

מבנה מסמך טיפוסי:
- "טענות המבקש/הבעלים" = עמדת צד א (בדרך כלל הנישום/הבעלים שטוען לערך נמוך יותר)
- "טענות המשיבה/הוועדה" = עמדת צד ב (בדרך כלל הוועדה המקומית שטוענת לערך גבוה יותר)
- "הכרעה/קביעה/סיכום" = ההחלטה הסופית של השמאי המכריע

כללים קריטיים:
1. ערכים מספריים: החזר מספר שלם בלי פסיקים. "81,550" → value: 81550. "1,234,567" → value: 1234567.
2. מקדמים ואחוזים: החזר כמספר עשרוני. "0.85" → value: 0.85. "15%" → value: 15.
3. ציטוט: העתק את המשפט המדויק מהטקסט שממנו חילצת את הערך.
4. אם אין ערך מספרי רלוונטי — החזר null לכל השדות. לא להמציא ערכים.
5. יחידה: "שח" למטבע, "אחוז" לאחוזים, "שח למר" למחיר למטר. ללא גרשיים.
6. חלץ ערכים הקשורים לנושא החיפוש בלבד, לא כל מספר שמופיע במסמך.

החזר JSON תקין בלבד.`;

function buildPrompt(searchTerm: string, columns: ColumnDef[], trimmedText: string): string {
  const colInstructions = columns.map((col, i) =>
    `${i + 1}. "${col.key}" (${col.label}): ${col.prompt}`
  ).join('\n');

  return `נושא: "${searchTerm}"

חלץ את הערכים הבאים הקשורים ל"${searchTerm}":
${colInstructions}

פורמט JSON:
{
${columns.map(col => `  "${col.key}": { "value": <מספר_שלם_או_עשרוני>, "unit": "<שח|אחוז|שח_למר>", "quote": "<ציטוט_מדויק>" }`).join(',\n')}
}

אם לא נמצא ערך, החזר: "${columns[0].key}": { "value": null, "unit": null, "quote": null }

טקסט המסמך:
${trimmedText}`;
}

// ──────────────────────────────────────────────────────────────────
// Parse response
// ──────────────────────────────────────────────────────────────────

interface LLMValue {
  value: number | string | null;
  unit: string | null;
  quote: string | null;
}

function parseValue(raw: LLMValue | null | undefined): ExtractedValue {
  if (!raw || (raw.value === null && !raw.quote)) return EMPTY_VALUE;

  // Handle value — could be number, string-number, or null
  let numericValue: number | null = null;
  if (raw.value !== null) {
    if (typeof raw.value === 'number') {
      numericValue = raw.value;
    } else if (typeof raw.value === 'string') {
      // Model sometimes returns "81,550" as string — parse it
      const cleaned = raw.value.replace(/[,\s]/g, '');
      const parsed = parseFloat(cleaned);
      if (!isNaN(parsed)) numericValue = parsed;
    }
  }

  let display: string | null = null;
  if (numericValue !== null) {
    display = numericValue.toLocaleString('he-IL');
    if (raw.unit) display += ` ${raw.unit}`;
  } else if (raw.quote && !raw.value) {
    // Text-only extraction (no numeric value but has a quote)
    display = raw.quote.length > 50 ? raw.quote.substring(0, 50) + '...' : raw.quote;
  }

  return {
    display,
    numeric: numericValue,
    unit: raw.unit ?? null,
    quote: raw.quote ?? null,
  };
}

function sanitizeJson(text: string): string {
  let clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  clean = clean.replace(/ש"ח/g, 'שח');
  clean = clean.replace(/מ"ר/g, 'מר');
  clean = clean.replace(/סה"כ/g, 'סהכ');
  clean = clean.replace(/ם"ר/g, 'מר');
  clean = clean.replace(/בע"מ/g, 'בעמ');
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
    console.error('[ai-extractor] JSON parse failed:', (e as Error).message, 'Raw:', text.substring(0, 300));
    return { values: {}, hasData: false };
  }
}

// ──────────────────────────────────────────────────────────────────
// LLM call
// ──────────────────────────────────────────────────────────────────

async function callLLM(prompt: string, provider: Provider): Promise<string> {
  if (provider === 'openai') {
    const response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
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
    const docText = prepareDocText(pdfText);
    const prompt = buildPrompt(searchTerm, columns, docText);
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
