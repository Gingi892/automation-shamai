/**
 * Question-to-tool routing rules for Shamai professionals.
 * Served as MCP resource: shamai://knowledge/query-patterns
 */

export const QUERY_PATTERNS_CONTENT = `# דפוסי שאילתות שמאיות — מיפוי שאלות לכלים

## סגנון תשובה — כללי ברזל
- אתה אוסף נתונים, לא מנתח. תפקידך: למצוא ולהציג עובדות קונקרטיות עם מקור.
- לעולם אל תסכם, אל תחשב ממוצעים, אל תפרש. המשתמש הוא שמאי מוסמך — הוא יעשה את הניתוח בעצמו.
- כל שורה בטבלה חייבת לכלול: שם החלטה, שמאי, גוש/חלקה, קישור ל-PDF, ומה כתוב שם (ציטוט קצר).
- אם לא נמצא — אמור בפשטות "לא נמצאו תוצאות". אל תציע חלופות.

## כלים עיקריים
| כלי | תיאור | מתי להשתמש |
|-----|--------|-----------|
| **semantic_search** | **חיפוש סמנטי עם AI embeddings על 31K+ מסמכים** | **כלי ברירת מחדל לשאלות בשפה חופשית — מבין משמעות, לא רק מילות מפתח** |
| query_and_aggregate | חיפוש ואגרגציה — מחזיר טבלת CSV | טבלאות נתונים, רשימות ערכים לפי החלטות |
| search_decisions | חיפוש החלטות — מחזיר רשימת מסמכים | חיפוש לפי גוש/חלקה/שמאי/ועדה |
| search_by_parameters | חיפוש לפי פרמטרים מובנים | חיפוש מדויק לפי סוג פרמטר וערך |
| compare_committees | השוואת סטטיסטיקות בין ועדות | השוואת ערים |
| get_summary_stats | סטטיסטיקות מסכמות | "כמה החלטות...", מגמות |
| read_pdf | קריאת PDF מלא | קריאת מסמך ספציפי |
| get_decision_parameters | הצגת פרמטרים מובנים של החלטה | לאחר חיפוש — לראות כל הערכים |

## מיפוי שאלות לכלים

### ⭐ חיפוש סמנטי — semantic_search (כלי ברירת מחדל לשאלות בשפה חופשית)
השתמש ב-semantic_search כשהשאלה מושגית, תיאורית, או לא מכילה פרמטרים מדויקים.
הכלי משתמש ב-AI embeddings ומבין משמעות — מוצא מסמכים רלוונטיים גם בלי התאמת מילות מפתח.

| דפוס שאלה | כלי | למה |
|-----------|-----|-----|
| "גובה פנים דירה" | semantic_search | נושא מושגי — לא מילת מפתח מדויקת |
| "הגבהת בניין בקומות נוספות" | semantic_search | מושג תכנוני — צריך הבנת הקשר |
| "תמ"א 38 תוספת קומות" | semantic_search | מושג רוחבי שמופיע בהקשרים שונים |
| "פיצוי על הפקעה ליד חוף הים" | semantic_search | שילוב מושגי — מיקום + נושא |
| "השפעת רעש על שווי נכס" | semantic_search | קשר סיבתי מורכב |
| "זכויות בנייה לא מנוצלות" | semantic_search | מושג שמאי שיכול להופיע בניסוחים שונים |
| "מה המגמה בפסיקות על היטל השבחה" | semantic_search | שאלת מגמה — צריכה הבנה |
| "תיקים דומים למקרה שלי" | semantic_search | דמיון מושגי |

### חיפוש מקדמים (Coefficients)
| דפוס שאלה | כלי | פרמטרים |
|-----------|-----|----------|
| "מה המקדם ב[עיר]?" | query_and_aggregate | content_search="מקדם", committee="[עיר]" |
| "מקדם דחייה ב[עיר]" | query_and_aggregate | content_search="מקדם דחייה", committee="[עיר]" |
| "מקדם גודל ממוצע ב[עיר]" | query_and_aggregate | content_search="מקדם גודל", committee="[עיר]" |
| "שיעור היוון ב[עיר]" | query_and_aggregate | content_search="שיעור היוון", committee="[עיר]" |
| "מקדמי דחייה מעל 0.9" | search_by_parameters | param_type="coefficient", param_subtype="דחייה", value_min=0.9 |
| "מקדמי גודל בתל אביב" | search_by_parameters | param_type="coefficient", param_subtype="גודל", committee="תל אביב" |

### מחירים ושווי (Prices & Values)
| דפוס שאלה | כלי | פרמטרים |
|-----------|-----|----------|
| "מחיר למ"ר ב[עיר]" | query_and_aggregate | content_search="מחיר למ\\"ר", committee="[עיר]" |
| "שווי קרקע ב[עיר]" | query_and_aggregate | content_search="שווי קרקע", committee="[עיר]" |
| "מחיר למ"ר נטו מעל 5000" | search_by_parameters | param_type="price_per_meter", param_subtype="נטו", value_min=5000 |
| "דמי סחירות ב[עיר]" | search_by_parameters | param_type="tradability_fee", committee="[עיר]" |
| "שווי זכויות בנייה" | search_by_parameters | param_type="building_rights_value" |

### חיפוש לפי מיקום (Location Search)
| דפוס שאלה | כלי | פרמטרים |
|-----------|-----|----------|
| "גוש [X] חלקה [Y]" | search_decisions | block="[X]", plot="[Y]" |
| "החלטות ב[עיר]" | search_decisions | committee="[עיר]" |
| "החלטות ב[עיר] [שנה]" | search_decisions | committee="[עיר]", year="[שנה]" |
| "ייעוד מגורים ב[עיר]" | search_by_parameters | param_type="land_use", value_text="מגורים", committee="[עיר]" |

### חיפוש לפי גורם (Actor Search)
| דפוס שאלה | כלי | פרמטרים |
|-----------|-----|----------|
| "החלטות של שמאי [שם]" | search_decisions | appraiser="[שם]" |
| "שמאי מכריע [שם] ב[עיר]" | search_decisions | appraiser="[שם]", committee="[עיר]", database="decisive_appraiser" |

### חיפוש לפי סוג תיק (Case Type)
| דפוס שאלה | כלי | פרמטרים |
|-----------|-----|----------|
| "היטל השבחה ב[עיר]" | search_decisions | caseType="היטל השבחה", committee="[עיר]" |
| "פיצויים/סעיף 197 ב[עיר]" | search_decisions | caseType="פיצויים", committee="[עיר]" |
| "הפקעות ב[עיר]" | search_decisions | caseType="הפקעות", committee="[עיר]" |

### השוואות וסטטיסטיקות (Comparisons & Stats)
| דפוס שאלה | כלי | פרמטרים |
|-----------|-----|----------|
| "השווה [עיר1] ל[עיר2]" | compare_committees | committees=["[עיר1]","[עיר2]"] |
| "כמה החלטות ב[עיר]?" | get_summary_stats | committee="[עיר]" |
| "מגמות בשנים האחרונות" | get_summary_stats | (ללא סינון) |
| "באיזו עיר הכי הרבה תיקים?" | compare_committees | committees=["תל אביב","ירושלים","חיפה","באר שבע"] |

### קריאה וניתוח (Reading & Analysis)
| דפוס שאלה | כלי | פרמטרים |
|-----------|-----|----------|
| "קרא את ההחלטה [ID]" | read_pdf | id="[ID]" |
| "מה הפרמטרים של [ID]?" | get_decision_parameters | id="[ID]" |

## מיפוי מונחים למאגרים

| מונח בשאלה | מאגר (database) |
|-----------|----------------|
| שמאי מכריע / ש"מ / הכרעה | database="decisive_appraiser" |
| ועדת השגות / השגה | database="appeals_committee" |
| ועדת ערעורים / ערעור / ערר | database="appeals_board" |
| (לא צוין מאגר) | (כל המאגרים — ברירת מחדל) |

## מיפוי מונחים לסוגי פרמטרים (search_by_parameters)

| מונח בשאלה | param_type | param_subtype |
|-----------|-----------|--------------|
| מקדם גודל | coefficient | גודל |
| מקדם דחייה | coefficient | דחייה |
| מקדם היוון | coefficient | היוון |
| מקדם ניצול | coefficient | ניצול |
| מקדם מיקום | coefficient | מיקום |
| מקדם סחירות | coefficient | סחירות |
| מחיר למ"ר | price_per_meter | (נטו/ברוטו/אקוויולנטי) |
| שווי קרקע | land_value | — |
| זכויות בנייה | building_rights_value | — |
| דמי סחירות | tradability_fee | — |
| ייעוד (מגורים/מסחר/תעשייה) | land_use | — (use value_text) |
| עסקת השוואה | comparison_transaction | — |
| שיעור ריבון | sovereignty_rate | — |
`;
