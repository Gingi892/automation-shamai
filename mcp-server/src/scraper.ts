/**
 * Web Scraper for Gov.il Land Appraisal Decisions
 * Uses ScraperAPI for rendering dynamic content
 */

import * as cheerio from 'cheerio';
import crypto from 'crypto';
import {
  DatabaseType,
  ParsedDecision,
  Decision,
  DATABASE_CONFIG
} from './types.js';

export interface ScraperOptions {
  apiKey: string;
  delayMs?: number;
  premium?: boolean;
  render?: boolean;
}

/**
 * Selector strategy types for fallback system
 * Order: css_primary → xpath_patterns → css_structural → regex_fallback → cached_data
 */
export type SelectorStrategyType = 'css_primary' | 'xpath_patterns' | 'css_structural' | 'regex_fallback' | 'cached_data';

export interface SelectorStrategyResult {
  strategy: SelectorStrategyType;
  success: boolean;
  itemCount: number;
}

/**
 * Health check result for selector validation
 */
export interface SelectorHealthResult {
  database: DatabaseType;
  healthy: boolean;
  timestamp: string;
  strategies: {
    css_primary: { working: boolean; itemCount: number };
    xpath_patterns: { working: boolean; itemCount: number };
    css_structural: { working: boolean; itemCount: number };
    regex_fallback: { working: boolean; itemCount: number };
    cached_data: { working: boolean; itemCount: number };
  };
  recommendedStrategy: SelectorStrategyType | null;
  warnings: string[];
  error?: string;
}

/**
 * Callback type for retrieving cached data from database
 * Used as final fallback when all extraction strategies fail
 */
export type CachedDataProvider = (database: DatabaseType, page: number, pageSize: number) => ParsedDecision[];

/**
 * Alert information when primary strategy fails repeatedly
 */
export interface PrimaryStrategyAlert {
  consecutiveFailures: number;
  threshold: number;
  lastDatabase: DatabaseType | null;
  lastPage: number;
  timestamp: string;
  message: string;
}

/**
 * Callback type for alerting when primary strategy fails 3+ times consecutively
 * Called when the failure threshold is exceeded
 */
export type AlertHandler = (alert: PrimaryStrategyAlert) => void;

/**
 * XPath-like pattern for DOM traversal
 * Simplified XPath syntax: /tag[@attr=value]/child/...
 */
interface XPathPattern {
  // Path segments from root/context, e.g., ['div', 'ul', 'li']
  path: string[];
  // Attribute constraints for container matching
  attributes?: { [key: string]: string | RegExp };
  // Element text content pattern (optional)
  textPattern?: RegExp;
}

/**
 * Selector configuration for different extraction strategies
 */
interface SelectorConfig {
  // Primary CSS selectors (class-based)
  primary: {
    container: string[];
    title: string[];
    pdfLink: string[];
    date: string[];
  };
  // XPath-like patterns (path-based, resilient to class changes)
  xpath: {
    container: XPathPattern[];
    title: XPathPattern[];
    pdfLink: XPathPattern[];
    date: XPathPattern[];
  };
  // Structural CSS selectors (tag/attribute-based, less fragile)
  structural: {
    container: string[];
    title: string[];
    pdfLink: string[];
    date: string[];
  };
  // Regex patterns for raw HTML fallback
  regex: {
    title: RegExp[];
    pdfUrl: RegExp[];
    date: RegExp[];
  };
}

/**
 * Default selector configuration for gov.il dynamiccollectors
 */
const DEFAULT_SELECTORS: SelectorConfig = {
  primary: {
    container: [
      'div.dynamic-card',
      'div.result-item',
      'div.ng-scope[ng-repeat]',
      'li.ng-scope[ng-repeat]',
      '.govil-card',
      '.decision-item'
    ],
    title: [
      'h3.txt.bold',
      'h3.ng-binding',
      '.item-title',
      '.decision-title',
      'h3 a',
      'h4 a'
    ],
    pdfLink: [
      'a[href*="free-justice.openapi.gov.il"]',
      'a[href*="SearchPredefinedApi"]',
      'a[href*="DecisiveAppraiser"]',
      'a[href*=".pdf"]',
      '.pdf-link a',
      '.download-link a'
    ],
    date: [
      'bdi.ng-binding',
      '.date',
      '.publish-date',
      'span.date',
      '.decision-date'
    ]
  },
  // XPath-like patterns based on DOM structure (resilient to class name changes)
  xpath: {
    container: [
      // Pattern: //main//div[contains child heading and link]
      { path: ['main', 'div', 'div'], attributes: { 'data-ng-repeat': /.*/ } },
      // Pattern: //body//div[@ng-repeat]
      { path: ['body', 'div', 'div'], attributes: { 'ng-repeat': /.*/ } },
      // Pattern: //ul/li (list-based layouts)
      { path: ['main', 'ul', 'li'] },
      { path: ['div', 'ul', 'li'] },
      // Pattern: //table/tbody/tr (table-based layouts)
      { path: ['table', 'tbody', 'tr'] },
      // Pattern: //section/div (section-based layouts)
      { path: ['section', 'div'] },
      // Pattern: //article (semantic HTML)
      { path: ['article'] }
    ],
    title: [
      // Pattern: //h3[contains Hebrew text]
      { path: ['h3'], textPattern: /[\u0590-\u05FF]{5,}/ },
      // Pattern: //h4[contains Hebrew text]
      { path: ['h4'], textPattern: /[\u0590-\u05FF]{5,}/ },
      // Pattern: //a[contains Hebrew text and href to gov.il]
      { path: ['a'], attributes: { 'href': /gov\.il/ }, textPattern: /[\u0590-\u05FF]{5,}/ },
      // Pattern: //strong or //b with Hebrew decision text
      { path: ['strong'], textPattern: /הכרעת|החלטה|ערעור|ערר/ },
      { path: ['b'], textPattern: /הכרעת|החלטה|ערעור|ערר/ }
    ],
    pdfLink: [
      // Pattern: //a[@href contains 'pdf']
      { path: ['a'], attributes: { 'href': /\.pdf/i } },
      // Pattern: //a[@href contains 'free-justice']
      { path: ['a'], attributes: { 'href': /free-justice\.openapi\.gov\.il/ } },
      // Pattern: //a[@href contains 'openapi']
      { path: ['a'], attributes: { 'href': /openapi\.gov\.il/ } },
      // Pattern: //a[@target='_blank'] (common for document links)
      { path: ['a'], attributes: { 'target': '_blank', 'href': /gov\.il/ } }
    ],
    date: [
      // Pattern: //bdi[contains date text]
      { path: ['bdi'], textPattern: /\d{1,2}[./-]\d{1,2}[./-]\d{4}/ },
      // Pattern: //time[@datetime]
      { path: ['time'], attributes: { 'datetime': /.*/ } },
      // Pattern: //span[contains date pattern]
      { path: ['span'], textPattern: /\d{1,2}[./-]\d{1,2}[./-]\d{4}/ }
    ]
  },
  structural: {
    container: [
      'div[ng-repeat]',
      'li[ng-repeat]',
      'tr[ng-repeat]',
      'article',
      'section > div > div',
      'main ul > li',
      'main ol > li'
    ],
    title: [
      'h3:first-of-type',
      'h4:first-of-type',
      'a[href*="gov.il"]',
      '[dir="rtl"] > *:first-child',
      'strong:first-of-type'
    ],
    pdfLink: [
      'a[href$=".pdf"]',
      'a[href*="openapi"]',
      'a[target="_blank"]'
    ],
    date: [
      'bdi',
      'time',
      'span:last-of-type',
      '[datetime]'
    ]
  },
  regex: {
    title: [
      // Match full decision title format: הכרעת שמאי מכריע מיום DD-MM-YYYY בעניין...
      /הכרעת שמאי מכריע מיום \d{2}-\d{2}-\d{4} בעניין[^<\n"]{10,300}/g,
      /הכרעת שמאי מייעץ מיום \d{2}-\d{2}-\d{4} בעניין[^<\n"]{10,300}/g,
      /הכרעת שמאי[^<\n"]{10,250}/g,
      /החלטה בהשגה[^<\n"]{10,200}/g,
      /ערעור מס[^<\n"]{10,200}/g,
      /<h3[^>]*>([^<]{10,300})<\/h3>/gi
    ],
    pdfUrl: [
      // Match free-justice API URLs (no .pdf extension needed)
      /https?:\/\/free-justice\.openapi\.gov\.il\/free\/moj\/portal\/rest\/[^\s"'<>]+/gi,
      /href=["'](https?:\/\/free-justice\.openapi\.gov\.il[^"']+)["']/gi,
      /https?:\/\/[^"'\s<>]*\.gov\.il[^"'\s<>]*\.pdf/gi
    ],
    date: [
      /(\d{2}-\d{2}-\d{4})/g,
      /(\d{1,2}[./-]\d{1,2}[./-]\d{4})/g,
      /(\d{4}[./-]\d{1,2}[./-]\d{1,2})/g
    ]
  }
};

export class GovIlScraper {
  private apiKey: string;
  private delayMs: number;
  private premium: boolean;
  private render: boolean;
  private pageSize = 10; // Gov.il uses 10 items per page
  private selectors: SelectorConfig;
  private lastStrategyUsed: SelectorStrategyType | null = null;
  private strategyStats: Map<SelectorStrategyType, { success: number; fail: number }> = new Map();
  private cachedDataProvider: CachedDataProvider | null = null;
  private currentPage: number = 0;
  private currentDatabase: DatabaseType | null = null;

  // Alert mechanism for primary strategy failures
  private consecutivePrimaryFailures: number = 0;
  private readonly PRIMARY_FAILURE_THRESHOLD = 3;
  private alertHandler: AlertHandler | null = null;
  private alertTriggered: boolean = false;

  constructor(options: ScraperOptions) {
    this.apiKey = options.apiKey;
    this.delayMs = options.delayMs || 1000;
    this.premium = options.premium ?? true;
    this.render = options.render ?? true;
    this.selectors = DEFAULT_SELECTORS;

    // Initialize strategy stats
    this.strategyStats.set('css_primary', { success: 0, fail: 0 });
    this.strategyStats.set('xpath_patterns', { success: 0, fail: 0 });
    this.strategyStats.set('css_structural', { success: 0, fail: 0 });
    this.strategyStats.set('regex_fallback', { success: 0, fail: 0 });
    this.strategyStats.set('cached_data', { success: 0, fail: 0 });
  }

  /**
   * Set the cached data provider for fallback when all strategies fail
   * The provider should return cached decisions from the database
   */
  setCachedDataProvider(provider: CachedDataProvider): void {
    this.cachedDataProvider = provider;
  }

  /**
   * Get the cached data provider
   */
  getCachedDataProvider(): CachedDataProvider | null {
    return this.cachedDataProvider;
  }

  /**
   * Get the last strategy that successfully extracted decisions
   */
  getLastStrategyUsed(): SelectorStrategyType | null {
    return this.lastStrategyUsed;
  }

  /**
   * Get statistics on strategy usage
   */
  getStrategyStats(): Record<SelectorStrategyType, { success: number; fail: number }> {
    return Object.fromEntries(this.strategyStats) as Record<SelectorStrategyType, { success: number; fail: number }>;
  }

  /**
   * Set the alert handler for primary strategy failures
   * Called when css_primary fails 3+ times consecutively
   */
  setAlertHandler(handler: AlertHandler): void {
    this.alertHandler = handler;
  }

  /**
   * Get the current consecutive primary failure count
   */
  getConsecutivePrimaryFailures(): number {
    return this.consecutivePrimaryFailures;
  }

  /**
   * Reset the primary failure counter (useful for testing or after manual intervention)
   */
  resetPrimaryFailureCount(): void {
    this.consecutivePrimaryFailures = 0;
    this.alertTriggered = false;
    console.error('[Scraper] Primary failure counter reset');
  }

  /**
   * Track primary strategy failures and trigger alert if threshold exceeded
   */
  private handlePrimaryStrategyResult(success: boolean): void {
    if (success) {
      // Reset counter on success
      if (this.consecutivePrimaryFailures > 0) {
        console.error(`[Scraper] Primary strategy recovered after ${this.consecutivePrimaryFailures} consecutive failures`);
      }
      this.consecutivePrimaryFailures = 0;
      this.alertTriggered = false;
    } else {
      // Increment failure counter
      this.consecutivePrimaryFailures++;

      // Check if we've hit the threshold
      if (this.consecutivePrimaryFailures >= this.PRIMARY_FAILURE_THRESHOLD && !this.alertTriggered) {
        this.alertTriggered = true;

        const alert: PrimaryStrategyAlert = {
          consecutiveFailures: this.consecutivePrimaryFailures,
          threshold: this.PRIMARY_FAILURE_THRESHOLD,
          lastDatabase: this.currentDatabase,
          lastPage: this.currentPage,
          timestamp: new Date().toISOString(),
          message: `ALERT: Primary CSS selectors failed ${this.consecutivePrimaryFailures} consecutive times. ` +
            `Selectors may need updating. Last attempt: database=${this.currentDatabase}, page=${this.currentPage}`
        };

        // Always log the alert to stderr
        console.error(`[Scraper] ⚠️ ${alert.message}`);

        // Call custom alert handler if configured
        if (this.alertHandler) {
          try {
            this.alertHandler(alert);
          } catch (err) {
            console.error('[Scraper] Error in alert handler:', err);
          }
        }
      }
    }
  }

  /**
   * Log strategy result to stderr (not stdout, to preserve MCP protocol)
   */
  private logStrategy(strategy: SelectorStrategyType, success: boolean, count: number): void {
    const stats = this.strategyStats.get(strategy)!;
    if (success) {
      stats.success++;
      console.error(`[Scraper] Strategy '${strategy}' succeeded: extracted ${count} items`);
    } else {
      stats.fail++;
      console.error(`[Scraper] Strategy '${strategy}' failed, trying next fallback...`);
    }
  }

  /**
   * Build the ScraperAPI URL for a gov.il page
   * Uses ultra_premium=true which is required for gov.il (protected site)
   * wait_for=5000 ensures Angular app has time to render content
   */
  private buildScraperUrl(targetUrl: string): string {
    const params = new URLSearchParams({
      api_key: this.apiKey,
      url: targetUrl,
      render: this.render.toString(),
      ultra_premium: 'true',  // Required for gov.il - premium alone fails
      wait_for: '5000'        // Wait 5 seconds for Angular to render
    });
    return `https://api.scraperapi.com?${params.toString()}`;
  }

  /**
   * Build the gov.il dynamiccollector URL for a specific page
   */
  private buildGovIlUrl(database: DatabaseType, skip: number): string {
    const baseUrl = DATABASE_CONFIG[database].url;
    return `${baseUrl}?skip=${skip}`;
  }

  /**
   * Fetch a page using ScraperAPI
   */
  async fetchPage(database: DatabaseType, page: number): Promise<string> {
    const skip = page * this.pageSize;
    const govIlUrl = this.buildGovIlUrl(database, skip);
    const scraperUrl = this.buildScraperUrl(govIlUrl);

    const response = await fetch(scraperUrl, {
      method: 'GET',
      headers: {
        'Accept': 'text/html'
      }
    });

    if (!response.ok) {
      throw new Error(`ScraperAPI error: ${response.status} ${response.statusText}`);
    }

    return response.text();
  }

  /**
   * Parse decisions from HTML page using multi-strategy fallback system
   * Strategy order: 1) CSS Primary, 2) XPath Patterns, 3) CSS Structural, 4) Regex fallback
   */
  parseDecisions(html: string, database: DatabaseType): ParsedDecision[] {
    // Strategy 1: CSS Primary selectors (class-based)
    let decisions = this.parseWithCssPrimary(html, database);
    if (decisions.length > 0) {
      this.lastStrategyUsed = 'css_primary';
      this.logStrategy('css_primary', true, decisions.length);
      this.handlePrimaryStrategyResult(true); // Reset failure counter on success
      return decisions;
    }
    this.logStrategy('css_primary', false, 0);
    this.handlePrimaryStrategyResult(false); // Track consecutive failure

    // Strategy 2: XPath patterns (path-based, resilient to class changes)
    decisions = this.parseWithXPathPatterns(html, database);
    if (decisions.length > 0) {
      this.lastStrategyUsed = 'xpath_patterns';
      this.logStrategy('xpath_patterns', true, decisions.length);
      console.error(`[Scraper] WARNING: Primary CSS selectors failed, XPath patterns succeeded`);
      return decisions;
    }
    this.logStrategy('xpath_patterns', false, 0);

    // Strategy 3: CSS Structural selectors (tag/attribute-based, more resilient)
    decisions = this.parseWithCssStructural(html, database);
    if (decisions.length > 0) {
      this.lastStrategyUsed = 'css_structural';
      this.logStrategy('css_structural', true, decisions.length);
      console.error(`[Scraper] WARNING: Primary and XPath selectors failed, structural selectors succeeded`);
      return decisions;
    }
    this.logStrategy('css_structural', false, 0);

    // Strategy 4: Regex fallback on raw HTML
    decisions = this.parseWithRegex(html, database);
    if (decisions.length > 0) {
      this.lastStrategyUsed = 'regex_fallback';
      this.logStrategy('regex_fallback', true, decisions.length);
      console.error(`[Scraper] WARNING: All CSS and XPath selectors failed, using regex fallback`);
      return decisions;
    }
    this.logStrategy('regex_fallback', false, 0);

    // Strategy 5: Return cached data with warning (final fallback)
    if (this.cachedDataProvider && this.currentDatabase) {
      decisions = this.cachedDataProvider(this.currentDatabase, this.currentPage, this.pageSize);
      if (decisions.length > 0) {
        this.lastStrategyUsed = 'cached_data';
        this.logStrategy('cached_data', true, decisions.length);
        console.error(`[Scraper] WARNING: All extraction strategies failed for ${database}. Returning ${decisions.length} cached decisions from database.`);
        console.error(`[Scraper] ⚠️ CACHED DATA FALLBACK - Data may be stale. Please check selector configuration.`);
        return decisions;
      }
      this.logStrategy('cached_data', false, 0);
    }

    // All strategies failed (including cache)
    console.error(`[Scraper] ERROR: All extraction strategies failed for ${database} (no cached data available)`);
    this.lastStrategyUsed = null;
    return [];
  }

  /**
   * Strategy 1: Parse using primary CSS selectors (class-based)
   */
  private parseWithCssPrimary(html: string, database: DatabaseType): ParsedDecision[] {
    const $ = cheerio.load(html);
    const decisions: ParsedDecision[] = [];

    // Try each container selector
    for (const containerSelector of this.selectors.primary.container) {
      $(containerSelector).each((_, element) => {
        const $el = $(element);
        const decision = this.extractDecisionFromElement($, $el, this.selectors.primary, database);
        if (decision) {
          decisions.push(decision);
        }
      });

      if (decisions.length > 0) {
        break; // Found items with this selector
      }
    }

    // Also try table-based layouts with primary selectors
    if (decisions.length === 0) {
      $('tr.ng-scope, tbody tr').each((_, element) => {
        const $row = $(element);
        const cells = $row.find('td');

        if (cells.length >= 2) {
          const title = cells.eq(0).text().trim() || cells.eq(1).text().trim();
          if (!title || title.length < 5) return;

          let url: string | null = null;
          for (const linkSelector of this.selectors.primary.pdfLink) {
            const link = $row.find(linkSelector).attr('href');
            if (link) {
              url = link.startsWith('http') ? link : `https://free-justice.openapi.gov.il${link}`;
              break;
            }
          }

          const metadata = this.parseTitleMetadata(title, database);

          decisions.push({
            title,
            url,
            block: metadata.block ?? null,
            plot: metadata.plot ?? null,
            committee: metadata.committee ?? null,
            appraiser: metadata.appraiser ?? null,
            caseType: metadata.caseType ?? null,
            decisionDate: metadata.decisionDate ?? null,
            publishDate: null
          });
        }
      });
    }

    return decisions;
  }

  /**
   * Strategy 2: Parse using XPath-like patterns (path-based, resilient to class changes)
   * Uses DOM path traversal to find elements based on structure rather than class names
   */
  private parseWithXPathPatterns(html: string, database: DatabaseType): ParsedDecision[] {
    const $ = cheerio.load(html);
    const decisions: ParsedDecision[] = [];

    // Try each XPath container pattern
    for (const containerPattern of this.selectors.xpath.container) {
      const containers = this.findElementsByXPathPattern($, containerPattern);

      for (const container of containers) {
        const $container = $(container);
        const decision = this.extractDecisionFromXPathElement($, $container, database);
        if (decision) {
          decisions.push(decision);
        }
      }

      if (decisions.length > 0) {
        break; // Found items with this pattern
      }
    }

    return decisions;
  }

  /**
   * Find elements matching an XPath-like pattern
   * Traverses DOM based on path segments and attribute constraints
   */
  private findElementsByXPathPattern($: cheerio.CheerioAPI, pattern: XPathPattern): cheerio.Element[] {
    const results: cheerio.Element[] = [];

    // Build a CSS selector from the path
    // e.g., ['main', 'div', 'div'] becomes 'main div div'
    const pathSelector = pattern.path.join(' ');

    $(pathSelector).each((_, element) => {
      // Check attribute constraints
      if (pattern.attributes) {
        let matchesAllAttrs = true;
        for (const [attrName, attrValue] of Object.entries(pattern.attributes)) {
          const elemAttr = $(element).attr(attrName);
          if (elemAttr === undefined) {
            matchesAllAttrs = false;
            break;
          }
          if (attrValue instanceof RegExp) {
            if (!attrValue.test(elemAttr)) {
              matchesAllAttrs = false;
              break;
            }
          } else if (elemAttr !== attrValue) {
            matchesAllAttrs = false;
            break;
          }
        }
        if (!matchesAllAttrs) return;
      }

      // Check text content pattern
      if (pattern.textPattern) {
        const text = $(element).text().trim();
        if (!pattern.textPattern.test(text)) return;
      }

      results.push(element);
    });

    return results;
  }

  /**
   * Extract decision data from an element found via XPath pattern
   */
  private extractDecisionFromXPathElement(
    $: cheerio.CheerioAPI,
    $container: ReturnType<cheerio.CheerioAPI>,
    database: DatabaseType
  ): ParsedDecision | null {
    // Try to extract title using XPath title patterns
    let title = '';
    for (const titlePattern of this.selectors.xpath.title) {
      const titleElements = this.findElementsByXPathPattern($, titlePattern);
      for (const titleEl of titleElements) {
        // Only consider elements within or matching the container
        if ($container.find(titleEl).length > 0 || $container.is(titleEl)) {
          const text = $(titleEl).text().trim();
          if (text && text.length >= 5) {
            title = text;
            break;
          }
        }
      }
      if (title) break;
    }

    // Fallback: try h3, h4, a within container
    if (!title || title.length < 5) {
      title = $container.find('h3').first().text().trim() ||
              $container.find('h4').first().text().trim() ||
              $container.find('a').first().text().trim();
    }

    if (!title || title.length < 5) return null;

    // Extract PDF URL using XPath patterns
    let url: string | null = null;
    for (const pdfPattern of this.selectors.xpath.pdfLink) {
      const pdfElements = this.findElementsByXPathPattern($, pdfPattern);
      for (const pdfEl of pdfElements) {
        if ($container.find(pdfEl).length > 0 || $container.is(pdfEl)) {
          const href = $(pdfEl).attr('href');
          if (href) {
            url = href.startsWith('http') ? href : `https://free-justice.openapi.gov.il${href}`;
            break;
          }
        }
      }
      if (url) break;
    }

    // Fallback: find any PDF link in container
    if (!url) {
      const anyPdfLink = $container.find('a[href*=".pdf"], a[href*="gov.il"]').first().attr('href');
      if (anyPdfLink) {
        url = anyPdfLink.startsWith('http') ? anyPdfLink : `https://free-justice.openapi.gov.il${anyPdfLink}`;
      }
    }

    // Extract date using XPath patterns
    let publishDate: string | null = null;
    for (const datePattern of this.selectors.xpath.date) {
      const dateElements = this.findElementsByXPathPattern($, datePattern);
      for (const dateEl of dateElements) {
        if ($container.find(dateEl).length > 0 || $container.is(dateEl)) {
          const text = $(dateEl).text().trim();
          const dateMatch = text.match(/(\d{1,2}[./-]\d{1,2}[./-]\d{4})/);
          if (dateMatch) {
            publishDate = dateMatch[1];
            break;
          }
          // Also check datetime attribute
          const datetime = $(dateEl).attr('datetime');
          if (datetime) {
            publishDate = datetime;
            break;
          }
        }
      }
      if (publishDate) break;
    }

    // Parse Hebrew title for metadata
    const metadata = this.parseTitleMetadata(title, database);

    return {
      title,
      url,
      block: metadata.block ?? null,
      plot: metadata.plot ?? null,
      committee: metadata.committee ?? null,
      appraiser: metadata.appraiser ?? null,
      caseType: metadata.caseType ?? null,
      decisionDate: metadata.decisionDate ?? null,
      publishDate
    };
  }

  /**
   * Strategy 3: Parse using structural CSS selectors (tag/attribute-based)
   */
  private parseWithCssStructural(html: string, database: DatabaseType): ParsedDecision[] {
    const $ = cheerio.load(html);
    const decisions: ParsedDecision[] = [];

    // Try each structural container selector
    for (const containerSelector of this.selectors.structural.container) {
      $(containerSelector).each((_, element) => {
        const $el = $(element);
        const decision = this.extractDecisionFromElement($, $el, this.selectors.structural, database);
        if (decision) {
          decisions.push(decision);
        }
      });

      if (decisions.length > 0) {
        break;
      }
    }

    return decisions;
  }

  /**
   * Strategy 4: Parse using regex patterns on raw HTML
   */
  private parseWithRegex(html: string, database: DatabaseType): ParsedDecision[] {
    const decisions: ParsedDecision[] = [];
    const titles: string[] = [];
    const pdfUrls: string[] = [];
    const dates: string[] = [];

    // Extract titles using regex patterns
    for (const titlePattern of this.selectors.regex.title) {
      const matches = html.match(titlePattern);
      if (matches && matches.length > 0) {
        for (const match of matches) {
          // Clean up HTML tags if captured
          const cleaned = match.replace(/<[^>]*>/g, '').trim();
          if (cleaned.length >= 10 && cleaned.length <= 300) {
            titles.push(cleaned);
          }
        }
        if (titles.length > 0) break;
      }
    }

    // Extract PDF URLs using regex patterns
    for (const pdfPattern of this.selectors.regex.pdfUrl) {
      const matches = html.match(pdfPattern);
      if (matches && matches.length > 0) {
        for (const match of matches) {
          // Handle href="..." captures
          const urlMatch = match.match(/href=["']([^"']+)["']/i);
          let url = urlMatch ? urlMatch[1] : match;
          // Clean up URL - remove trailing quotes or angle brackets
          url = url.replace(/["'<>].*$/, '');
          // Accept free-justice.openapi.gov.il URLs (no .pdf needed)
          if (url.includes('free-justice.openapi.gov.il') || url.includes('.pdf')) {
            pdfUrls.push(url.startsWith('http') ? url : `https:${url}`);
          }
        }
        if (pdfUrls.length > 0) break;
      }
    }

    // Extract dates using regex patterns
    for (const datePattern of this.selectors.regex.date) {
      const matches = html.match(datePattern);
      if (matches) {
        dates.push(...matches);
        break;
      }
    }

    // Combine extracted data into decisions
    for (let i = 0; i < titles.length; i++) {
      const title = titles[i];
      const url = pdfUrls[i] || null;
      const publishDate = dates[i] || null;
      const metadata = this.parseTitleMetadata(title, database);

      decisions.push({
        title,
        url,
        block: metadata.block ?? null,
        plot: metadata.plot ?? null,
        committee: metadata.committee ?? null,
        appraiser: metadata.appraiser ?? null,
        caseType: metadata.caseType ?? null,
        decisionDate: metadata.decisionDate ?? null,
        publishDate
      });
    }

    return decisions;
  }

  /**
   * Extract a decision from a DOM element using provided selectors
   */
  private extractDecisionFromElement(
    $: cheerio.CheerioAPI,
    $el: ReturnType<cheerio.CheerioAPI>,
    selectors: { title: string[]; pdfLink: string[]; date: string[] },
    database: DatabaseType
  ): ParsedDecision | null {
    // Try to extract title using selector list
    let title = '';
    for (const titleSelector of selectors.title) {
      title = $el.find(titleSelector).first().text().trim();
      if (title && title.length >= 5) break;
    }
    // Fallback: try h3, h4 directly
    if (!title || title.length < 5) {
      title = $el.find('h3').first().text().trim() || $el.find('h4').first().text().trim();
    }

    if (!title || title.length < 5) return null;

    // Extract PDF URL
    let url: string | null = null;
    for (const linkSelector of selectors.pdfLink) {
      const href = $el.find(linkSelector).attr('href');
      if (href) {
        url = href.startsWith('http') ? href : `https://free-justice.openapi.gov.il${href}`;
        break;
      }
    }

    // Extract date
    let publishDate: string | null = null;
    for (const dateSelector of selectors.date) {
      const dateText = $el.find(dateSelector).text().trim();
      const dateMatch = dateText.match(/(\d{1,2}[./-]\d{1,2}[./-]\d{4})/);
      if (dateMatch) {
        publishDate = dateMatch[1];
        break;
      }
    }

    // Parse Hebrew title for metadata
    const metadata = this.parseTitleMetadata(title, database);

    return {
      title,
      url,
      block: metadata.block ?? null,
      plot: metadata.plot ?? null,
      committee: metadata.committee ?? null,
      appraiser: metadata.appraiser ?? null,
      caseType: metadata.caseType ?? null,
      decisionDate: metadata.decisionDate ?? null,
      publishDate
    };
  }

  /**
   * Parse metadata from Hebrew decision title
   * Extracts: block, plot, committee, appraiser, caseType, decisionDate
   * Handles multiple title formats from all three databases
   */
  private parseTitleMetadata(title: string, database: DatabaseType): Partial<ParsedDecision> {
    const metadata: Partial<ParsedDecision> = {
      block: null,
      plot: null,
      committee: null,
      appraiser: null,
      caseType: null,
      decisionDate: null
    };

    // ====== Strategy 1: Full pattern for decisive appraiser decisions ======
    // Format: הכרעת שמאי מכריע מיום DD-MM-YYYY בעניין [caseType] נ [committee] ג [block] ח [plot] - [appraiser]
    const decisivePattern = /הכרעת שמאי (מכריע|מייעץ) מיום (\d{2}-\d{2}-\d{4}) בעניין ([^נ]+)נ ([^ג]+)ג (\d+) ח (\d+)\s*-?\s*(.+)?/;
    const decisiveMatch = title.match(decisivePattern);

    if (decisiveMatch) {
      metadata.decisionDate = decisiveMatch[2];
      metadata.caseType = decisiveMatch[3].trim();
      metadata.committee = decisiveMatch[4].trim().replace(/ועדה מקומית\s*/i, '').trim();
      metadata.block = decisiveMatch[5];
      metadata.plot = decisiveMatch[6];
      if (decisiveMatch[7]) {
        metadata.appraiser = decisiveMatch[7].trim();
      }
      return metadata;
    }

    // ====== Strategy 2: Appeals committee pattern ======
    // Format: החלטה בהשגה [number] [committee] גוש [block] חלקה [plot]
    const appealsCommitteePattern = /החלטה ב?השגה(?:\s+מס['׳]?\s*|\s+)(\d+)?\s*([^גג]+)?[גג](?:וש)?\s*(\d+)\s*[חח](?:לקה)?\s*(\d+)/;
    const appealsCommMatch = title.match(appealsCommitteePattern);

    if (appealsCommMatch) {
      if (appealsCommMatch[2]) {
        metadata.committee = appealsCommMatch[2].trim().replace(/ועדה מקומית\s*/i, '').trim();
      }
      metadata.block = appealsCommMatch[3];
      metadata.plot = appealsCommMatch[4];
      // Default case type for appeals committee
      if (!metadata.caseType) {
        metadata.caseType = 'השגה';
      }
    }

    // ====== Strategy 3: Appeals board pattern ======
    // Format: ערעור [number] [details] / ערר מס' [number]
    const appealsBoardPattern = /ערעור|ערר\s*מס['׳]?\s*(\d+)?/;
    const appealsBoardMatch = title.match(appealsBoardPattern);

    if (appealsBoardMatch) {
      // Default case type for appeals board
      if (!metadata.caseType) {
        metadata.caseType = 'ערעור';
      }
    }

    // ====== Extract block and plot (multiple patterns) ======
    if (!metadata.block || !metadata.plot) {
      // Pattern 1: ג XXXX ח YYYY (short form)
      const blockPlotShort = title.match(/[גג]\s*(\d+)\s*[חח]\s*(\d+)/);
      if (blockPlotShort) {
        metadata.block = metadata.block || blockPlotShort[1];
        metadata.plot = metadata.plot || blockPlotShort[2];
      }

      // Pattern 2: גוש XXXX חלקה YYYY (long form)
      const blockPlotLong = title.match(/גוש\s*(\d+)\s*(?:,?\s*)?חלקה\s*(\d+)/);
      if (blockPlotLong) {
        metadata.block = metadata.block || blockPlotLong[1];
        metadata.plot = metadata.plot || blockPlotLong[2];
      }

      // Pattern 3: Block/Plot in parentheses (גוש 1234, חלקה 56)
      const blockPlotParen = title.match(/גוש\s*(\d+)\s*,\s*חלקה\s*(\d+)/);
      if (blockPlotParen) {
        metadata.block = metadata.block || blockPlotParen[1];
        metadata.plot = metadata.plot || blockPlotParen[2];
      }
    }

    // ====== Extract committee (multiple patterns) ======
    if (!metadata.committee) {
      // Pattern 1: ועדה מקומית לתכנון ובניה XXX
      const committeeFullMatch = title.match(/ועדה מקומית(?:\s+לתכנון\s+(?:ו)?בניה)?\s+([א-ת\s-]+?)(?:\s+גוש|\s+[גג]\s|\s+-|$)/);
      if (committeeFullMatch) {
        metadata.committee = committeeFullMatch[1].trim();
      }

      // Pattern 2: Short committee name after 'נ'
      const committeeAfterN = title.match(/\sנ\s+([א-ת\s-]+?)(?:\s+גוש|\s+[גג]\s)/);
      if (committeeAfterN && !metadata.committee) {
        metadata.committee = committeeAfterN[1].trim().replace(/ועדה מקומית\s*/i, '').trim();
      }

      // Pattern 3: Committee in context with לתו"ב
      const committeeTub = title.match(/לתו"ב\s+([א-ת\s-]+?)(?:\s+גוש|\s+[גג]\s|\s+-|$)/);
      if (committeeTub && !metadata.committee) {
        metadata.committee = committeeTub[1].trim();
      }
    }

    // ====== Extract appraiser (multiple patterns) ======
    if (!metadata.appraiser) {
      // Pattern 1: After hyphen at end (common in decisive appraiser format)
      const appraiserHyphen = title.match(/\s-\s*([א-ת\s]+)$/);
      if (appraiserHyphen) {
        metadata.appraiser = appraiserHyphen[1].trim();
      }

      // Pattern 2: שמאי/שמאית [name]
      const appraiserTitle = title.match(/שמאי(?:ת)?\s+(?:מכריע(?:ה)?|מייעץ|מייעצת)?\s*[:-]?\s*([א-ת\s']+?)(?:\s+מיום|\s+החליט|$)/);
      if (appraiserTitle && !metadata.appraiser) {
        metadata.appraiser = appraiserTitle[1].trim();
      }

      // Pattern 3: After colon in metadata section
      const appraiserColon = title.match(/שמאי\s*:\s*([א-ת\s']+?)(?:\s*[,;]|$)/);
      if (appraiserColon && !metadata.appraiser) {
        metadata.appraiser = appraiserColon[1].trim();
      }
    }

    // ====== Extract date (multiple patterns) ======
    if (!metadata.decisionDate) {
      // Pattern 1: DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY
      const dateStandard = title.match(/(\d{1,2})[-./](\d{1,2})[-./](\d{4})/);
      if (dateStandard) {
        const day = dateStandard[1].padStart(2, '0');
        const month = dateStandard[2].padStart(2, '0');
        const year = dateStandard[3];
        metadata.decisionDate = `${day}-${month}-${year}`;
      }

      // Pattern 2: After "מיום" keyword
      const dateMiyom = title.match(/מיום\s+(\d{1,2}[-./]\d{1,2}[-./]\d{4})/);
      if (dateMiyom && !metadata.decisionDate) {
        metadata.decisionDate = dateMiyom[1].replace(/[./]/g, '-');
      }

      // Pattern 3: YYYY-MM-DD (ISO format)
      const dateISO = title.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (dateISO && !metadata.decisionDate) {
        metadata.decisionDate = `${dateISO[3]}-${dateISO[2]}-${dateISO[1]}`;
      }
    }

    // ====== Extract case type (comprehensive list) ======
    if (!metadata.caseType) {
      // Priority order: most specific to general
      const caseTypes: [RegExp, string][] = [
        [/היטל השבחה/, 'היטל השבחה'],
        [/פיצויים?\s*(?:בגין|על|בשל)?\s*הפקעה/, 'פיצויים בגין הפקעה'],
        [/פיצויי(?:ם)?\s+(?:בגין\s+)?תכנית/, 'פיצויים'],
        [/פיצויים/, 'פיצויים'],
        [/ירידת ערך/, 'ירידת ערך'],
        [/השבחה/, 'היטל השבחה'],
        [/196\s*א/, '196א'],
        [/197/, '197'],
        [/השגה/, 'השגה'],
        [/ערעור|ערר/, 'ערעור'],
        [/שומה/, 'שומה']
      ];

      for (const [pattern, caseType] of caseTypes) {
        if (pattern.test(title)) {
          metadata.caseType = caseType;
          break;
        }
      }
    }

    return metadata;
  }

  /**
   * Extract year from a date string in DD-MM-YYYY or similar format
   */
  private extractYear(dateStr: string | null): string | null {
    if (!dateStr) return null;

    // Try to extract 4-digit year from various date formats
    const yearMatch = dateStr.match(/(\d{4})/);
    if (yearMatch) {
      return yearMatch[1];
    }

    return null;
  }

  /**
   * Convert parsed decision to database Decision object
   * Follows PRD US-P2-003 Pinecone Schema:
   * - id: unique, deterministic format: ${database}-${contentHash.slice(0,12)}
   * - contentHash: prevents duplicates
   * - year: extracted from decisionDate for filtering
   */
  toDecision(parsed: ParsedDecision, database: DatabaseType): Omit<Decision, 'indexedAt'> {
    const contentForHash = `${parsed.title}|${parsed.url || ''}|${database}`;
    const contentHash = crypto.createHash('md5').update(contentForHash).digest('hex');
    const id = `${database}-${contentHash.substring(0, 12)}`;

    // Extract year from decisionDate for year-based filtering (PRD requirement)
    const year = this.extractYear(parsed.decisionDate);

    return {
      id,
      database,
      title: parsed.title,
      url: parsed.url,
      block: parsed.block,
      plot: parsed.plot,
      committee: parsed.committee,
      appraiser: parsed.appraiser,
      caseType: parsed.caseType,
      decisionDate: parsed.decisionDate,
      year,
      publishDate: parsed.publishDate,
      contentHash,
      pdfText: null  // PDF text is extracted separately, not from HTML scraping
    };
  }

  /**
   * Fetch and parse a single page
   */
  async fetchAndParse(database: DatabaseType, page: number): Promise<Omit<Decision, 'indexedAt'>[]> {
    // Store current context for cached data fallback
    this.currentDatabase = database;
    this.currentPage = page;

    const html = await this.fetchPage(database, page);
    const parsed = this.parseDecisions(html, database);

    // Log final strategy used for this fetch operation
    const strategyUsed = this.getLastStrategyUsed();
    if (strategyUsed) {
      console.error(`[Scraper] ✓ ${database} page ${page}: Strategy '${strategyUsed}' succeeded (${parsed.length} items)`);
    } else {
      console.error(`[Scraper] ✗ ${database} page ${page}: All strategies failed (0 items)`);
    }

    return parsed.map(p => this.toDecision(p, database));
  }

  /**
   * Check if a page has more results
   */
  hasMoreResults(html: string): boolean {
    const $ = cheerio.load(html);

    // Check for pagination or "next" button
    const hasNextButton = $('a.next, button.next, .pagination .next:not(.disabled)').length > 0;

    // Check for results count indicator
    const resultsText = $('.results-count, .total-results').text();
    const totalMatch = resultsText.match(/(\d+)/);

    // Check if page has content
    const hasContent = $('div.dynamic-card, div.result-item, tr.ng-scope').length > 0;

    return hasNextButton || hasContent;
  }

  /**
   * Estimate total pages from HTML
   */
  estimateTotalPages(html: string): number | null {
    const $ = cheerio.load(html);

    // Look for total count
    const totalText = $('.total-count, .results-total').text();
    const match = totalText.match(/(\d+)/);

    if (match) {
      const total = parseInt(match[1], 10);
      return Math.ceil(total / this.pageSize);
    }

    return null;
  }

  /**
   * Validate selectors against a live page before full crawl
   * Tests all strategies and reports which ones are working
   */
  async checkSelectorHealth(database: DatabaseType): Promise<SelectorHealthResult> {
    const result: SelectorHealthResult = {
      database,
      healthy: false,
      timestamp: new Date().toISOString(),
      strategies: {
        css_primary: { working: false, itemCount: 0 },
        xpath_patterns: { working: false, itemCount: 0 },
        css_structural: { working: false, itemCount: 0 },
        regex_fallback: { working: false, itemCount: 0 },
        cached_data: { working: false, itemCount: 0 }
      },
      recommendedStrategy: null,
      warnings: []
    };

    try {
      // Fetch first page to test selectors
      console.error(`[Scraper] Health check: fetching first page of ${database}...`);
      const html = await this.fetchPage(database, 0);

      if (!html || html.length < 1000) {
        result.error = 'Received empty or minimal HTML response';
        result.warnings.push('ScraperAPI may be blocked or page structure changed');
        return result;
      }

      // Test CSS Primary strategy
      const primaryDecisions = this.parseWithCssPrimary(html, database);
      result.strategies.css_primary = {
        working: primaryDecisions.length > 0,
        itemCount: primaryDecisions.length
      };

      // Test XPath Patterns strategy
      const xpathDecisions = this.parseWithXPathPatterns(html, database);
      result.strategies.xpath_patterns = {
        working: xpathDecisions.length > 0,
        itemCount: xpathDecisions.length
      };

      // Test CSS Structural strategy
      const structuralDecisions = this.parseWithCssStructural(html, database);
      result.strategies.css_structural = {
        working: structuralDecisions.length > 0,
        itemCount: structuralDecisions.length
      };

      // Test Regex fallback strategy
      const regexDecisions = this.parseWithRegex(html, database);
      result.strategies.regex_fallback = {
        working: regexDecisions.length > 0,
        itemCount: regexDecisions.length
      };

      // Test Cached data fallback strategy (if provider is configured)
      if (this.cachedDataProvider) {
        const cachedDecisions = this.cachedDataProvider(database, 0, this.pageSize);
        result.strategies.cached_data = {
          working: cachedDecisions.length > 0,
          itemCount: cachedDecisions.length
        };
      }

      // Determine overall health and recommended strategy (in priority order)
      if (result.strategies.css_primary.working) {
        result.healthy = true;
        result.recommendedStrategy = 'css_primary';
      } else if (result.strategies.xpath_patterns.working) {
        result.healthy = true;
        result.recommendedStrategy = 'xpath_patterns';
        result.warnings.push('Primary CSS selectors failed - using XPath patterns');
      } else if (result.strategies.css_structural.working) {
        result.healthy = true;
        result.recommendedStrategy = 'css_structural';
        result.warnings.push('Primary and XPath selectors failed - using structural selectors');
      } else if (result.strategies.regex_fallback.working) {
        result.healthy = true;
        result.recommendedStrategy = 'regex_fallback';
        result.warnings.push('All CSS and XPath selectors failed - using regex fallback (less reliable)');
      } else if (result.strategies.cached_data.working) {
        // Cached data available but not considered "healthy" since live data is unavailable
        result.healthy = false;
        result.recommendedStrategy = 'cached_data';
        result.warnings.push('All extraction strategies failed - using cached database data (STALE DATA WARNING)');
        result.warnings.push(`Cached data available: ${result.strategies.cached_data.itemCount} decisions from database`);
      } else {
        result.healthy = false;
        result.warnings.push('All extraction strategies failed - selectors need updating');
        result.warnings.push('No cached data available in database');
      }

      // Add warnings for strategy degradation
      if (result.strategies.css_primary.working && result.strategies.css_primary.itemCount < 5) {
        result.warnings.push(`Primary selector found only ${result.strategies.css_primary.itemCount} items (expected ~10)`);
      }

      console.error(`[Scraper] Health check complete for ${database}: ${result.healthy ? 'HEALTHY' : 'UNHEALTHY'}`);

    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      result.warnings.push('Failed to fetch page for health check');
      console.error(`[Scraper] Health check failed for ${database}: ${result.error}`);
    }

    return result;
  }

  /**
   * Check health of all databases
   */
  async checkAllSelectorHealth(): Promise<SelectorHealthResult[]> {
    const databases: DatabaseType[] = ['decisive_appraiser', 'appeals_committee', 'appeals_board'];
    const results: SelectorHealthResult[] = [];

    for (const database of databases) {
      const healthResult = await this.checkSelectorHealth(database);
      results.push(healthResult);
      await this.delay(); // Rate limit between checks
    }

    return results;
  }

  /**
   * Delay helper for rate limiting
   */
  async delay(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, this.delayMs));
  }

  /**
   * Get page size
   */
  getPageSize(): number {
    return this.pageSize;
  }
}

// Factory function
export function createScraper(apiKey: string, options?: Partial<ScraperOptions>): GovIlScraper {
  return new GovIlScraper({ apiKey, ...options });
}
