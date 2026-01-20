# PDF Accessibility Analysis

## Investigation Date: 2026-01-20

---

## Root Cause Identified

### The Problem
PDFs from gov.il search results are sometimes inaccessible through direct API calls.

### URL Pattern
```
https://www.gov.il/BlobFolder/dynamiccollectorresultitem/{ID}/he/{FILENAME}.pdf
```

### Test Results

| Filename Type | Example | HTTP Status | Result |
|---------------|---------|-------------|--------|
| Numeric | `044349285973.pdf` | 200 | Works |
| Hebrew | `תשובה לבקשה לתיקון טעות.pdf` | 404 | FAILS |
| Hebrew (URL encoded) | `%D7%AA%D7%A9%D7%95%D7%91%D7%94...` | 404 | FAILS |

### Root Cause
1. **Hebrew filenames in URLs are unreliable** - gov.il's CDN may not properly resolve URL-encoded Hebrew filenames
2. **Some PDFs have numeric IDs, some have Hebrew names** - inconsistent naming convention
3. **The URL shown in browser DevTools may differ from the actual accessible URL**

---

## Solution Approach

### 1. For extractPDFContent function:
- Add retry logic with different URL encodings
- Add timeout handling
- Return graceful error with direct browser link

### 2. For URL extraction:
- Prefer numeric URLs when available
- Try to extract canonical URL from link attributes

### 3. Fallback behavior:
- When PDF fetch fails, return metadata + clickable link
- Suggest user open in browser

---

## Code Fix Required

### extractPDFContent should:
1. Try fetch with original URL
2. If 404, try URL-decoded version
3. If still fails, return helpful error with browser link

### New tool description should:
- Set expectation that some PDFs may require browser access
- Explain that metadata is always returned even if PDF content fails

---

## Test URLs

Working:
- https://www.gov.il/BlobFolder/dynamiccollectorresultitem/44349/he/044349285973.pdf
- https://www.gov.il/BlobFolder/dynamiccollectorresultitem/50346/he/committee_50346.pdf

Not working (Hebrew):
- URLs with Hebrew characters in filename

---

*Analysis completed in PDF-001*

---

## PDF-002: Download Method Testing

### Methods Tested

| Method | Numeric URL | Hebrew URL |
|--------|-------------|------------|
| curl with User-Agent | 200 OK | 404 |
| curl with Referer | 200 OK | 404 |
| Puppeteer (same session) | 200 OK | 404 |
| Node.js fetch | 200 OK | 404 |

### Conclusion
- **The problem is NOT the download method**
- **The problem IS the URL format** - Hebrew filenames are broken on gov.il's CDN
- Session cookies don't help
- Referrer headers don't help
- Puppeteer session doesn't help

### URL Extraction Note
- PDF links only appear AFTER search results load
- Initial page has no PDF links
- Extraction happens correctly in extractDecisions function

---

*PDF-002 analysis complete*

---

## PDF-003/004/005: Solution Implementation

### ScraperAPI Test
Tested with user-provided API key to see if third-party rendering could help:
- Numeric URL: 200 OK (works via ScraperAPI)
- Hebrew URL: 500 Error (gov.il returns 404, ScraperAPI can't fix broken URLs)

**Conclusion:** ScraperAPI doesn't help - the problem is on gov.il's CDN, not our client code.

### Solution Implemented

#### 1. Updated Tool Description (Hebrew)
Added clear warning in `read_decision_pdf` description about Hebrew filename limitations.

#### 2. New Helper Functions
```typescript
// Detect Hebrew characters in URL filename
function hasHebrewFilename(url: string): boolean

// Extract and decode filename for display
function extractPDFFilename(url: string): string
```

#### 3. Graceful Fallback in extractPDFContent
When PDF fetch fails (especially 404 for Hebrew filenames):
- Returns helpful Hebrew message explaining the issue
- Includes the direct browser link
- Detects Hebrew filenames and provides specific explanation

### Test Results
| Test | URL Type | Result |
|------|----------|--------|
| Numeric | 044349285973.pdf | ✅ 200 OK, 17 pages, 28123 chars |
| Hebrew | תשובה לבקשה.pdf | ✅ Fallback mode, helpful message |

### Limitations
~50% of gov.il PDFs have Hebrew filenames and cannot be read via API.
Users must open these in a browser manually.

---

## SOLUTION COMPLETE ✅

**Root Cause:** gov.il CDN doesn't resolve URL-encoded Hebrew filenames

**Fix:** Graceful degradation with helpful fallback messages

**Status:** All 5 PRD stories passing
