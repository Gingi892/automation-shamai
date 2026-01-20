# Hallucination Detection for GovIL RAG Chatbot

This document describes the implementation of Strawberry/Pythea-style hallucination detection in the n8n RAG chatbot workflow.

## Overview

The hallucination detection system verifies that the AI's responses are grounded in the retrieved documents. It uses a probabilistic approach based on the Strawberry algorithm to detect when the model generates claims that aren't supported by the evidence.

## Architecture

```
User Query → Embed → Pinecone → Build Context → GPT-4o → Extract Claims
                                                              ↓
                                            ┌─────────────────┴─────────────────┐
                                            ↓                                   ↓
                              Verify Posterior (Full Context)    Verify Prior (Scrubbed Context)
                                            ↓                                   ↓
                                            └─────────────────┬─────────────────┘
                                                              ↓
                                               Compute Budget Gaps (KL Divergence)
                                                              ↓
                                               Format Response with Flags
                                                              ↓
                                                        Response
```

## Core Algorithm

The Strawberry algorithm detects hallucinations by comparing two probabilities:

1. **p1 (Posterior)**: P(claim entailed | full context) - verifier sees all evidence
2. **p0 (Prior)**: P(claim entailed | scrubbed context) - cited evidence is [REDACTED]

**Key insight**: If p1 ≈ p0, the model didn't use the cited evidence to make the claim → likely hallucinated.

### KL Divergence Calculation

```javascript
function klBernoulli(p, q) {
  const eps = 1e-12;
  p = Math.max(eps, Math.min(1 - eps, p));
  q = Math.max(eps, Math.min(1 - eps, q));
  return p * Math.log(p / q) + (1 - p) * Math.log((1 - p) / (1 - q));
}

// Budget gap = observed_bits - required_bits
// observed_bits = KL(Ber(p1) || Ber(0.5)) - info from seeing context
// required_bits = KL(Ber(p1) || Ber(p0)) - info needed from cited evidence
```

### Grounding Score Calculation

```javascript
function computeGroundingScore(p1, p0, hasCitations) {
  // Evidence use detection: if p1 >> p0, model used the evidence
  const evidenceUse = Math.max(0, p1 - p0);
  const evidenceUsed = hasCitations ? evidenceUse > 0.15 : true;

  // Confidence score (0-1)
  let confidence;
  if (!hasCitations) {
    confidence = p1 > 0.7 ? p1 * 0.7 : p1 * 0.4; // Penalize uncited claims
  } else {
    confidence = Math.min(1, evidenceUse * 1.5 + (p1 > 0.7 ? 0.3 : 0));
  }

  // Grounded if good confidence AND evidence was used
  return confidence > 0.45 && evidenceUsed;
}
```

## Workflow Nodes

### 1. Extract Claims & Citations
- Splits AI response into sentences
- Extracts [S0], [S1] style citations
- Maps claims to their cited documents

### 2. Build Verification Prompts
- Creates full context and scrubbed context versions
- Scrubbed context replaces cited document text with [REDACTED]

### 3. Verify Posterior / Prior (HTTP Requests)
- Calls OpenAI gpt-4o-mini with `logprobs: true`
- Asks: "Is this claim entailed by the context? YES/NO/UNSURE"
- Extracts P(YES) from logprobs

### 4. Merge Verification Results
- Combines posterior and prior responses by position

### 5. Compute Budget Gaps
- Calculates KL divergence for each claim
- Determines grounding status based on evidence use

### 6. Format Response with Flags
- Adds `hallucination_check` object to response
- Includes warning message if claims are ungrounded

## Response Format

```json
{
  "success": true,
  "response": "לפי ההחלטה, השמאי קבע כי...",
  "sources": [...],
  "hallucination_check": {
    "overall_grounded": true,
    "grounded_claims": 3,
    "total_claims": 4,
    "grounding_ratio": 0.75,
    "claims": [
      {
        "text": "השמאי קבע פיצוי של 50,000 ש\"ח",
        "citing": ["S0"],
        "p1": 0.92,
        "p0": 0.25,
        "confidence": 0.88,
        "grounded": true,
        "warning": null
      },
      {
        "text": "זה נפוץ במקרים דומים",
        "citing": [],
        "p1": 0.45,
        "p0": 0.42,
        "confidence": 0.15,
        "grounded": false,
        "warning": "לא נמצא מקור מספק"
      }
    ]
  },
  "warning": "שים לב: 1 טענות בתשובה לא נתמכות במלואן על ידי המקורות."
}
```

## Configuration

### Verifier Model
Uses `gpt-4o-mini` for verification - fast and cost-effective.

### Thresholds
- **Evidence use threshold**: 0.15 (p1 - p0 must exceed this for cited claims)
- **Confidence threshold**: 0.45 (minimum confidence to be considered grounded)
- **Overall grounding**: 70% of claims must be grounded

### Limits
- Maximum 10 claims verified per response (for performance)
- Minimum claim length: 15 characters (to skip short fragments)

## Testing

A test workflow is available at `workflows/tests/hallucination-detection-tests.json` with four test cases:

1. **Test 1**: Claim fully supported by context → NOT flagged
2. **Test 2**: Claim contradicts context → flagged
3. **Test 3**: Confabulated claim (not in context) → flagged
4. **Test 4**: Multiple claims with mixed support → correct flags

## Cost Considerations

Each response verification makes 2 API calls per claim:
- ~$0.0001 per claim with gpt-4o-mini
- Typical response with 5 claims: ~$0.001

## Future Improvements

1. **Batch API**: Use OpenAI's batch API for lower costs on high volume
2. **Caching**: Cache verification results for identical context+claim pairs
3. **Streaming**: Return initial response immediately, add hallucination check async
4. **Threshold tuning**: Adjust thresholds based on real-world false positive/negative rates

## References

- [Strawberry Paper](https://arxiv.org/abs/2410.02320) - Original Pythea/Strawberry algorithm
- [OpenAI Logprobs](https://platform.openai.com/docs/api-reference/chat/create#chat-create-logprobs) - API documentation for logprobs
