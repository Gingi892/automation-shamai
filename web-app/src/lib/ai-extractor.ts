/**
 * AI-powered value extraction from Hebrew legal PDF text.
 * Uses OpenAI gpt-4o-mini (primary) or Claude Haiku (fallback) to extract
 * party A claims, party B claims, and rulings.
 */
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// ──────────────────────────────────────────────────────────────────
// Provider detection — prefer OpenAI (cheaper for batch extraction)
// ──────────────────────────────────────────────────────────────────

type Provider = 'openai' | 'anthropic';

function getProvider(): Provider {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  throw new Error('Either OPENAI_API_KEY or ANTHROPIC_API_KEY must be set for AI extraction');
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

export interface ExtractedClaim {
  display: string | null;
  numeric: number | null;
  unit: string | null;
  quote: string | null;
}

export interface AIExtractionResult {
  partyA: ExtractedClaim;
  partyB: ExtractedClaim;
  ruling: ExtractedClaim;
  hasData: boolean;
}

const EMPTY_CLAIM: ExtractedClaim = { display: null, numeric: null, unit: null, quote: null };
const EMPTY_RESULT: AIExtractionResult = { partyA: EMPTY_CLAIM, partyB: EMPTY_CLAIM, ruling: EMPTY_CLAIM, hasData: false };

// ──────────────────────────────────────────────────────────────────
// Prompt
// ──────────────────────────────────────────────────────────────────

const SYSTEM_MSG = `אתה מחלץ נתונים מספריים מהחלטות שמאי מקרקעין בישראל.
תפקידך לזהות את הערכים שכל צד טוען ואת ההכרעה הסופית.
אל תחלץ מספרי גוש, חלקה, תאריכים, או מספרי תיק.
כל ערך חייב להיות מלווה בציטוט מדויק מהטקסט.
אם לא מצאת ערך — החזר null.
החזר JSON בלבד.`;

function buildUserPrompt(searchTerm: string, pdfText: string): string {
  return `נושא החיפוש: "${searchTerm}"

חלץ מהטקסט הבא:
1. **צד א' (טענות המבקשים/העוררים)** — מה הערך/סכום שצד א' טוען לגבי ${searchTerm}?
2. **צד ב' (טענות המשיבה/הוועדה)** — מה הערך/סכום שצד ב' טוען לגבי ${searchTerm}?
3. **הכרעה** — מה הערך/סכום שנקבע בהכרעה לגבי ${searchTerm}?

החזר JSON בפורמט:
{"partyA":{"value":<number|null>,"unit":"<string|null>","quote":"<ציטוט|null>"},"partyB":{"value":<number|null>,"unit":"<string|null>","quote":"<ציטוט|null>"},"ruling":{"value":<number|null>,"unit":"<string|null>","quote":"<ציטוט|null>"}}

הטקסט:
${pdfText}`;
}

// ──────────────────────────────────────────────────────────────────
// Parse LLM response
// ──────────────────────────────────────────────────────────────────

interface LLMClaim {
  value: number | null;
  unit: string | null;
  quote: string | null;
}

function parseClaim(raw: LLMClaim | null | undefined): ExtractedClaim {
  if (!raw || (raw.value === null && !raw.quote)) return EMPTY_CLAIM;

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

function parseResponse(text: string): AIExtractionResult {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return EMPTY_RESULT;

    const parsed = JSON.parse(jsonMatch[0]);
    const partyA = parseClaim(parsed.partyA);
    const partyB = parseClaim(parsed.partyB);
    const ruling = parseClaim(parsed.ruling);
    const hasData = !!(partyA.display || partyB.display || ruling.display);

    return { partyA, partyB, ruling, hasData };
  } catch {
    return EMPTY_RESULT;
  }
}

// ──────────────────────────────────────────────────────────────────
// LLM call — provider-agnostic
// ──────────────────────────────────────────────────────────────────

const TEXT_CAP = 30000; // ~30K chars — ruling sections are often in the latter half

async function callLLM(prompt: string, provider: Provider): Promise<string> {
  if (provider === 'openai') {
    const response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 500,
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
      max_tokens: 500,
      system: SYSTEM_MSG,
      messages: [{ role: 'user', content: prompt }],
    });
    const content = response.content[0];
    return content.type === 'text' ? content.text : '';
  }
}

async function extractFromDocument(
  searchTerm: string,
  pdfText: string,
  provider: Provider,
): Promise<AIExtractionResult> {
  try {
    const truncated = pdfText.substring(0, TEXT_CAP);
    const prompt = buildUserPrompt(searchTerm, truncated);
    const text = await callLLM(prompt, provider);
    return parseResponse(text);
  } catch (error) {
    console.error('[ai-extractor] Extraction failed:', (error as Error).message);
    return EMPTY_RESULT;
  }
}

// ──────────────────────────────────────────────────────────────────
// Batch extraction with concurrency control
// ──────────────────────────────────────────────────────────────────

const MAX_CONCURRENT = 10;

export async function extractBatch(
  searchTerm: string,
  documents: { id: string; pdfText: string }[],
): Promise<Map<string, AIExtractionResult>> {
  const provider = getProvider();
  const results = new Map<string, AIExtractionResult>();

  for (let i = 0; i < documents.length; i += MAX_CONCURRENT) {
    const chunk = documents.slice(i, i + MAX_CONCURRENT);
    const promises = chunk.map(async (doc) => {
      const result = await extractFromDocument(searchTerm, doc.pdfText, provider);
      results.set(doc.id, result);
    });
    await Promise.all(promises);
  }

  return results;
}
