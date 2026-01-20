# Actionable Fixes for gov-il-live MCP Server

**Generated:** 2026-01-20
**Total Issues Found:** 19
**Status:** Server is effectively non-functional due to outdated selectors

---

## Executive Summary

The MCP server fails because:
1. **All CSS selectors are outdated** - gov.il changed their page structure
2. **Tool description is insufficient** - Claude can't parse Hebrew NL properly
3. **Documentation is misleading** - README promises features that don't exist

**Recommended approach:** Fix selectors first (P0), then improve tool description (P1), then fix docs (P2).

---

## Priority 0 (CRITICAL) - Server Non-Functional

### Fix #1: Update All CSS Selectors
**Issues addressed:** #6, #14-19
**Complexity:** HIGH
**Estimated effort:** 4-8 hours

**Action Required:**
1. Open https://www.gov.il/he/departments/dynamiccollectors/decisive_appraisal_decisions in browser
2. Use DevTools to inspect current page structure
3. Identify new selectors for:
   - Filter container
   - Free text input
   - City/Committee dropdown
   - Block/Plot inputs
   - Search button
   - Result cards
   - PDF links

**Code locations to update:**
- Lines 173-178: waitForSelector selectors
- Lines 207-213: freeTextSelectors array
- Lines 233-241: city filter selectors
- Lines 246-250: block number selectors
- Lines 255-259: plot number selectors
- Lines 264-268: case type selectors
- Lines 276-279, 284-287: date filter selectors
- Lines 292-298: search button selectors
- Lines 348-355: result container selectors
- Lines 372, 392: PDF link selectors

**Verification:**
```javascript
// Add health check function
async function verifySelectors(page) {
    const checks = [
        { name: 'filter-container', selector: 'NEW_SELECTOR_HERE' },
        { name: 'search-input', selector: 'NEW_SELECTOR_HERE' },
        // ... etc
    ];
    const results = await Promise.all(
        checks.map(async c => ({ ...c, found: !!(await page.$(c.selector)) }))
    );
    const failed = results.filter(r => !r.found);
    if (failed.length > 0) {
        console.error('Selector check failed:', failed.map(f => f.name));
    }
    return failed.length === 0;
}
```

---

### Fix #2: Rename Tool to Match README (or vice versa)
**Issues addressed:** #1
**Complexity:** LOW
**Estimated effort:** 15 minutes

**Option A: Update code to match README**
```javascript
// dist/index.js line 56
// Change:
name: 'search_decisions',
// To:
name: 'search_land_decisions',
```

**Option B: Update README to match code**
```markdown
<!-- README.md line 23 -->
<!-- Change: -->
### 1. `search_land_decisions`
<!-- To: -->
### 1. `search_decisions`
```

**Recommendation:** Option B - update README, since Claude Desktop users won't see README anyway.

---

### Fix #3: Remove Non-Existent Tool from README
**Issues addressed:** #2
**Complexity:** LOW
**Estimated effort:** 5 minutes

**Action:**
Delete lines 38-44 from README.md:
```markdown
<!-- DELETE THIS SECTION -->
### 3. `search_and_read` (Most Powerful)
Combined search + PDF reading - answers questions about decision content:
\`\`\`
"מה נקבע בהחלטות על היטל השבחה בתל אביב?"
...
\`\`\`
```

**Or implement the tool** (more complex, see Fix #10).

---

## Priority 1 (HIGH) - Improve Functionality

### Fix #4: Replace Tool Description
**Issues addressed:** #3, #9, #10, #11, #12, #13
**Complexity:** MEDIUM
**Estimated effort:** 30 minutes

**Action:**
Replace the tool description at lines 57-78 with the improved version from `IMPROVED-TOOL.md`.

Key improvements:
- 6 examples instead of 1
- Database selection table with Hebrew keywords
- Explicit default: "use decisive_appraiser if unclear"
- Hebrew parameter descriptions
- Negative guidance section

---

### Fix #5: Increase Wait Timeouts
**Issues addressed:** #7, #14
**Complexity:** LOW
**Estimated effort:** 15 minutes

**Changes:**

```javascript
// Line 173-178: Increase Angular wait
await Promise.race([
    page.waitForSelector('...', { timeout: 15000 }),  // Was 8000
    new Promise(resolve => setTimeout(resolve, 5000))  // Was 2000
]).catch(...);

// Lines 182-185: Increase results wait
await Promise.race([
    page.waitForSelector('...', { timeout: 10000 }),  // Was 5000
    new Promise(resolve => setTimeout(resolve, 3000))  // Was 1500
]).catch(...);
```

---

### Fix #6: Add Filter Success Verification
**Issues addressed:** #15, #16
**Complexity:** MEDIUM
**Estimated effort:** 1 hour

**Add tracking to fillSearchFilters:**

```javascript
async function fillSearchFilters(page, params) {
    let filtersApplied = 0;
    let filtersAttempted = 0;

    if (params.freeText) {
        filtersAttempted++;
        const success = await tryFillFreeText(page, params.freeText);
        if (success) filtersApplied++;
    }

    // ... repeat for each filter ...

    // At end of function:
    console.error(`Filters: ${filtersApplied}/${filtersAttempted} applied successfully`);

    if (filtersAttempted > 0 && filtersApplied === 0) {
        console.error('WARNING: No filters could be applied - selectors may be outdated');
    }

    return { filtersApplied, filtersAttempted };
}
```

---

### Fix #7: Improve Error Reporting to User
**Issues addressed:** #15
**Complexity:** MEDIUM
**Estimated effort:** 1 hour

**Update formatDecisions to include warnings:**

```javascript
function formatDecisions(decisions, params, filterStats) {
    const lines = [];

    // Add warning if filters failed
    if (filterStats && filterStats.filtersAttempted > 0 && filterStats.filtersApplied === 0) {
        lines.push('⚠️ **אזהרה:** לא הצלחנו להחיל את הפילטרים. ייתכן שהדף השתנה.');
        lines.push('');
    }

    // ... rest of function ...
}
```

---

## Priority 2 (MEDIUM) - Documentation & Polish

### Fix #8: Update README Feature Claims
**Issues addressed:** #3
**Complexity:** LOW
**Estimated effort:** 15 minutes

**Change line 8:**
```markdown
<!-- From: -->
- **Natural language queries** - Understands Hebrew and English

<!-- To: -->
- **Structured search** - Claude extracts parameters from your Hebrew query
```

---

### Fix #9: Document Parameters in README
**Issues addressed:** #4, #5
**Complexity:** LOW
**Estimated effort:** 30 minutes

**Add after line 29:**
```markdown
### Parameters for `search_decisions`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| database | string | Yes | `decisive_appraiser`, `appeals_committee`, or `appeals_board` |
| freeText | string | No | Free text search |
| city | string | No | City name in Hebrew |
| blockNumber | string | No | Block number (גוש) |
| plotNumber | string | No | Plot number (חלקה) |
| caseType | string | No | Case type (היטל השבחה, פיצויים, etc.) |
| appraiserName | string | No | Appraiser name |
| yearFrom | number | No | Start year |
| yearTo | number | No | End year |
| maxResults | number | No | Max results (default: 30) |
```

---

### Fix #10: Implement search_and_read Tool (Optional)
**Issues addressed:** #2 (alternative to Fix #3)
**Complexity:** HIGH
**Estimated effort:** 2-4 hours

**If you want to keep the promised feature, implement it:**

```javascript
{
    name: 'search_and_read',
    description: 'Combined search and PDF reading...',
    inputSchema: { /* same as search_decisions */ }
}

// In handler:
case 'search_and_read': {
    // 1. Search
    const decisions = await searchWithPuppeteer(params);

    // 2. Read top 3 PDFs
    const contents = [];
    for (const d of decisions.slice(0, 3)) {
        if (d.url) {
            try {
                const pdf = await extractPDFContent(d.url);
                contents.push({ title: d.title, text: pdf.text });
            } catch (e) {
                console.error(`Failed to read ${d.url}:`, e);
            }
        }
    }

    // 3. Return combined
    return { content: [{ type: 'text', text: formatCombined(decisions, contents) }] };
}
```

---

## Priority 3 (LOW) - Code Quality

### Fix #11: Use page.select() for Dropdowns
**Issues addressed:** #17
**Complexity:** LOW
**Estimated effort:** 30 minutes

```javascript
// Instead of:
await element.click();
await page.keyboard.type(value, { delay: 10 });
await page.keyboard.press('Enter');

// Use:
await page.select(selector, value);
// Or find option and click:
const options = await page.$$(`${selector} option`);
for (const opt of options) {
    const text = await opt.evaluate(el => el.textContent);
    if (text.includes(value)) {
        await opt.click();
        break;
    }
}
```

---

### Fix #12: Tighten Title Extraction
**Issues addressed:** #18
**Complexity:** LOW
**Estimated effort:** 15 minutes

```javascript
// Line 364-365, be more specific:
const titleEl = el.querySelector('.decision-title, .card-title, h3.title');
// Instead of:
const titleEl = el.querySelector('h3, h4, .title, [class*="title"], a');
```

---

### Fix #13: Add Data Validation
**Issues addressed:** #19
**Complexity:** LOW
**Estimated effort:** 30 minutes

```javascript
// After extracting decision data:
function validateDecision(d) {
    if (!d.title || d.title.length < 10) return false;
    if (d.url && !d.url.includes('gov.il')) return false;
    if (d.date && !/\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}/.test(d.date)) {
        d.date = null; // Clear invalid date
    }
    return true;
}

// In extractDecisions:
const validDecisions = decisions.filter(validateDecision);
```

---

## Implementation Order

| Order | Fix # | Description | Dependency |
|-------|-------|-------------|------------|
| 1 | #1 | Update selectors | None |
| 2 | #5 | Increase timeouts | After #1 |
| 3 | #6 | Add filter verification | After #1 |
| 4 | #4 | Replace tool description | None |
| 5 | #2 | Rename tool OR fix README | None |
| 6 | #3 | Remove fake tool from README | None |
| 7 | #7 | Improve error reporting | After #6 |
| 8 | #8-9 | Update README | After #2, #3 |
| 9 | #11-13 | Code quality | After #1-7 |
| 10 | #10 | Implement search_and_read | Optional |

---

## Quick Wins (Do First)

These can be done in <1 hour total:
1. Fix #2 or #3 - README tool name mismatch (5-15 min)
2. Fix #5 - Increase timeouts (15 min)
3. Fix #8 - Update feature claims (15 min)

**Then spend time on Fix #1 (selectors) which is the root cause.**

---

*FIXES.md created by Ralph Loop iteration 5*
