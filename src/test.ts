// src/test.ts
import { chromium, Page, Browser } from 'playwright';
import * as fs from 'fs/promises'; // Use fs.promises for async file operations
import * as path from 'path';
import { extractVisibleElementLocators, ExtractedLocator } from './index';

async function run() {
    let browser: Browser | undefined;
    let page: Page | undefined;
    const outputFileName = 'extracted_locators.json';
    const outputPath = path.join(__dirname, '..', outputFileName); // Output to project root

    try {
        browser = await chromium.launch({ headless: false });
        page = await browser.newPage();

        console.log('Navigating to example page...');
        await page.goto('https://www.demoblaze.com/', { waitUntil: 'domcontentloaded' });
        console.log('Page loaded.');

        // Initialize the utility for dynamic observation
        const utility = await extractVisibleElementLocators(page, {
            dynamicElementObservationInterval: 3000, // Check every 3 seconds for new elements
            nameMaxLength: 80 // Max length for the extracted name
        });

        // --- Simulate a user flow ---

        console.log('Simulating user interaction: Clicking "Laptops" category...');
        await page.locator('a.nav-link').filter({ hasText: 'Laptops' }).click();
        await page.waitForLoadState('networkidle'); // Wait for products to load

        console.log('Simulating user interaction: Clicking "Monitors" category...');
        await page.locator('a.nav-link').filter({ hasText: 'Monitors' }).click();
        await page.waitForLoadState('networkidle');

        console.log('Simulating user interaction: Clicking "Samsung galaxy s6" (which might disappear on category change)...');
        await page.locator('a.nav-link').filter({ hasText: 'Phones' }).click(); // Go back to Phones
        await page.waitForLoadState('networkidle');
        // This element is usually present on the phones category, click it
        await page.locator('.card-title a').filter({ hasText: 'Samsung galaxy s6' }).click();
        await page.waitForLoadState('networkidle');
        console.log('Currently on product detail page. Observing for a few seconds...');
        await page.waitForTimeout(5000); // Give some time for observations on this page

        console.log('Navigating back to home page...');
        await page.locator('.navbar-brand').click(); // Click on 'PRODUCT STORE' to go home
        await page.waitForLoadState('networkidle');
        console.log('Back on home page. Final observation pass.');
        await page.waitForTimeout(3000); // Final wait for elements to settle


        // Stop the dynamic element observation after the flow is complete
        utility.stopObservation();

        const locators: ExtractedLocator[] = utility.getLocators();
        console.log('\n--- Final Extracted Locators ---');
        console.log(`Total unique visible and interactable elements found: ${locators.length}`);

        // Write output to JSON file
        try {
            await fs.writeFile(outputPath, JSON.stringify(locators, null, 2));
            console.log(`\nSuccessfully wrote locators to: ${outputPath}`);
        } catch (fileError) {
            console.error('Failed to write JSON file:', fileError);
        }

    } catch (error: any) {
        console.error('An error occurred during the process:', error);
    } finally {
        if (browser) {
            await browser.close();
            console.log('Browser closed.');
        }
    }
}

run();