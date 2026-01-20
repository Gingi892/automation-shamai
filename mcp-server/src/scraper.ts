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
 */
export type SelectorStrategyType = 'css_primary' | 'css_structural' | 'regex_fallback';

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
    css_structural: { working: boolean; itemCount: number };
    regex_fallback: { working: boolean; itemCount: number };
  };
  recommendedStrategy: SelectorStrategyType | null;
  warnings: string[];
  error?: string;
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
      'a[href*=".pdf"]',
      'a[href*="document"]',
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
      /הכרעת שמאי[^<\n]{10,200}/g,
      /החלטת ועד[^<\n]{10,200}/g,
      /ערעור[^<\n]{10,200}/g,
      /<h3[^>]*>([^<]{10,300})<\/h3>/gi,
      /<h4[^>]*>([^<]{10,300})<\/h4>/gi,
      /title["\s]*:["\s]*["']([^"']{10,300})["']/gi
    ],
    pdfUrl: [
      /https?:\/\/free-justice\.openapi\.gov\.il[^\s"'<>]+\.pdf/gi,
      /https?:\/\/[^"'\s<>]*\.gov\.il[^"'\s<>]*\.pdf/gi,
      /href=["']([^"']*\.pdf[^"']*)["']/gi
    ],
    date: [
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

  constructor(options: ScraperOptions) {
    this.apiKey = options.apiKey;
    this.delayMs = options.delayMs || 1000;
    this.premium = options.premium ?? true;
    this.render = options.render ?? true;
    this.selectors = DEFAULT_SELECTORS;

    // Initialize strategy stats
    this.strategyStats.set('css_primary', { success: 0, fail: 0 });
    this.strategyStats.set('css_structural', { success: 0, fail: 0 });
    this.strategyStats.set('regex_fallback', { success: 0, fail: 0 });
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
   */
  private buildScraperUrl(targetUrl: string): string {
    const params = new URLSearchParams({
      api_key: this.apiKey,
      url: targetUrl,
      render: this.render.toString(),
      premium: this.premium.toString()
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
   * Strategy order: 1) CSS Primary, 2) CSS Structural, 3) Regex fallback
   */
  parseDecisions(html: string, database: DatabaseType): ParsedDecision[] {
    // Strategy 1: CSS Primary selectors (class-based)
    let decisions = this.parseWithCssPrimary(html, database);
    if (decisions.length > 0) {
      this.lastStrategyUsed = 'css_primary';
      this.logStrategy('css_primary', true, decisions.length);
      return decisions;
    }
    this.logStrategy('css_primary', false, 0);

    // Strategy 2: CSS Structural selectors (tag/attribute-based, more resilient)
    decisions = this.parseWithCssStructural(html, database);
    if (decisions.length > 0) {
      this.lastStrategyUsed = 'css_structural';
      this.logStrategy('css_structural', true, decisions.length);
      console.error(`[Scraper] WARNING: Primary CSS selectors failed, structural selectors succeeded`);
      return decisions;
    }
    this.logStrategy('css_structural', false, 0);

    // Strategy 3: Regex fallback on raw HTML
    decisions = this.parseWithRegex(html, database);
    if (decisions.length > 0) {
      this.lastStrategyUsed = 'regex_fallback';
      this.logStrategy('regex_fallback', true, decisions.length);
      console.error(`[Scraper] WARNING: All CSS selectors failed, using regex fallback`);
      return decisions;
    }
    this.logStrategy('regex_fallback', false, 0);

    // All strategies failed
    console.error(`[Scraper] ERROR: All extraction strategies failed for ${database}`);
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
            publishDate: null,
            ...metadata
          });
        }
      });
    }

    return decisions;
  }

  /**
   * Strategy 2: Parse using structural CSS selectors (tag/attribute-based)
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
   * Strategy 3: Parse using regex patterns on raw HTML
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
          const url = urlMatch ? urlMatch[1] : match;
          if (url.includes('.pdf') || url.includes('gov.il')) {
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
        publishDate,
        ...metadata
      });
    }

    return decisions;
  }

  /**
   * Extract a decision from a DOM element using provided selectors
   */
  private extractDecisionFromElement(
    $: cheerio.CheerioAPI,
    $el: cheerio.Cheerio<cheerio.Element>,
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
      publishDate,
      ...metadata
    };
  }

  /**
   * Parse metadata from Hebrew decision title
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

    // Pattern for decisive appraiser decisions:
    // הכרעת שמאי מכריע מיום DD-MM-YYYY בעניין [caseType] נ [committee] ג [block] ח [plot] - [appraiser]
    const decisivePattern = /הכרעת שמאי (מכריע|מייעץ) מיום (\d{2}-\d{2}-\d{4}) בעניין ([^נ]+)נ ([^ג]+)ג (\d+) ח (\d+)\s*-?\s*(.+)?/;
    const match = title.match(decisivePattern);

    if (match) {
      metadata.decisionDate = match[2];
      metadata.caseType = match[3].trim();
      metadata.committee = match[4].trim().replace(/ועדה מקומית\s*/i, '');
      metadata.block = match[5];
      metadata.plot = match[6];
      if (match[7]) {
        metadata.appraiser = match[7].trim();
      }
    } else {
      // Try simpler patterns

      // Block and plot: ג XXXX ח YYYY or גוש XXXX חלקה YYYY
      const blockPlotMatch = title.match(/[גג](?:וש)?\s*(\d+)\s*[חח](?:לקה)?\s*(\d+)/);
      if (blockPlotMatch) {
        metadata.block = blockPlotMatch[1];
        metadata.plot = blockPlotMatch[2];
      }

      // Committee: ועדה מקומית XXX
      const committeeMatch = title.match(/ועדה מקומית\s+([^\s,]+)/);
      if (committeeMatch) {
        metadata.committee = committeeMatch[1].trim();
      }

      // Date patterns
      const dateMatch = title.match(/(\d{2}[-./]\d{2}[-./]\d{4})/);
      if (dateMatch) {
        metadata.decisionDate = dateMatch[1].replace(/\./g, '-');
      }

      // Case type: היטל השבחה, פיצויים, etc.
      if (title.includes('היטל השבחה')) {
        metadata.caseType = 'היטל השבחה';
      } else if (title.includes('פיצויים')) {
        metadata.caseType = 'פיצויים';
      } else if (title.includes('ירידת ערך')) {
        metadata.caseType = 'ירידת ערך';
      }
    }

    return metadata;
  }

  /**
   * Convert parsed decision to database Decision object
   */
  toDecision(parsed: ParsedDecision, database: DatabaseType): Omit<Decision, 'indexedAt'> {
    const contentForHash = `${parsed.title}|${parsed.url || ''}|${database}`;
    const contentHash = crypto.createHash('md5').update(contentForHash).digest('hex');
    const id = `${database}-${contentHash.substring(0, 12)}`;

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
      publishDate: parsed.publishDate,
      contentHash
    };
  }

  /**
   * Fetch and parse a single page
   */
  async fetchAndParse(database: DatabaseType, page: number): Promise<Omit<Decision, 'indexedAt'>[]> {
    const html = await this.fetchPage(database, page);
    const parsed = this.parseDecisions(html, database);
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
        css_structural: { working: false, itemCount: 0 },
        regex_fallback: { working: false, itemCount: 0 }
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

      // Determine overall health and recommended strategy
      if (result.strategies.css_primary.working) {
        result.healthy = true;
        result.recommendedStrategy = 'css_primary';
      } else if (result.strategies.css_structural.working) {
        result.healthy = true;
        result.recommendedStrategy = 'css_structural';
        result.warnings.push('Primary CSS selectors failed - using structural selectors');
      } else if (result.strategies.regex_fallback.working) {
        result.healthy = true;
        result.recommendedStrategy = 'regex_fallback';
        result.warnings.push('All CSS selectors failed - using regex fallback (less reliable)');
      } else {
        result.healthy = false;
        result.warnings.push('All extraction strategies failed - selectors need updating');
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
