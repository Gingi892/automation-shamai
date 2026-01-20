// Parse gov.il decisive appraisal decisions HTML
const html = $input.first().json.data || $input.first().json.body || String($input.first().json);
const config = $('Set Config').first().json;
const existingDocs = config.allDocuments || [];

let documents = [];
let debug = { htmlLength: html.length };

// Extract decisions using the specific gov.il HTML structure
const titlePattern = /<h3 class="txt bold ng-binding">([^<]+)<\/h3>/gi;
const pdfPattern = /href="(https:\/\/free-justice\.openapi\.gov\.il[^"]+)"/gi;

const titles = [];
let match;
while ((match = titlePattern.exec(html)) !== null) {
  titles.push(match[1].trim());
}

const pdfLinks = [];
while ((match = pdfPattern.exec(html)) !== null) {
  pdfLinks.push(match[1]);
}

debug.titlesFound = titles.length;
debug.pdfLinksFound = pdfLinks.length;

const datePattern = /<bdi>(\d{1,2}\.\d{1,2}\.\d{4})<\/bdi>/gi;
const dates = [];
while ((match = datePattern.exec(html)) !== null) {
  dates.push(match[1]);
}

for (let i = 0; i < titles.length; i++) {
  const title = titles[i];
  const pdfUrl = pdfLinks[i] || '';
  const date = dates[i] || '';

  const titleMatch = title.match(/הכרעת שמאי (מכריע|מייעץ) מיום (\d{2}-\d{2}-\d{4}) בעניין ([^נ]+)נ ([^ג]+)ג (\d+) ח (\d+) - (.+)/);

  let metadata = {};
  if (titleMatch) {
    metadata = {
      appraiserRole: titleMatch[1] === 'מכריע' ? 'שמאי מכריע' : 'שמאי מייעץ',
      decisionDate: titleMatch[2],
      caseType: titleMatch[3].trim(),
      committee: titleMatch[4].trim().replace('ועדה מקומית ', ''),
      block: titleMatch[5],
      plot: titleMatch[6],
      appraiser: titleMatch[7].trim()
    };
  }

  documents.push({
    title: title,
    url: pdfUrl,
    publishDate: date,
    id: 'decision-' + (existingDocs.length + i),
    ...metadata
  });
}

debug.htmlSample = html.substring(0, 2000);

const allDocuments = [...existingDocs, ...documents];
const hasMore = documents.length >= 5 && (config.currentSkip / config.pageSize) < config.maxPages - 1;

return {
  documents: allDocuments,
  newCount: documents.length,
  hasMore,
  currentSkip: config.currentSkip,
  nextSkip: config.currentSkip + config.pageSize,
  baseUrl: config.baseUrl,
  scraperApiKey: config.scraperApiKey,
  pageSize: config.pageSize,
  maxPages: config.maxPages,
  debug
};
