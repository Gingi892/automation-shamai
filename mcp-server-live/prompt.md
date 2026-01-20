# PDF Accessibility Fix Agent

You are fixing the gov-il-live MCP server's PDF download functionality.

## Problem Statement
PDFs from gov.il search results are not accessible through the API. The `read_decision_pdf` tool fails to download PDF content.

## Context
- Server location: C:/Users/user/automation-shamai/mcp-server-live
- Source code: src/index.ts
- The search works but PDF URLs may require:
  - Session cookies from the search
  - Specific referrer headers
  - Different URL format
  - Puppeteer-based download instead of fetch

## Your Workflow

1. Read `prd.json` to find highest-priority story with `passes: false`
2. Read `progress.txt` for learnings from previous iterations
3. **Do the investigation/fix work:**
   - Use Bash to test URLs with curl
   - Read/Edit source code
   - Run npm build to test changes
4. Update `progress.txt` with findings
5. Mark story as `passes: true` in prd.json

## Key Investigation Commands

```bash
# Test if PDF URL is accessible directly
curl -I "PDF_URL_HERE" -H "User-Agent: Mozilla/5.0"

# Test with referrer
curl -I "PDF_URL_HERE" -H "Referer: https://www.gov.il/"

# Test actual download
curl -o test.pdf "PDF_URL_HERE" -H "User-Agent: Mozilla/5.0" -L
```

## Code Locations

- `extractPDFContent` function: src/index.ts ~line 612
- PDF link extraction: src/index.ts ~line 560
- Tool definition: src/index.ts ~line 122

## Files to Create/Update

- `PDF-ANALYSIS.md` - Root cause analysis and findings
- `src/index.ts` - Fix the PDF download code
- `progress.txt` - Learnings after each story

## Possible Solutions to Investigate

1. **Use Puppeteer for PDF download** - Same session as search
2. **Extract cookies and pass to fetch** - Session continuity
3. **Different URL construction** - gov.il may use redirect URLs
4. **Accept failure gracefully** - Return metadata + browser link

## Completion

When all stories have `passes: true`, output:
<promise>PDF FIX COMPLETE</promise>
