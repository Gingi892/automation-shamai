# Improved Tool Description for search_decisions

## Current Description Analysis (dist/index.js lines 57-78)

### Strengths
1. Lists all available parameters
2. Provides one Hebrew example with extraction
3. Mentions database options
4. Explains what the tool returns

### Weaknesses Identified

| Issue | Problem | Impact on Claude |
|-------|---------|------------------|
| W1 | Only ONE example provided | Claude needs multiple patterns to generalize |
| W2 | No database selection guidance | Claude doesn't know when to use which database |
| W3 | No Hebrew keyword mappings | Claude may not recognize "ערעור" → appeals_board |
| W4 | No negative examples | Claude doesn't know what NOT to extract |
| W5 | caseType examples incomplete | Only shows 3 types, there are more |
| W6 | No handling for ambiguous queries | What if user doesn't specify database? |
| W7 | yearFrom/yearTo format unclear | Is it 2024 or "2024"? |

---

## Improved Tool Description

```javascript
{
    name: 'search_decisions',
    description: `חיפוש החלטות שמאות מקרקעין מאתר gov.il.

## תפקיד Claude
עליך לחלץ פרמטרים מובנים משאילתת המשתמש בעברית ולהעביר לכלי זה.

## בחירת מאגר (database) - חובה!
| מאגר | מתי לבחור | מילות מפתח |
|------|-----------|------------|
| decisive_appraiser | שמאי מכריע, החלטות שמאי | "שמאי מכריע", "החלטת שמאי" |
| appeals_committee | ועדת השגות, השגה על שומה | "השגה", "ועדת השגות", "השגות" |
| appeals_board | ועדת ערעורים, ערעור | "ערעור", "ועדת ערעורים" |

**ברירת מחדל:** אם המשתמש לא ציין - השתמש ב-decisive_appraiser

## פרמטרים
- database (חובה): decisive_appraiser | appeals_committee | appeals_board
- freeText: טקסט חופשי לחיפוש בתוכן
- city: שם עיר בעברית (לדוגמה: "תל אביב", "נתניה", "חיפה")
- blockNumber: מספר גוש (רק מספרים, לדוגמה: "6158")
- plotNumber: מספר חלקה (רק מספרים, לדוגמה: "25")
- caseType: סוג תיק - "היטל השבחה" | "פיצויים" | "ירידת ערך" | "הפקעה" | "תמ\"א 38"
- appraiserName: שם השמאי
- yearFrom: שנת התחלה (מספר: 2020)
- yearTo: שנת סיום (מספר: 2025)
- maxResults: מקסימום תוצאות (ברירת מחדל: 30)

## דוגמאות חילוץ

### דוגמה 1: חיפוש בסיסי לפי עיר
משתמש: "מצא החלטות בנתניה"
חילוץ: { database: "decisive_appraiser", city: "נתניה" }

### דוגמה 2: חיפוש לפי סוג וזמן
משתמש: "החלטות על היטל השבחה מ-2024"
חילוץ: { database: "decisive_appraiser", caseType: "היטל השבחה", yearFrom: 2024 }

### דוגמה 3: חיפוש לפי גוש וחלקה
משתמש: "מצא החלטות בגוש 6158 חלקה 25"
חילוץ: { database: "decisive_appraiser", blockNumber: "6158", plotNumber: "25" }

### דוגמה 4: ערעורים (שים לב לבחירת מאגר!)
משתמש: "ערעורים על שומות בתל אביב"
חילוץ: { database: "appeals_board", city: "תל אביב" }

### דוגמה 5: השגות
משתמש: "השגות על היטל השבחה בחיפה"
חילוץ: { database: "appeals_committee", city: "חיפה", caseType: "היטל השבחה" }

### דוגמה 6: חיפוש חופשי
משתמש: "מצא החלטות שמזכירות פינוי בינוי"
חילוץ: { database: "decisive_appraiser", freeText: "פינוי בינוי" }

## מה לא לחלץ
- אל תמציא פרמטרים שהמשתמש לא ציין
- אם לא ברור איזה מאגר - השתמש ב-decisive_appraiser
- אם המשתמש מבקש "כל ההחלטות" - אל תוסיף פילטרים מיותרים

## לאחר קבלת תוצאות
השתמש ב-read_decision_pdf כדי לקרוא את התוכן המלא של החלטות רלוונטיות.`,
    inputSchema: {
        type: 'object',
        properties: {
            database: {
                type: 'string',
                enum: ['decisive_appraiser', 'appeals_committee', 'appeals_board'],
                description: 'המאגר לחיפוש: decisive_appraiser (שמאי מכריע), appeals_committee (ועדת השגות), appeals_board (ועדת ערעורים)'
            },
            freeText: {
                type: 'string',
                description: 'טקסט חופשי לחיפוש'
            },
            city: {
                type: 'string',
                description: 'שם עיר בעברית'
            },
            blockNumber: {
                type: 'string',
                description: 'מספר גוש (מספרים בלבד)'
            },
            plotNumber: {
                type: 'string',
                description: 'מספר חלקה (מספרים בלבד)'
            },
            caseType: {
                type: 'string',
                description: 'סוג תיק: היטל השבחה, פיצויים, ירידת ערך, הפקעה, תמ"א 38'
            },
            appraiserName: {
                type: 'string',
                description: 'שם השמאי'
            },
            yearFrom: {
                type: 'number',
                description: 'שנת התחלה (מספר, לדוגמה: 2020)'
            },
            yearTo: {
                type: 'number',
                description: 'שנת סיום (מספר, לדוגמה: 2025)'
            },
            maxResults: {
                type: 'number',
                description: 'מקסימום תוצאות (ברירת מחדל: 30)',
                default: 30
            }
        },
        required: ['database']
    }
}
```

---

## Key Improvements Summary

| Improvement | Before | After |
|-------------|--------|-------|
| Examples | 1 example | 6 diverse examples |
| Database guidance | None | Full decision table with keywords |
| Hebrew support | Partial | Full Hebrew descriptions |
| Negative guidance | None | "What not to extract" section |
| Default behavior | Unclear | Explicit defaults |
| caseType options | 3 types | 5 types |
| Parameter descriptions | English | Hebrew |

---

## Why This Matters for NL Queries

The improved description:
1. **Teaches Claude the mapping** between Hebrew keywords and database choices
2. **Shows diverse patterns** so Claude can generalize to new queries
3. **Prevents over-extraction** with negative guidance
4. **Handles ambiguity** with explicit defaults
5. **Uses Hebrew** throughout to match user queries

---

*Created for QA-003 by Ralph Loop iteration 3*
