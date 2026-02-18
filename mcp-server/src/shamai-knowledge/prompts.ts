/**
 * MCP Prompt definitions for Shamai workflows.
 * Prompts appear in Claude Desktop's prompt picker (/ menu).
 */

/** Prompt metadata for ListPrompts */
export const SHAMAI_PROMPTS = [
  {
    name: 'shamai-mode',
    description: 'הפעלת מצב שמאי — טוען ידע מקצועי מלא לניתוח החלטות שמאות מקרקעין',
    arguments: [],
  },
  {
    name: 'search-coefficient',
    description: 'חיפוש מקדם שמאי לפי סוג, עיר ושנה',
    arguments: [
      { name: 'type', description: 'סוג המקדם: גודל/דחייה/היוון/ניצול/מיקום/סחירות', required: true },
      { name: 'city', description: 'שם העיר (למשל: נתניה, תל אביב)', required: true },
      { name: 'year', description: 'שנה (למשל: 2024)', required: false },
    ],
  },
  {
    name: 'analyze-block',
    description: 'מציאת כל ההחלטות על גוש וחלקה מסוימים',
    arguments: [
      { name: 'block', description: 'מספר גוש', required: true },
      { name: 'plot', description: 'מספר חלקה', required: false },
    ],
  },
  {
    name: 'compare-areas',
    description: 'השוואת אזורים — מקדמים, שווי, או מגמות בין ערים',
    arguments: [
      { name: 'cities', description: 'ערים להשוואה, מופרדות בפסיק (למשל: תל אביב, ירושלים)', required: true },
      { name: 'metric', description: 'מדד להשוואה: מקדם/שווי/היטל (ברירת מחדל: מקדם)', required: false },
    ],
  },
  {
    name: 'case-research',
    description: 'מחקר תקדימים — חיפוש החלטות רלוונטיות לפי סוג תיק ונושא',
    arguments: [
      { name: 'case_type', description: 'סוג תיק: היטל השבחה/פיצויים/הפקעות/דמי חכירה', required: true },
      { name: 'city', description: 'עיר או ישוב', required: false },
      { name: 'topic', description: 'נושא ספציפי (למשל: תמא 38, פינוי בינוי, שינוי ייעוד)', required: false },
    ],
  },
];

/**
 * Returns the messages array for a given prompt name + arguments.
 * These messages are injected into the conversation when the user selects a prompt.
 */
export function getPromptMessages(
  name: string,
  args: Record<string, string>
): Array<{ role: string; content: { type: string; text: string } }> | null {
  switch (name) {
    case 'shamai-mode':
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `אני שמאי מקרקעין ואני עובד עם מאגר החלטות שמאות מקרקעין של ממשלת ישראל.

אנא קרא את שלושת מסמכי הידע:
1. shamai://knowledge/glossary — מילון מונחים מקצועיים
2. shamai://knowledge/query-patterns — מיפוי שאלות לכלים
3. shamai://knowledge/institutional-framework — המסגרת המוסדית

לאחר קריאת המסמכים, ענה על שאלותיי כשמאי עמית מנוסה:
- השתמש במונחים מקצועיים בעברית
- הפנה ישירות לכלי החיפוש המתאים ללא היסוס
- כשאני שואל "מה המקדם" — זה מקדם שמאי, חפש בהחלטות
- כשאני נותן גוש/חלקה — חפש ישירות בפרמטרים
- כשאני שואל על עיר — השתמש בפילטר committee`,
          },
        },
      ];

    case 'search-coefficient':
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `חפש מקדם ${args.type || ''} ב${args.city || ''}${args.year ? ` לשנת ${args.year}` : ''}.

השתמש בכלי query_and_aggregate עם:
- content_search="מקדם ${args.type || ''}"
- committee="${args.city || ''}"${args.year ? `\n- year="${args.year}"` : ''}

הצג טבלה עם כל המקדמים שנמצאו: שמאי, גוש/חלקה, שנה, ערך המקדם, וקישור ל-PDF.`,
          },
        },
      ];

    case 'analyze-block':
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `מצא את כל ההחלטות על גוש ${args.block}${args.plot ? ` חלקה ${args.plot}` : ''}.

חפש עם search_decisions: block="${args.block}"${args.plot ? `, plot="${args.plot}"` : ''}

הצג טבלה עם כל ההחלטות שנמצאו: שם החלטה, שמאי, ועדה, שנה, סוג תיק, וקישור ל-PDF.`,
          },
        },
      ];

    case 'compare-areas': {
      const cityList = (args.cities || '').split(',').map(c => c.trim()).filter(Boolean);
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `השווה בין ${cityList.join(' ל')} מבחינת ${args.metric || 'מקדמים'}.

השתמש בכלי compare_committees עם:
- committees=[${cityList.map(c => `"${c}"`).join(', ')}]

ולאחר מכן query_and_aggregate עם content_search="${args.metric || 'מקדם'}" לכל עיר.

הצג טבלת השוואה עם:
- מספר החלטות בכל עיר
- ${args.metric || 'מקדמים'} שנמצאו
- טווח תאריכים
- מגמות בולטות`,
          },
        },
      ];
    }

    case 'case-research':
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `מחקר תקדימים: ${args.case_type || ''}${args.city ? ` ב${args.city}` : ''}${args.topic ? ` — ${args.topic}` : ''}.

חפש עם search_decisions: caseType="${args.case_type || ''}"${args.city ? `, committee="${args.city}"` : ''}${args.topic ? `, query="${args.topic}"` : ''}

הצג טבלה עם כל ההחלטות שנמצאו: שם החלטה, שמאי, גוש/חלקה, שנה, וקישור ל-PDF.`,
          },
        },
      ];

    default:
      return null;
  }
}
