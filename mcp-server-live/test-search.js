import puppeteer from 'puppeteer';

async function test() {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Anti-bot detection
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    try {
        const url = 'https://www.gov.il/he/departments/dynamiccollectors/decisive_appraisal_decisions';
        console.log('Navigating to:', url);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        await new Promise(r => setTimeout(r, 3000));

        console.log('Page loaded. Typing search text...');

        // Type into the free text search field
        const searchInput = 'input[name="SearchText_keywords"]';
        await page.waitForSelector(searchInput, { timeout: 10000 });
        await page.click(searchInput);
        await page.type(searchInput, 'תל אביב', { delay: 100 });

        console.log('Search text entered. Looking for submit button...');
        await new Promise(r => setTimeout(r, 1000));

        // Find and click the form's search button
        // The form is SearchForm, need to find its submit mechanism
        const clicked = await page.evaluate(() => {
            const form = document.getElementById('SearchForm');
            if (!form) return 'No form';

            // Look for a button that looks like search/submit
            const allButtons = form.querySelectorAll('button, input[type="submit"]');
            for (const btn of allButtons) {
                const text = btn.textContent || btn.value || '';
                const classes = btn.className || '';
                if (text.includes('חפש') || text.includes('חיפוש') || text.includes('סנן') ||
                    classes.includes('search') || classes.includes('submit') || classes.includes('filter')) {
                    btn.click();
                    return 'Clicked: ' + (text || classes);
                }
            }

            // If no specific button found, try form.requestSubmit()
            if (form.requestSubmit) {
                form.requestSubmit();
                return 'requestSubmit()';
            }

            return 'No button found';
        });

        console.log('Click result:', clicked);

        // Wait for results to load
        console.log('Waiting for results...');

        // Poll for PDF links or result items
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 2000));

            const status = await page.evaluate(() => {
                const pdfLinks = document.querySelectorAll('a[href*=".pdf"]');
                const resultItems = document.querySelectorAll('[class*="result-item"], [class*="collector-item"]');
                const blobLinks = document.querySelectorAll('a[href*="BlobFolder"]');
                return {
                    pdfLinks: pdfLinks.length,
                    resultItems: resultItems.length,
                    blobLinks: blobLinks.length,
                    bodyLen: document.body.innerText.length
                };
            });

            console.log('Check ' + (i+1) + ':', JSON.stringify(status));

            if (status.pdfLinks > 0 || status.blobLinks > 0) {
                console.log('Results found!');
                break;
            }
        }

        // Extract results
        const results = await page.evaluate(() => {
            const pdfLinks = Array.from(document.querySelectorAll('a[href*=".pdf"]')).slice(0, 5);
            const blobLinks = Array.from(document.querySelectorAll('a[href*="BlobFolder"]')).slice(0, 5);

            return {
                pdfLinks: pdfLinks.map(a => ({ text: a.textContent?.trim().slice(0, 50), href: a.href })),
                blobLinks: blobLinks.map(a => ({ text: a.textContent?.trim().slice(0, 50), href: a.href }))
            };
        });

        console.log('\nPDF Links:');
        results.pdfLinks.forEach((l, i) => console.log((i+1) + '. ' + l.text + '\n   ' + l.href));

        console.log('\nBlob Links:');
        results.blobLinks.forEach((l, i) => console.log((i+1) + '. ' + l.text + '\n   ' + l.href));

        // Save screenshot
        await page.screenshot({ path: 'search-result.png', fullPage: true });
        console.log('\nScreenshot saved to search-result.png');

    } finally {
        await browser.close();
    }
}

test().catch(e => console.error('Error:', e.message));
