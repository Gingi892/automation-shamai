import puppeteer from 'puppeteer';

async function test() {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    try {
        // Load page and wait
        console.log('Loading page...');
        await page.goto('https://www.gov.il/he/departments/dynamiccollectors/decisive_appraisal_decisions', {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        // Wait much longer
        console.log('Initial wait...');
        await new Promise(r => setTimeout(r, 5000));

        // Check current state
        let state = await getPageState(page);
        console.log('Before search:', JSON.stringify(state, null, 2));

        // Type search text
        console.log('Typing search...');
        await page.click('input[name="SearchText_keywords"]');
        await page.type('input[name="SearchText_keywords"]', 'תל אביב', { delay: 100 });

        // Try multiple submission methods
        console.log('Submitting...');

        // Method 1: Press Enter
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 5000));

        state = await getPageState(page);
        console.log('After Enter:', JSON.stringify(state, null, 2));

        // If no change, try scrolling down (might trigger lazy load)
        if (state.bodyLen < 10000) {
            console.log('Scrolling...');
            await page.evaluate(() => window.scrollBy(0, 1000));
            await new Promise(r => setTimeout(r, 3000));
            state = await getPageState(page);
            console.log('After scroll:', JSON.stringify(state, null, 2));
        }

        // Take final screenshot
        await page.screenshot({ path: 'final-test.png', fullPage: true });
        console.log('Screenshot saved to final-test.png');

        // Get full body text sample
        const bodyText = await page.evaluate(() => document.body.innerText.slice(3000, 5000));
        console.log('\nBody text sample (chars 3000-5000):');
        console.log(bodyText);

    } finally {
        await browser.close();
    }
}

async function getPageState(page) {
    return await page.evaluate(() => ({
        bodyLen: document.body.innerText.length,
        title: document.title,
        resultsText: document.body.innerText.includes('תוצאות'),
        pdfLinks: document.querySelectorAll('a[href*=".pdf"]').length,
        blobLinks: document.querySelectorAll('a[href*="BlobFolder"]').length,
        allLinks: document.querySelectorAll('a').length,
        buttons: document.querySelectorAll('button').length
    }));
}

test().catch(e => console.error('Error:', e.message));
