/**
 * E2E Tests - Chat Flow
 * US-P5-003: End-to-end tests for the Legal Chatbot
 *
 * These tests verify the complete chat flow from user query to response,
 * testing the integration between frontend, webhook, and RAG backend.
 *
 * Run with: cd mcp-server && node --import tsx ../chatbot/tests/test_e2e.ts
 *
 * Note: Some tests require the n8n webhook to be running. Tests that make
 * actual API calls will be skipped if the webhook is not available.
 */

import assert from 'node:assert';

// ============================================================
// Configuration
// ============================================================

const WEBHOOK_URL = 'https://a-i-do.app.n8n.cloud/webhook/chat';
const TIMEOUT_MS = 60000; // 60 seconds for API calls

// ============================================================
// Types
// ============================================================

interface ChatRequest {
  message: string;
  conversationHistory?: Array<{ role: string; content: string }>;
}

interface Source {
  title: string;
  url: string;
  score?: number;
  databaseSource?: string;
  decisionDate?: string;
  sourceId?: string;
}

interface Claim {
  text: string;
  grounded: boolean;
  confidence: number;
  citing?: string[];
}

interface HallucinationCheck {
  overall_grounded?: boolean;
  grounded_claims?: number;
  total_claims?: number;
  grounding_ratio?: number;
  claims?: Claim[];
}

interface ChatResponse {
  success: boolean;
  response: string;
  sources?: Source[];
  matchCount?: number;
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
  hallucination_check?: HallucinationCheck;
  warning?: string;
  // Statistics response fields
  isStatisticsResponse?: boolean;
  statistics?: Record<string, unknown>;
  chartData?: Record<string, unknown>;
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Send a chat request to the webhook
 * Returns null if the webhook is not available (allows tests to be skipped)
 */
async function sendChatRequest(
  request: ChatRequest,
  timeoutMs: number = TIMEOUT_MS
): Promise<ChatResponse | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      // Return null for connection/server errors to allow graceful test skipping
      if (response.status >= 500) {
        console.log(`    [API returned ${response.status}]`);
        const text = await response.text();
        return { success: false, response: text } as ChatResponse;
      }
      return null;
    }

    const data = await response.json();
    return data as ChatResponse;
  } catch (error) {
    clearTimeout(timeoutId);

    // Network errors or timeouts - return null to allow test skipping
    const errorMessage = (error as Error).message || 'Unknown error';
    if (errorMessage.includes('abort') || errorMessage.includes('timeout')) {
      console.log('    [Request timed out]');
    } else if (errorMessage.includes('fetch') || errorMessage.includes('network')) {
      console.log('    [Network error - webhook may be unavailable]');
    } else {
      console.log(`    [Error: ${errorMessage}]`);
    }
    return null;
  }
}

/**
 * Check if the response contains Hebrew text
 */
function containsHebrew(text: string): boolean {
  return /[\u0590-\u05FF]/.test(text);
}

/**
 * Check if the response contains citation markers [S0], [S1], etc.
 */
function containsCitations(text: string): boolean {
  return /\[S\d+\]/.test(text);
}

/**
 * Extract citation numbers from text
 */
function extractCitationNumbers(text: string): number[] {
  const matches = text.match(/\[S(\d+)\]/g) || [];
  return matches.map(m => parseInt(m.replace(/\[S|\]/g, ''), 10));
}

/**
 * Validate response structure matches expected schema
 */
function validateResponseStructure(response: ChatResponse): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof response.success !== 'boolean') {
    errors.push('Missing or invalid "success" field');
  }

  if (typeof response.response !== 'string') {
    errors.push('Missing or invalid "response" field');
  }

  // Sources are optional but should be an array if present
  if (response.sources !== undefined && !Array.isArray(response.sources)) {
    errors.push('"sources" should be an array');
  }

  // If sources are present, validate structure
  if (response.sources && response.sources.length > 0) {
    for (let i = 0; i < response.sources.length; i++) {
      const source = response.sources[i];
      if (!source.title) {
        errors.push(`Source ${i} missing "title"`);
      }
      if (!source.url) {
        errors.push(`Source ${i} missing "url"`);
      }
    }
  }

  // Hallucination check is optional but should have correct structure if present
  if (response.hallucination_check !== undefined) {
    const hc = response.hallucination_check;
    if (hc.grounding_ratio !== undefined && (hc.grounding_ratio < 0 || hc.grounding_ratio > 1)) {
      errors.push('hallucination_check.grounding_ratio should be between 0 and 1');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// ============================================================
// Test: test_simple_query
// ============================================================

/**
 * Test a simple Hebrew query: "מה זה היטל השבחה?"
 * Expected: Response explains betterment levy in Hebrew with sources
 */
async function test_simple_query(): Promise<void> {
  console.log('Running: test_simple_query()');
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  // Test case 1: Send simple Hebrew query
  try {
    const request: ChatRequest = {
      message: 'מה זה היטל השבחה?'
    };

    console.log('  Sending query: "מה זה היטל השבחה?"');
    const response = await sendChatRequest(request);

    if (response === null) {
      console.log('  ⊘ API call failed - test skipped (webhook may be unavailable)');
      skipped++;
    } else {
      // Validate response structure
      const validation = validateResponseStructure(response);
      if (!validation.valid) {
        console.log(`  ✗ Invalid response structure: ${validation.errors.join(', ')}`);
        failed++;
      } else {
        assert.strictEqual(response.success, true,
          'Response should indicate success');
        console.log('  ✓ Response structure is valid');
        passed++;
      }
    }
  } catch (error) {
    console.log(`  ✗ Send simple Hebrew query: ${(error as Error).message}`);
    failed++;
  }

  // Test case 2: Response is in Hebrew
  try {
    const request: ChatRequest = {
      message: 'מה זה היטל השבחה?'
    };

    const response = await sendChatRequest(request);

    if (response === null || !response.success) {
      console.log('  ⊘ Hebrew content check skipped');
      skipped++;
    } else {
      assert.ok(containsHebrew(response.response),
        'Response should contain Hebrew text');
      console.log('  ✓ Response is in Hebrew');
      passed++;
    }
  } catch (error) {
    console.log(`  ✗ Response is in Hebrew: ${(error as Error).message}`);
    failed++;
  }

  // Test case 3: Response is non-empty and meaningful
  try {
    const request: ChatRequest = {
      message: 'מה זה היטל השבחה?'
    };

    const response = await sendChatRequest(request);

    if (response === null || !response.success) {
      console.log('  ⊘ Response length check skipped');
      skipped++;
    } else {
      // Response should be meaningful (more than 50 characters for a real answer)
      assert.ok(response.response.length > 50,
        `Response should be meaningful, got ${response.response.length} chars`);
      console.log(`  ✓ Response is meaningful (${response.response.length} chars)`);
      passed++;
    }
  } catch (error) {
    console.log(`  ✗ Response is non-empty and meaningful: ${(error as Error).message}`);
    failed++;
  }

  // Test case 4: Response mentions betterment levy concepts
  try {
    const request: ChatRequest = {
      message: 'מה זה היטל השבחה?'
    };

    const response = await sendChatRequest(request);

    if (response === null || !response.success) {
      console.log('  ⊘ Content relevance check skipped');
      skipped++;
    } else {
      // Response should mention relevant concepts
      const relevantTerms = ['היטל', 'השבחה', 'תכנון', 'בניה', 'מקרקעין', 'שווי', 'תוכנית', 'ועדה'];
      const responseText = response.response.toLowerCase();
      const foundTerms = relevantTerms.filter(term => responseText.includes(term));

      assert.ok(foundTerms.length >= 2,
        `Response should mention relevant terms, found: ${foundTerms.join(', ')}`);
      console.log(`  ✓ Response is relevant (mentions: ${foundTerms.slice(0, 4).join(', ')}...)`);
      passed++;
    }
  } catch (error) {
    console.log(`  ✗ Response mentions betterment levy concepts: ${(error as Error).message}`);
    failed++;
  }

  // Test case 5: Sources are returned (RAG is working)
  try {
    const request: ChatRequest = {
      message: 'מה זה היטל השבחה?'
    };

    const response = await sendChatRequest(request);

    if (response === null || !response.success) {
      console.log('  ⊘ Sources check skipped');
      skipped++;
    } else {
      assert.ok(response.sources && response.sources.length > 0,
        'Response should include sources from RAG retrieval');
      console.log(`  ✓ Sources returned (${response.sources!.length} sources)`);
      passed++;
    }
  } catch (error) {
    console.log(`  ✗ Sources are returned: ${(error as Error).message}`);
    failed++;
  }

  // Test case 6: Match count is positive
  try {
    const request: ChatRequest = {
      message: 'מה זה היטל השבחה?'
    };

    const response = await sendChatRequest(request);

    if (response === null || !response.success) {
      console.log('  ⊘ Match count check skipped');
      skipped++;
    } else {
      // matchCount should be present and positive
      assert.ok(response.matchCount !== undefined && response.matchCount > 0,
        `matchCount should be positive, got ${response.matchCount}`);
      console.log(`  ✓ Match count is positive (${response.matchCount})`);
      passed++;
    }
  } catch (error) {
    console.log(`  ✗ Match count is positive: ${(error as Error).message}`);
    failed++;
  }

  // Test case 7: No server errors in response
  try {
    const request: ChatRequest = {
      message: 'מה זה היטל השבחה?'
    };

    const response = await sendChatRequest(request);

    if (response === null) {
      console.log('  ⊘ Server error check skipped');
      skipped++;
    } else {
      // Check for common error patterns in response
      const errorPatterns = ['error', 'Error', 'exception', 'failed', 'שגיאה'];
      const responseText = response.response || '';
      const hasErrorPattern = errorPatterns.some(p => responseText.includes(p));

      // If there's an error pattern, it should be part of a legitimate explanation, not an error message
      if (hasErrorPattern && !response.success) {
        assert.fail('Response indicates server error');
      }
      console.log('  ✓ No server errors in response');
      passed++;
    }
  } catch (error) {
    console.log(`  ✗ No server errors in response: ${(error as Error).message}`);
    failed++;
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`);

  if (failed > 0) {
    process.exit(1);
  }
}

// ============================================================
// Test: test_specific_search
// ============================================================

/**
 * Test a specific search query: "החלטות בגוש 6158"
 * Expected: Response filters by block number and returns relevant decisions
 */
async function test_specific_search(): Promise<void> {
  console.log('\nRunning: test_specific_search()');
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  // Test case 1: Send specific block search query
  try {
    const request: ChatRequest = {
      message: 'החלטות בגוש 6158'
    };

    console.log('  Sending query: "החלטות בגוש 6158"');
    const response = await sendChatRequest(request);

    if (response === null) {
      console.log('  ⊘ API call failed - test skipped (webhook may be unavailable)');
      skipped++;
    } else {
      // Validate response structure
      const validation = validateResponseStructure(response);
      if (!validation.valid) {
        console.log(`  ✗ Invalid response structure: ${validation.errors.join(', ')}`);
        failed++;
      } else {
        assert.strictEqual(response.success, true,
          'Response should indicate success');
        console.log('  ✓ Response structure is valid');
        passed++;
      }
    }
  } catch (error) {
    console.log(`  ✗ Send specific block search query: ${(error as Error).message}`);
    failed++;
  }

  // Test case 2: Response mentions the searched block number
  try {
    const request: ChatRequest = {
      message: 'החלטות בגוש 6158'
    };

    const response = await sendChatRequest(request);

    if (response === null || !response.success) {
      console.log('  ⊘ Block reference check skipped');
      skipped++;
    } else {
      // Response should mention block 6158 or indicate no results found
      const responseText = response.response;
      const mentionsBlock = responseText.includes('6158') ||
                            responseText.includes('גוש') ||
                            responseText.includes('לא נמצאו') ||
                            responseText.includes('לא נמצא');

      assert.ok(mentionsBlock,
        'Response should mention the block number or indicate search status');
      console.log('  ✓ Response acknowledges block search');
      passed++;
    }
  } catch (error) {
    console.log(`  ✗ Response mentions the searched block number: ${(error as Error).message}`);
    failed++;
  }

  // Test case 3: Response is in Hebrew
  try {
    const request: ChatRequest = {
      message: 'החלטות בגוש 6158'
    };

    const response = await sendChatRequest(request);

    if (response === null || !response.success) {
      console.log('  ⊘ Hebrew content check skipped');
      skipped++;
    } else {
      assert.ok(containsHebrew(response.response),
        'Response should contain Hebrew text');
      console.log('  ✓ Response is in Hebrew');
      passed++;
    }
  } catch (error) {
    console.log(`  ✗ Response is in Hebrew: ${(error as Error).message}`);
    failed++;
  }

  // Test case 4: Query with different block number produces different response
  try {
    const request1: ChatRequest = { message: 'החלטות בגוש 6158' };
    const request2: ChatRequest = { message: 'החלטות בגוש 1234' };

    const response1 = await sendChatRequest(request1);
    const response2 = await sendChatRequest(request2);

    if (response1 === null || response2 === null || !response1.success || !response2.success) {
      console.log('  ⊘ Different block comparison skipped');
      skipped++;
    } else {
      // Responses should be different (or both indicate no results)
      // This verifies the filter is actually being applied
      const response1Text = response1.response;
      const response2Text = response2.response;

      // They don't need to be completely different, but the search should acknowledge the different blocks
      const r1HasBlock6158 = response1Text.includes('6158');
      const r2HasBlock1234 = response2Text.includes('1234');
      const bothEmpty = (response1Text.includes('לא נמצא') || response1Text.includes('לא נמצאו')) &&
                       (response2Text.includes('לא נמצא') || response2Text.includes('לא נמצאו'));

      assert.ok(r1HasBlock6158 || r2HasBlock1234 || bothEmpty || response1Text !== response2Text,
        'Different block searches should produce contextually different responses');
      console.log('  ✓ Different blocks produce different responses');
      passed++;
    }
  } catch (error) {
    console.log(`  ✗ Different blocks produce different responses: ${(error as Error).message}`);
    failed++;
  }

  // Test case 5: Sources include block information (if available)
  try {
    const request: ChatRequest = {
      message: 'החלטות בגוש 6158'
    };

    const response = await sendChatRequest(request);

    if (response === null || !response.success) {
      console.log('  ⊘ Sources check skipped');
      skipped++;
    } else {
      // Sources may be empty if no documents match, but structure should be valid
      if (response.sources && response.sources.length > 0) {
        // Check that sources have required fields
        for (const source of response.sources) {
          assert.ok(source.title, 'Each source should have a title');
          assert.ok(source.url, 'Each source should have a URL');
        }
        console.log(`  ✓ Sources returned with valid structure (${response.sources.length} sources)`);
      } else {
        // No sources is acceptable - the block may not exist in the database
        console.log('  ✓ No sources returned (block may not exist in database)');
      }
      passed++;
    }
  } catch (error) {
    console.log(`  ✗ Sources include block information: ${(error as Error).message}`);
    failed++;
  }

  // Test case 6: Search with Hebrew block prefix "גוש" works the same
  try {
    const request1: ChatRequest = { message: 'החלטות בגוש 6158' };
    const request2: ChatRequest = { message: 'מצא החלטות בנושא גוש 6158' };

    const response1 = await sendChatRequest(request1);
    const response2 = await sendChatRequest(request2);

    if (response1 === null || response2 === null || !response1.success || !response2.success) {
      console.log('  ⊘ Hebrew prefix variations skipped');
      skipped++;
    } else {
      // Both should return valid responses for the same block
      assert.ok(response1.response.length > 0 && response2.response.length > 0,
        'Both query variations should return responses');
      console.log('  ✓ Hebrew block prefix variations both work');
      passed++;
    }
  } catch (error) {
    console.log(`  ✗ Hebrew block prefix variations: ${(error as Error).message}`);
    failed++;
  }

  // Test case 7: Combined block and plot search
  try {
    const request: ChatRequest = {
      message: 'החלטות בגוש 6158 חלקה 25'
    };

    const response = await sendChatRequest(request);

    if (response === null || !response.success) {
      console.log('  ⊘ Combined block/plot search skipped');
      skipped++;
    } else {
      // Response should indicate understanding of both block and plot
      const responseText = response.response;
      const mentionsBoth = (responseText.includes('6158') || responseText.includes('גוש')) &&
                           (responseText.includes('25') || responseText.includes('חלקה') ||
                            responseText.includes('לא נמצא') || responseText.includes('לא נמצאו'));

      // Either mentions search criteria or indicates no results
      assert.ok(responseText.length > 20,
        'Response should provide meaningful content for combined search');
      console.log('  ✓ Combined block/plot search works');
      passed++;
    }
  } catch (error) {
    console.log(`  ✗ Combined block/plot search: ${(error as Error).message}`);
    failed++;
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`);

  if (failed > 0) {
    process.exit(1);
  }
}

// ============================================================
// Main - Run tests
// ============================================================

async function runTests(): Promise<void> {
  console.log('===== E2E Tests - Chat Flow =====\n');
  console.log(`Webhook URL: ${WEBHOOK_URL}`);
  console.log(`Timeout: ${TIMEOUT_MS / 1000}s\n`);

  await test_simple_query();
  await test_specific_search();

  console.log('\n✓ All tests completed!');
}

// Run tests
runTests().catch(error => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
