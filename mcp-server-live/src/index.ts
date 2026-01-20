#!/usr/bin/env node
/**
 * Gov.il Land Appraisal MCP Server v2.1
 *
 * Updated with robust selector discovery and better Angular handling.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import puppeteer, { Browser, Page } from 'puppeteer';
// @ts-ignore - pdf-parse doesn't have types
import pdf from 'pdf-parse';

// Database configurations
const DATABASES: Record<string, { name: string; nameEn: string; url: string; description: string }> = {
    decisive_appraiser: {
        name: 'שמאי מכריע',
        nameEn: 'Decisive Appraiser',
        url: 'https://www.gov.il/he/departments/dynamiccollectors/decisive_appraisal_decisions',
        description: 'החלטות שמאי מכריע בנושאי מקרקעין'
    },
    appeals_committee: {
        name: 'ועדת השגות',
        nameEn: 'Appeals Committee',
        url: 'https://www.gov.il/he/departments/dynamiccollectors/objections_committee_decisions',
        description: 'החלטות ועדת השגות על שומות מקרקעין'
    },
    appeals_board: {
        name: 'ועדת ערעורים',
        nameEn: 'Appeals Board',
        url: 'https://www.gov.il/he/departments/dynamiccollectors/appellate_committee_decisions',
        description: 'החלטות ועדת ערעורים על החלטות שמאיות'
    }
};

// Browser instance (reused across requests)
let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
    if (!browserInstance) {
        console.error('Launching browser...');
        browserInstance = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });
    }
    return browserInstance;
}

interface SearchParams {
    database: string;
    freeText?: string;
    city?: string;
    blockNumber?: string;
    plotNumber?: string;
    caseType?: string;
    appraiserName?: string;
    yearFrom?: number;
    yearTo?: number;
    maxResults?: number;
}

interface Decision {
    title: string;
    url: string | null;
    date: string | null;
    database: string;
    metadata?: Record<string, string>;
}

// Tool definitions with improved description
const TOOLS = [
    {
        name: 'search_decisions',
        description: `חיפוש החלטות שמאות מקרקעין מאתר gov.il.

## בחירת מאגר (database) - חובה!
| מאגר | מתי לבחור | מילות מפתח |
|------|-----------|------------|
| decisive_appraiser | שמאי מכריע, החלטות שמאי | "שמאי מכריע", "החלטת שמאי" |
| appeals_committee | ועדת השגות, השגה על שומה | "השגה", "ועדת השגות" |
| appeals_board | ועדת ערעורים, ערעור | "ערעור", "ועדת ערעורים" |

**ברירת מחדל:** אם לא ציין המשתמש - השתמש ב-decisive_appraiser

## דוגמאות חילוץ
- "מצא החלטות בנתניה" → { database: "decisive_appraiser", city: "נתניה" }
- "ערעורים בתל אביב" → { database: "appeals_board", city: "תל אביב" }
- "השגות על היטל השבחה" → { database: "appeals_committee", caseType: "היטל השבחה" }
- "החלטות מ-2024" → { database: "decisive_appraiser", yearFrom: 2024 }
- "גוש 6158 חלקה 25" → { database: "decisive_appraiser", blockNumber: "6158", plotNumber: "25" }

לאחר קבלת תוצאות, השתמש ב-read_decision_pdf לקריאת תוכן מלא.`,
        inputSchema: {
            type: 'object',
            properties: {
                database: {
                    type: 'string',
                    enum: ['decisive_appraiser', 'appeals_committee', 'appeals_board'],
                    description: 'המאגר לחיפוש (חובה)'
                },
                freeText: { type: 'string', description: 'טקסט חופשי לחיפוש' },
                city: { type: 'string', description: 'שם עיר/ועדה מקומית בעברית' },
                blockNumber: { type: 'string', description: 'מספר גוש' },
                plotNumber: { type: 'string', description: 'מספר חלקה' },
                caseType: { type: 'string', description: 'סוג תיק (היטל השבחה, פיצויים, ירידת ערך)' },
                appraiserName: { type: 'string', description: 'שם השמאי' },
                yearFrom: { type: 'number', description: 'משנת' },
                yearTo: { type: 'number', description: 'עד שנת' },
                maxResults: { type: 'number', description: 'מקסימום תוצאות (ברירת מחדל: 30)', default: 30 }
            },
            required: ['database']
        }
    },
    {
        name: 'read_decision_pdf',
        description: `קריאת תוכן מלא מקובץ PDF של החלטה.
השתמש לאחר search_decisions כדי לקרוא החלטות רלוונטיות.

**הערה חשובה:** חלק מקבצי ה-PDF עם שמות בעברית לא נגישים דרך ה-API (בעיה בשרת gov.il).
במקרה כזה יוחזר קישור ישיר לפתיחה בדפדפן.

PDFs עם שמות מספריים (למשל 044349285973.pdf) נגישים תמיד.`,
        inputSchema: {
            type: 'object',
            properties: {
                pdfUrl: { type: 'string', description: 'כתובת ה-PDF מתוצאות החיפוש' }
            },
            required: ['pdfUrl']
        }
    },
    {
        name: 'list_databases',
        description: 'הצגת רשימת המאגרים הזמינים.',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'debug_page',
        description: 'Debug tool to discover page structure. Returns available elements on the page.',
        inputSchema: {
            type: 'object',
            properties: {
                database: {
                    type: 'string',
                    enum: ['decisive_appraiser', 'appeals_committee', 'appeals_board'],
                    description: 'Which database page to inspect'
                }
            },
            required: ['database']
        }
    }
];

/**
 * Wait for Angular to fully render the page
 */
async function waitForAngular(page: Page, timeout: number = 10000): Promise<void> {
    console.error('Waiting for Angular to render...');

    // Wait for network to be idle
    await page.waitForNetworkIdle({ idleTime: 500, timeout }).catch(() => {});

    // Wait for body to have substantial content
    await page.waitForFunction(() => {
        const body = document.body.innerText;
        return body.length > 500;
    }, { timeout: 5000 }).catch(() => {});

    // Extra settling time
    await new Promise(resolve => setTimeout(resolve, 2000));
}

/**
 * Discover page structure - useful for debugging
 */
async function discoverPageStructure(page: Page): Promise<Record<string, any>> {
    return await page.evaluate(() => {
        const discovery: Record<string, any> = {
            inputs: [] as any[],
            selects: [] as any[],
            buttons: [] as any[],
            links: [] as any[],
            resultContainers: [] as any[],
            allClasses: [] as string[]
        };

        // Find all inputs
        document.querySelectorAll('input').forEach((el: HTMLInputElement) => {
            discovery.inputs.push({
                type: el.type,
                name: el.name,
                placeholder: el.placeholder,
                className: el.className,
                id: el.id,
                ngModel: el.getAttribute('ng-model')
            });
        });

        // Find all selects
        document.querySelectorAll('select').forEach((el: HTMLSelectElement) => {
            discovery.selects.push({
                name: el.name,
                className: el.className,
                id: el.id,
                ngModel: el.getAttribute('ng-model'),
                optionCount: el.options.length
            });
        });

        // Find all buttons
        document.querySelectorAll('button, input[type="submit"], [role="button"]').forEach((el: Element) => {
            discovery.buttons.push({
                text: el.textContent?.trim().substring(0, 50),
                className: el.className,
                type: el.getAttribute('type'),
                ngClick: el.getAttribute('ng-click')
            });
        });

        // Find PDF/document links
        document.querySelectorAll('a[href*=".pdf"], a[href*="blob"], a[href*="Blob"], a[href*="file"]').forEach((el: HTMLAnchorElement) => {
            discovery.links.push({
                href: el.href,
                text: el.textContent?.trim().substring(0, 50),
                className: el.className
            });
        });

        // Find potential result containers
        document.querySelectorAll('[ng-repeat], [class*="result"], [class*="item"], [class*="card"]').forEach((el: Element) => {
            discovery.resultContainers.push({
                tagName: el.tagName,
                className: el.className,
                childCount: el.children.length,
                ngRepeat: el.getAttribute('ng-repeat')
            });
        });

        // Collect unique class names
        const classSet = new Set<string>();
        document.querySelectorAll('*').forEach((el: Element) => {
            el.className.split(' ').forEach((c: string) => {
                if (c.trim()) classSet.add(c.trim());
            });
        });
        discovery.allClasses = Array.from(classSet).sort();

        return discovery;
    });
}

/**
 * Search gov.il using Puppeteer with improved selectors
 */
async function searchWithPuppeteer(params: SearchParams): Promise<Decision[]> {
    const browser = await getBrowser();
    const page = await browser.newPage();
    const dbInfo = DATABASES[params.database];

    console.error(`Searching ${dbInfo.name} with params:`, JSON.stringify(params));

    try {
        // Set viewport and user agent
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Navigate to the search page
        console.error(`Navigating to ${dbInfo.url}`);
        await page.goto(dbInfo.url, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        // Wait for Angular to fully render
        await waitForAngular(page);

        // Debug: log what we find
        const structure = await discoverPageStructure(page);
        console.error(`Found ${structure.inputs.length} inputs, ${structure.selects.length} selects, ${structure.buttons.length} buttons, ${structure.links.length} PDF links`);

        // Try to fill in search filters
        const filterStats = await fillSearchFilters(page, params, structure);
        console.error(`Filters applied: ${filterStats.applied}/${filterStats.attempted}`);

        // Wait for results to load after filtering
        await new Promise(resolve => setTimeout(resolve, 2000));
        await waitForAngular(page);

        // Extract decisions from the page
        const decisions = await extractDecisions(page, dbInfo.name, params.maxResults || 30);
        console.error(`Found ${decisions.length} decisions`);

        return decisions;
    } catch (error) {
        console.error('Search error:', error);
        throw error;
    } finally {
        await page.close();
    }
}

/**
 * Fill in search filters with dynamic selector discovery
 */
async function fillSearchFilters(
    page: Page,
    params: SearchParams,
    structure: Record<string, any>
): Promise<{ applied: number; attempted: number }> {
    let applied = 0;
    let attempted = 0;

    // Build selectors based on discovered inputs
    const inputsByPlaceholder = new Map<string, string>();
    const inputsByNgModel = new Map<string, string>();

    for (const input of structure.inputs) {
        if (input.placeholder) {
            inputsByPlaceholder.set(input.placeholder, `input[placeholder="${input.placeholder}"]`);
        }
        if (input.ngModel) {
            inputsByNgModel.set(input.ngModel, `input[ng-model="${input.ngModel}"]`);
        }
    }

    // Helper to find and fill an input by various strategies
    async function fillInput(value: string, strategies: string[]): Promise<boolean> {
        for (const strategy of strategies) {
            try {
                const el = await page.$(strategy);
                if (el) {
                    await el.click({ clickCount: 3 });
                    await el.type(value, { delay: 30 });
                    console.error(`Filled input using: ${strategy}`);
                    return true;
                }
            } catch (e) {
                continue;
            }
        }
        return false;
    }

    // Helper to find and select from dropdown
    async function fillSelect(value: string, strategies: string[]): Promise<boolean> {
        for (const strategy of strategies) {
            try {
                const el = await page.$(strategy);
                if (el) {
                    // Try clicking to open dropdown then type to filter
                    await el.click();
                    await new Promise(r => setTimeout(r, 300));
                    await page.keyboard.type(value, { delay: 50 });
                    await page.keyboard.press('Enter');
                    console.error(`Selected from: ${strategy}`);
                    return true;
                }
            } catch (e) {
                continue;
            }
        }
        return false;
    }

    // 1. Free text search
    if (params.freeText) {
        attempted++;
        // Build selectors from discovered elements + fallbacks
        const selectors = [
            ...Array.from(inputsByNgModel.entries())
                .filter(([k]) => k.toLowerCase().includes('freetext') || k.toLowerCase().includes('search'))
                .map(([, v]) => v),
            ...Array.from(inputsByPlaceholder.entries())
                .filter(([k]) => k.includes('חיפוש') || k.includes('טקסט'))
                .map(([, v]) => v),
            'input[type="search"]',
            'input[type="text"]'
        ];
        const success = await fillInput(params.freeText, selectors);
        if (success) applied++;
    }

    // 2. City/Committee filter
    if (params.city) {
        attempted++;
        const selectors = [
            ...Array.from(inputsByNgModel.entries())
                .filter(([k]) => k.toLowerCase().includes('committee') || k.toLowerCase().includes('city'))
                .map(([, v]) => v),
            ...Array.from(inputsByPlaceholder.entries())
                .filter(([k]) => k.includes('ועדה') || k.includes('עיר'))
                .map(([, v]) => v),
            'select[ng-model*="Committee"]',
            'select[ng-model*="committee"]'
        ];
        const success = await fillInput(params.city, selectors) || await fillSelect(params.city, selectors);
        if (success) applied++;
    }

    // 3. Block number (גוש)
    if (params.blockNumber) {
        attempted++;
        const selectors = [
            ...Array.from(inputsByNgModel.entries())
                .filter(([k]) => k.toLowerCase().includes('block') || k.toLowerCase().includes('gush'))
                .map(([, v]) => v),
            ...Array.from(inputsByPlaceholder.entries())
                .filter(([k]) => k.includes('גוש'))
                .map(([, v]) => v),
            'input[placeholder*="גוש"]'
        ];
        const success = await fillInput(params.blockNumber, selectors);
        if (success) applied++;
    }

    // 4. Plot number (חלקה)
    if (params.plotNumber) {
        attempted++;
        const selectors = [
            ...Array.from(inputsByNgModel.entries())
                .filter(([k]) => k.toLowerCase().includes('plot') || k.toLowerCase().includes('helka'))
                .map(([, v]) => v),
            ...Array.from(inputsByPlaceholder.entries())
                .filter(([k]) => k.includes('חלקה'))
                .map(([, v]) => v),
            'input[placeholder*="חלקה"]'
        ];
        const success = await fillInput(params.plotNumber, selectors);
        if (success) applied++;
    }

    // 5. Case type
    if (params.caseType) {
        attempted++;
        const selectors = structure.selects
            .filter((s: any) => s.ngModel && (
                s.ngModel.toLowerCase().includes('type') ||
                s.ngModel.toLowerCase().includes('appraisal')
            ))
            .map((s: any) => `select[ng-model="${s.ngModel}"]`);
        const success = await fillSelect(params.caseType, selectors);
        if (success) applied++;
    }

    // 6. Year filters
    if (params.yearFrom) {
        attempted++;
        const fromDate = `01/01/${params.yearFrom}`;
        const selectors = [
            ...Array.from(inputsByNgModel.entries())
                .filter(([k]) => k.toLowerCase().includes('from') || k.toLowerCase().includes('start'))
                .map(([, v]) => v),
            ...Array.from(inputsByPlaceholder.entries())
                .filter(([k]) => k.includes('מתאריך'))
                .map(([, v]) => v)
        ];
        const success = await fillInput(fromDate, selectors);
        if (success) applied++;
    }

    if (params.yearTo) {
        attempted++;
        const toDate = `31/12/${params.yearTo}`;
        const selectors = [
            ...Array.from(inputsByNgModel.entries())
                .filter(([k]) => k.toLowerCase().includes('to') || k.toLowerCase().includes('end'))
                .map(([, v]) => v),
            ...Array.from(inputsByPlaceholder.entries())
                .filter(([k]) => k.includes('עד') || k.includes('תאריך'))
                .map(([, v]) => v)
        ];
        const success = await fillInput(toDate, selectors);
        if (success) applied++;
    }

    // Click search/filter button
    const buttonSelectors = structure.buttons
        .filter((b: any) => b.ngClick && (
            b.ngClick.includes('search') ||
            b.ngClick.includes('Search') ||
            b.ngClick.includes('filter')
        ))
        .map((b: any) => `[ng-click="${b.ngClick}"]`);

    buttonSelectors.push(
        'button[type="submit"]',
        'button.btn-primary',
        'input[type="submit"]'
    );

    for (const selector of buttonSelectors) {
        try {
            const btn = await page.$(selector);
            if (btn) {
                await btn.click();
                console.error(`Clicked button: ${selector}`);
                break;
            }
        } catch (e) {
            continue;
        }
    }

    return { applied, attempted };
}

/**
 * Extract decisions from the loaded page
 */
async function extractDecisions(
    page: Page,
    databaseName: string,
    maxResults: number
): Promise<Decision[]> {

    const results = await page.evaluate((dbName: string, max: number) => {
        const items: any[] = [];

        // Strategy 1: Look for ng-repeat elements (common in Angular)
        const ngRepeatElements = document.querySelectorAll('[ng-repeat]');
        console.log(`Found ${ngRepeatElements.length} ng-repeat elements`);

        // Find the one that looks like results (has multiple similar children)
        let resultContainer: Element | null = null;
        ngRepeatElements.forEach(el => {
            const ngRepeat = el.getAttribute('ng-repeat') || '';
            if (ngRepeat.includes('item') || ngRepeat.includes('result') || ngRepeat.includes('data')) {
                // Check if parent has multiple similar children
                const parent = el.parentElement;
                if (parent && parent.children.length > 1) {
                    resultContainer = parent;
                }
            }
        });

        if (resultContainer) {
            const children = resultContainer.querySelectorAll(':scope > *');
            console.log(`Result container has ${children.length} children`);

            children.forEach((el, index) => {
                if (index >= max) return;

                // Extract title
                let title = '';
                const titleEl = el.querySelector('h1, h2, h3, h4, h5, strong, b, [class*="title"], [class*="header"]');
                if (titleEl) {
                    title = titleEl.textContent?.trim() || '';
                }
                if (!title) {
                    // Fallback: first line of text
                    const lines = el.textContent?.trim().split('\n').filter(l => l.trim().length > 5);
                    title = lines?.[0]?.substring(0, 200) || '';
                }

                if (!title || title.length < 5) return;

                // Extract PDF URL
                let url: string | null = null;
                const pdfLink = el.querySelector('a[href*=".pdf"], a[href*="Blob"], a[href*="blob"]') as HTMLAnchorElement;
                if (pdfLink) {
                    url = pdfLink.href;
                }

                // Extract date
                let date: string | null = null;
                const allText = el.textContent || '';
                const dateMatch = allText.match(/(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4})/);
                if (dateMatch) date = dateMatch[1];

                items.push({ title, url, date });
            });
        }

        // Strategy 2: Just find all PDF links as fallback
        if (items.length === 0) {
            console.log('Using PDF link fallback strategy');
            const pdfLinks = document.querySelectorAll('a[href*=".pdf"], a[href*="BlobFolder"], a[href*="blob"]');
            pdfLinks.forEach((link, index) => {
                if (index >= max) return;
                const anchor = link as HTMLAnchorElement;

                // Get title from link text or parent
                let title = anchor.textContent?.trim() || '';
                if (!title || title.length < 5) {
                    const parent = anchor.closest('[ng-repeat], [class*="item"], [class*="result"], li, tr');
                    if (parent) {
                        title = parent.textContent?.trim().split('\n')[0]?.substring(0, 200) || '';
                    }
                }
                if (!title || title.length < 5) {
                    title = anchor.href.split('/').pop() || 'Untitled';
                }

                items.push({
                    title,
                    url: anchor.href,
                    date: null
                });
            });
        }

        return items;
    }, databaseName, maxResults);

    return results.map((r: any) => ({
        ...r,
        database: databaseName
    }));
}

/**
 * Check if URL has Hebrew characters in the filename
 */
function hasHebrewFilename(url: string): boolean {
    try {
        const urlObj = new URL(url);
        const path = urlObj.pathname;
        const filename = path.split('/').pop() || '';
        // Check for Hebrew Unicode range or URL-encoded Hebrew
        const hasHebrew = /[\u0590-\u05FF]/.test(decodeURIComponent(filename));
        const hasEncodedHebrew = /%D7%/.test(filename); // Hebrew chars start with %D7%
        return hasHebrew || hasEncodedHebrew;
    } catch {
        return false;
    }
}

/**
 * Extract filename from PDF URL for display
 */
function extractPDFFilename(url: string): string {
    try {
        const urlObj = new URL(url);
        const path = urlObj.pathname;
        const filename = path.split('/').pop() || '';
        return decodeURIComponent(filename);
    } catch {
        return url;
    }
}

/**
 * Fetch and extract PDF content with graceful fallback for inaccessible URLs
 */
async function extractPDFContent(pdfUrl: string): Promise<{ text: string; numPages: number; fallback?: boolean }> {
    console.error(`Fetching PDF: ${pdfUrl}`);

    const response = await fetch(pdfUrl, {
        headers: {
            'Accept': 'application/pdf',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    if (!response.ok) {
        const filename = extractPDFFilename(pdfUrl);
        const isHebrew = hasHebrewFilename(pdfUrl);

        // Provide helpful error message with fallback
        let fallbackMessage = `## לא ניתן לגשת לקובץ PDF\n\n`;
        fallbackMessage += `**שם הקובץ:** ${filename}\n`;
        fallbackMessage += `**סטטוס:** ${response.status} ${response.statusText}\n\n`;

        if (isHebrew && response.status === 404) {
            fallbackMessage += `**סיבה:** קבצי PDF עם שמות בעברית לא נגישים דרך ה-API של gov.il.\n`;
            fallbackMessage += `זוהי בעיה ידועה בשרת gov.il - כתובות URL עם שמות עבריים מחזירות שגיאה 404.\n\n`;
        }

        fallbackMessage += `### פתרון:\n`;
        fallbackMessage += `פתח את הקישור הבא בדפדפן:\n`;
        fallbackMessage += `${pdfUrl}\n\n`;
        fallbackMessage += `**טיפ:** ניתן להעתיק את הקישור ולפתוח ישירות בדפדפן.`;

        return {
            text: fallbackMessage,
            numPages: 0,
            fallback: true
        };
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const data = await pdf(buffer);

    return {
        text: data.text,
        numPages: data.numpages,
        fallback: false
    };
}

/**
 * Format decisions for output
 */
function formatDecisions(decisions: Decision[], params: SearchParams, filterStats?: { applied: number; attempted: number }): string {
    const lines: string[] = [];
    const dbInfo = DATABASES[params.database];

    lines.push(`## תוצאות חיפוש - ${dbInfo.name}`);
    lines.push('');

    // Show filter status
    if (filterStats && filterStats.attempted > 0) {
        if (filterStats.applied === 0) {
            lines.push('**אזהרה:** לא הצלחנו להחיל את הפילטרים. ייתכן שמבנה הדף השתנה.');
            lines.push('');
        } else if (filterStats.applied < filterStats.attempted) {
            lines.push(`הוחלו ${filterStats.applied} מתוך ${filterStats.attempted} פילטרים`);
            lines.push('');
        }
    }

    // Show search parameters
    lines.push('**פרמטרי חיפוש:**');
    if (params.freeText) lines.push(`- טקסט חופשי: ${params.freeText}`);
    if (params.city) lines.push(`- עיר/ועדה: ${params.city}`);
    if (params.blockNumber) lines.push(`- גוש: ${params.blockNumber}`);
    if (params.plotNumber) lines.push(`- חלקה: ${params.plotNumber}`);
    if (params.caseType) lines.push(`- סוג תיק: ${params.caseType}`);
    if (params.appraiserName) lines.push(`- שמאי: ${params.appraiserName}`);
    if (params.yearFrom) lines.push(`- משנת: ${params.yearFrom}`);
    if (params.yearTo) lines.push(`- עד שנת: ${params.yearTo}`);
    lines.push('');

    lines.push(`**נמצאו ${decisions.length} תוצאות:**`);
    lines.push('');

    if (decisions.length === 0) {
        lines.push('לא נמצאו תוצאות התואמות לחיפוש.');
        lines.push('');
        lines.push('נסה:');
        lines.push('- להרחיב את טווח התאריכים');
        lines.push('- להסיר חלק מהפילטרים');
        lines.push('- לבדוק את איות שם העיר');
    } else {
        for (let i = 0; i < decisions.length; i++) {
            const d = decisions[i];
            lines.push(`### ${i + 1}. ${d.title}`);
            if (d.date) lines.push(`תאריך: ${d.date}`);
            if (d.url) lines.push(`PDF: ${d.url}`);
            lines.push('');
        }
    }

    return lines.join('\n');
}

// Main server setup
async function main() {
    const server = new Server(
        {
            name: 'gov-il-land-appraisal-live',
            version: '2.1.0'
        },
        {
            capabilities: {
                tools: {}
            }
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return { tools: TOOLS };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        try {
            switch (name) {
                case 'search_decisions': {
                    const rawArgs = args as Record<string, any>;
                    const params: SearchParams = {
                        database: rawArgs.database || 'decisive_appraiser',
                        freeText: rawArgs.freeText,
                        city: rawArgs.city,
                        blockNumber: rawArgs.blockNumber,
                        plotNumber: rawArgs.plotNumber,
                        caseType: rawArgs.caseType,
                        appraiserName: rawArgs.appraiserName,
                        yearFrom: rawArgs.yearFrom,
                        yearTo: rawArgs.yearTo,
                        maxResults: rawArgs.maxResults || 30
                    };

                    const decisions = await searchWithPuppeteer(params);
                    const formatted = formatDecisions(decisions, params);

                    return {
                        content: [{ type: 'text', text: formatted }]
                    };
                }

                case 'read_decision_pdf': {
                    const pdfUrl = (args as any).pdfUrl as string;
                    const content = await extractPDFContent(pdfUrl);

                    let output: string;
                    if (content.fallback) {
                        // Fallback case - PDF was inaccessible
                        output = content.text;
                    } else {
                        // Success case - PDF content extracted
                        output = [
                            `## תוכן ההחלטה`,
                            `עמודים: ${content.numPages}`,
                            '',
                            '---',
                            '',
                            content.text
                        ].join('\n');
                    }

                    return {
                        content: [{ type: 'text', text: output }]
                    };
                }

                case 'list_databases': {
                    const list = Object.entries(DATABASES)
                        .map(([key, db]) => `### ${db.name} (${db.nameEn})\n- מזהה: \`${key}\`\n- ${db.description}\n- [קישור](${db.url})`)
                        .join('\n\n');

                    return {
                        content: [{ type: 'text', text: `# מאגרי מידע זמינים\n\n${list}` }]
                    };
                }

                case 'debug_page': {
                    const rawArgs = args as Record<string, any>;
                    const dbInfo = DATABASES[rawArgs.database || 'decisive_appraiser'];

                    const browser = await getBrowser();
                    const page = await browser.newPage();

                    try {
                        await page.goto(dbInfo.url, { waitUntil: 'networkidle2', timeout: 30000 });
                        await waitForAngular(page);

                        const structure = await discoverPageStructure(page);

                        const output = [
                            '# Page Structure Discovery',
                            '',
                            `## Inputs (${structure.inputs.length})`,
                            '```json',
                            JSON.stringify(structure.inputs, null, 2),
                            '```',
                            '',
                            `## Selects (${structure.selects.length})`,
                            '```json',
                            JSON.stringify(structure.selects, null, 2),
                            '```',
                            '',
                            `## Buttons (${structure.buttons.length})`,
                            '```json',
                            JSON.stringify(structure.buttons, null, 2),
                            '```',
                            '',
                            `## PDF Links (${structure.links.length})`,
                            '```json',
                            JSON.stringify(structure.links, null, 2),
                            '```',
                            '',
                            `## Result Containers (${structure.resultContainers.length})`,
                            '```json',
                            JSON.stringify(structure.resultContainers.slice(0, 20), null, 2),
                            '```',
                            '',
                            '## Sample Classes',
                            (structure.allClasses as string[]).slice(0, 100).join(', ')
                        ].join('\n');

                        return {
                            content: [{ type: 'text', text: output }]
                        };
                    } finally {
                        await page.close();
                    }
                }

                default:
                    return {
                        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                        isError: true
                    };
            }
        } catch (error) {
            console.error('Tool error:', error);
            return {
                content: [{ type: 'text', text: `שגיאה: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true
            };
        }
    });

    // Cleanup on exit
    process.on('SIGINT', async () => {
        if (browserInstance) {
            await browserInstance.close();
        }
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        if (browserInstance) {
            await browserInstance.close();
        }
        process.exit(0);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Gov.il Land Appraisal MCP Server v2.1 (with selector discovery) started');
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
