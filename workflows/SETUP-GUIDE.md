# RAG Chatbot Setup Guide - שמאות מכריעה

This guide will help you set up the complete RAG (Retrieval Augmented Generation) system for querying decisive appraisal decisions from gov.il.

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Gov.il API     │────▶│  1. Scraper      │────▶│  Documents  │
│  (Publications) │     │  Workflow        │     │  JSON       │
└─────────────────┘     └──────────────────┘     └──────┬──────┘
                                                        │
                                                        ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Pinecone       │◀────│  2. Processor    │◀────│  OpenAI     │
│  Vector DB      │     │  Workflow        │     │  Embeddings │
└────────┬────────┘     └──────────────────┘     └─────────────┘
         │
         │  Query
         ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  3. RAG Chatbot │◀────│  OpenAI GPT-4    │────▶│  Frontend   │
│  Workflow       │     │  Chat            │     │  Interface  │
└─────────────────┘     └──────────────────┘     └─────────────┘
```

## Prerequisites

1. **n8n Instance** - Self-hosted or n8n.cloud
2. **OpenAI API Key** - For embeddings and chat
3. **Pinecone Account** - For vector storage (free tier available)

## Step 1: Set Up Pinecone

1. Go to [Pinecone](https://www.pinecone.io/) and create a free account
2. Create a new index with these settings:
   - **Name**: `gov-il-decisions`
   - **Dimensions**: `1536` (for OpenAI text-embedding-3-small)
   - **Metric**: `cosine`
3. Copy your:
   - **API Key**: Found in API Keys section
   - **Host URL**: Found in your index details (e.g., `gov-il-decisions-xxxxx.svc.us-east1-gcp.pinecone.io`)

## Step 2: Configure n8n Credentials

### OpenAI Credentials
1. In n8n, go to **Settings > Credentials**
2. Click **Add Credential** > **OpenAI API**
3. Enter your OpenAI API Key
4. Save

### Pinecone Credentials
1. Add **Pinecone API** credential
2. Enter your API Key
3. Save

### Environment Variables
Set these in your n8n environment:
```
PINECONE_HOST=your-index-host.pinecone.io
```

## Step 3: Import Workflows

### Import Order:
1. `1-gov-il-scraper.json` - Document scraper
2. `2-document-processor.json` - Embedding processor
3. `3-rag-chatbot.json` - Chat interface

### Import Steps:
1. In n8n, click **Workflows** > **Import from File**
2. Select each JSON file
3. Update credentials in each workflow:
   - Click on HTTP Request nodes
   - Select your OpenAI/Pinecone credentials

## Step 4: Run the Scraper

1. Open `Gov.il Decisive Appraisal Scraper` workflow
2. Click **Execute Workflow**
3. The workflow will:
   - Fetch documents from gov.il API
   - Handle pagination automatically
   - Output all documents as JSON

### Manual Document Processing:
If the automated trigger doesn't work, you can manually send documents to the processor:

```bash
curl -X POST "https://your-n8n/webhook/process-documents" \
  -H "Content-Type: application/json" \
  -d '{"documents": [...]}'
```

## Step 5: Activate the Chatbot

1. Open `RAG Chatbot - Decisive Appraisal` workflow
2. Click **Activate** to enable the webhook
3. Copy the webhook URL (shown in the Webhook node)

## Step 6: Set Up Frontend

1. Open `chatbot-frontend.html` in a browser
2. Enter your n8n webhook URL in the configuration field
3. Start chatting!

### Hosting Options:
- **Local**: Simply open the HTML file
- **Static Hosting**: Deploy to Netlify, Vercel, or GitHub Pages
- **n8n**: Serve from n8n using a static file response

## Troubleshooting

### "No documents found" from scraper
The gov.il API requires specific search parameters. Try modifying the search term in the `Set Config` node:
- Change `searchTerm` to different Hebrew keywords
- Try: `היטל השבחה`, `פיצויים`, `הפקעות`

### Pinecone connection errors
1. Verify your PINECONE_HOST environment variable
2. Check that the API key has write permissions
3. Ensure the index exists and has correct dimensions

### OpenAI rate limits
If you're processing many documents:
1. Reduce batch size in the processor workflow
2. Add a delay node between batches
3. Consider using OpenAI's batch API for large volumes

### CORS errors on frontend
The webhook is configured with CORS headers. If you still have issues:
1. Deploy frontend to same domain as n8n
2. Or use a CORS proxy
3. Or run n8n with proper CORS configuration

## Customization

### Change the AI Model
Edit the `Generate AI Response` node:
- Replace `gpt-4o` with `gpt-4-turbo` or `gpt-3.5-turbo`

### Change Embedding Model
Edit the `Create OpenAI Embedding` node:
- Replace `text-embedding-3-small` with `text-embedding-3-large` for better accuracy
- Note: You'll need to recreate your Pinecone index with 3072 dimensions

### Add More Sources
Modify the scraper workflow to fetch from additional gov.il endpoints or other sources.

## API Reference

### Chat Endpoint
```
POST /webhook/chat
Content-Type: application/json

{
  "message": "מה זה שמאי מכריע?",
  "history": [
    {"role": "user", "content": "previous message"},
    {"role": "assistant", "content": "previous response"}
  ]
}
```

### Response
```json
{
  "success": true,
  "response": "שמאי מכריע הוא...",
  "sources": [
    {
      "title": "Document Title",
      "url": "https://...",
      "score": 0.92
    }
  ],
  "matchCount": 5
}
```

## Support

For issues with:
- **n8n**: https://community.n8n.io/
- **Pinecone**: https://docs.pinecone.io/
- **OpenAI**: https://help.openai.com/
