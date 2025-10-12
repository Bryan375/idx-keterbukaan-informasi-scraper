import * as dotenv from 'dotenv';
import {AnnouncementSentiment, Announcement} from "./types/announcement";
import {TARGET_URL, NOISE_PATTERNS} from "./config/constants";
import {getFormattedDate} from "./helpers/date.helper";
import {sendEmailReport} from "./services/email.service";
import {analyzePdfBuffer} from "./services/gemini.service";

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import {Browser, Page} from "puppeteer";

puppeteer.use(StealthPlugin());


dotenv.config();

const TODAY_DATE = getFormattedDate(new Date());

async function analyzeDocument(page: Page, url: string, title: string, attachmentNumber: number): Promise<AnnouncementSentiment> {
    try {
        console.log(`📄 Analyzing document: ${title}-number(${attachmentNumber}) with this url: ${url}`);
        const pdfBufferAsBase64 = await page.evaluate((pdfUrl) => {
            return fetch(pdfUrl)
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`Failed to fetch PDF: ${response.statusText}`);
                    }
                    return response.arrayBuffer();
                })
                .then(buffer => {

                    let binary = '';
                    const bytes = new Uint8Array(buffer);
                    const len = bytes.byteLength;
                    for (let i = 0; i < len; i++) {
                        binary += String.fromCodePoint(bytes[i]);
                    }
                    return globalThis.btoa(binary);
                });
        }, url);

        const buffer = Buffer.from(pdfBufferAsBase64, 'base64');
        return await analyzePdfBuffer(Buffer.from(buffer));

    } catch (error) {
        console.error(`❌ Failed to analyze document ${title}-number(${attachmentNumber}) with this url: ${url}`, error);
        return {isInteresting: false, reasoning: 'Analysis failed.'};
    }
}

export async function clickDateInputField(page: Page): Promise<boolean> {
    try {
        const dateInput = await page.waitForSelector('input[name="date"]', { timeout: 25000 });

        if (!dateInput) return false;

        await dateInput.click();

        console.log(`▶️  Scraping announcements for date: ${TODAY_DATE}`);

        await page.keyboard.type(`${TODAY_DATE} ~ ${TODAY_DATE}`);
        await page.keyboard.press('Enter');

        return true;
    } catch (error) {
        console.error("❌ Failed to find or click the date input field on the page.", error);

        try {
            console.log("📸 Taking a screenshot of the failure page...");
            await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
            console.log("📄 Dumping page HTML...");
            const html = await page.content();
            require('node:fs').writeFileSync('error_page.html', html);
            console.log("✅ Debug files saved: error_screenshot.png, error_page.html");
        } catch (debugError) {
            console.error("❌ Failed to save debug files.", debugError);
        }

        return false;
    }
}

export async function hasNextPage(page: Page): Promise<boolean> {
    const nextPageButton = await page.$('button[aria-label="Go to next page"]:not([disabled])');
    console.log(nextPageButton);
    return nextPageButton !== null;
}

export async function goToNextPage(page: Page): Promise<void> {
    await page.click('button[aria-label="Go to next page"]:not([disabled])');
}

export async function scrapeCurrentPage(page: Page): Promise<Omit<Announcement, 'sentiment'>[]> {
    return page.evaluate(() => {
        const announcementCards = document.querySelectorAll('div.attach-card');
        const data: Omit<Announcement, 'sentiment'>[] = [];

        for (const card of Array.from(announcementCards)) {
            const time = card.querySelector('time')?.innerText.trim() || '';
            const title = card.querySelector('h6')?.innerText.trim() || '';

            const attachmentLinks = card.querySelectorAll('ul li a');
            const attachments = Array.from(attachmentLinks).map(link => ({
                text: (link as HTMLElement).innerText.trim(),
                url: (link as HTMLAnchorElement).href,
            }));

            data.push({time, title, attachments});
        }

        return data;
    });
}

function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function extractAllAnnouncements(page: Page): Promise<Omit<Announcement, 'sentiment'>[]> {
    const allAnnouncements: Omit<Announcement, 'sentiment'>[] = [];

    await page.waitForNetworkIdle({idleTime: 1000});

    do {
        const currentPageData = await scrapeCurrentPage(page);

        allAnnouncements.push(...currentPageData);

        if (await hasNextPage(page)) {
            await goToNextPage(page);

            await page.waitForNetworkIdle({idleTime: 1500});

        } else {
            break;
        }
    } while (true);

    return allAnnouncements;
}

function logAnnouncements(interestingAnnouncements: Announcement[],
                          uninterestingAnnouncements: Announcement[],
                          skippedAnnouncements: Announcement[],
                          failedAnnouncements: Announcement[],): void {

    console.log(`✨ Ditemukan ${interestingAnnouncements.length} pengumuman menarik berdasarkan analisis AI:`);
    for (const ann of interestingAnnouncements) {
        console.log(`- 📢 Judul: ${ann.title}`);
        console.log(`  - 🤔 Alasan: ${ann.sentiment.reasoning}`);
        console.log(`  - 🔗 Link: ${ann.attachments.find(a => a.text.toLowerCase().includes('.pdf'))?.url || 'N/A'}\n`);
    }

    console.log(`\n---`);
    console.log(`
🧐 Ditemukan ${uninterestingAnnouncements.length} pengumuman yang dinilai tidak menarik oleh AI:`);
    for (const ann of uninterestingAnnouncements) {
        console.log(`- 📄 Judul: ${ann.title}`);
        console.log(`  - 🤔 Alasan: ${ann.sentiment.reasoning}`);
    }

    console.log(`\n---`);
    console.log(`
🔇 Ditemukan ${skippedAnnouncements.length} pengumuman yang dilewati berdasarkan judul:`);
    for (const ann of skippedAnnouncements) {
        console.log(`- 📄 Judul: ${ann.title}`);
    }

    console.log(`\n---`);
    console.log(`
❌ Ditemukan ${failedAnnouncements.length} pengumuman yang gagal dianalisis oleh AI:`);
    for (const ann of failedAnnouncements) {
        console.log(`- 📄 Judul: ${ann.title}`);
    }
}

export function isNoise(title: string): boolean {
    if (!title) return false;
    const normalizedTitle = title.trim().toLowerCase();
    return NOISE_PATTERNS.some(pattern =>
        normalizedTitle.includes(pattern.toLowerCase())
    );
}

export async function analyzeAnnouncements(page: Page,allAnnouncements: Omit<Announcement, 'sentiment'>[]): Promise<Announcement[]> {
    const analyzedAnnouncements: Announcement[] = [];

    for (const ann of allAnnouncements) {
        if (isNoise(ann.title)) {
            console.log(`🔇 Skipping noisy title: ${ann.title}`);
            analyzedAnnouncements.push({
                ...ann,
                sentiment: {
                    isInteresting: false,
                    reasoning: 'Filtered out by title noise pattern.'
                }
            });
            continue;
        }

        let sentiment: AnnouncementSentiment = {isInteresting: false, reasoning: 'No PDF found or analyzed.'};

        console.log(`- - - - - - - - - ▶️  [Analyzing] "${ann.title}"`);

        if (ann.attachments.length === 0) {
            console.log(`   ❌ [Failed] No attachments found.`);
            analyzedAnnouncements.push({...ann, sentiment});
            continue;
        }

        let attachmentNumber = 1;
        for (const attachment of ann.attachments) {
            if (attachment.text.toLowerCase().includes('.pdf')) {
                const analysis = await analyzeDocument(page, attachment.url, ann.title, attachmentNumber);
                sentiment = analysis;
                if (analysis.isInteresting) {
                    console.log(`   ✅ [Interesting] Found significant event. Stopping analysis for this announcement.`);
                    break;
                }
                await delay(5000);
            }
        }
        analyzedAnnouncements.push({...ann, sentiment});
    }

    return analyzedAnnouncements;

}

export const idxScraper = async () => {
    if (!process.env.GEMINI_APP_KEY) {
        console.error('❌ GEMINI_APP_KEY is not set');
        return;
    }
    let browser: Browser | null = null;

    console.log('🚀 Starting IDX Scraper Cloud Function...');

    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page: Page = await browser.newPage();

        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent({userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/57.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'})

        await page.goto(TARGET_URL, {waitUntil: 'networkidle0'});

        try {
            console.log('Checking for Cloudflare challenge...');
            const iframeHandle = await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', { timeout: 5000 });

            if (iframeHandle) {
                const iframe = await iframeHandle.contentFrame();
                if (iframe) {
                    // Wait for the checkbox inside the iframe and click it
                    const checkbox = await iframe.waitForSelector('input[type="checkbox"]', { timeout: 5000 });
                    console.log('Cloudflare challenge found. Attempting to click checkbox...');
                    if (checkbox) await checkbox.click();
                    // Wait for the navigation that happens after a successful click
                    await page.waitForNavigation({ waitUntil: 'networkidle2' });
                    console.log('Cloudflare challenge likely passed!');
                }
            }
        } catch (error) {
            console.log('No Cloudflare challenge detected or failed to click, continuing...');
        }

        const successClickedDate = await clickDateInputField(page);

        if (!successClickedDate) {
            console.log('Failed to find or click the date input field on the page.');
            return;
        }

        const allAnnouncements: Omit<Announcement, 'sentiment'>[] = await extractAllAnnouncements(page);
        console.log(`Total of announcements: ${allAnnouncements.length}`)

        const analyzedAnnouncements: Announcement[] = await analyzeAnnouncements(page, allAnnouncements);

        const interestingAnnouncements = analyzedAnnouncements.filter(ann => ann.sentiment.isInteresting);
        const skippedAnnouncements = analyzedAnnouncements.filter(ann => ann.sentiment.reasoning === 'Filtered out by title noise pattern.');
        const failedAnnouncements = analyzedAnnouncements.filter(ann => ann.sentiment.reasoning === 'Analysis failed.');

        const uninterestingAnalyzedAnnouncements = analyzedAnnouncements.filter(ann => (!ann.sentiment.isInteresting && ann.sentiment.reasoning !== 'Analysis failed.') );
        const finalUninterestingAnnouncements = uninterestingAnalyzedAnnouncements.filter(ann => ann.sentiment.reasoning !== 'Filtered out by title noise pattern.');

        console.log(`
                ========================================
                            SCRAPING COMPLETE
                ========================================
        `);

        logAnnouncements(
            interestingAnnouncements,
            finalUninterestingAnnouncements,
            skippedAnnouncements,
            failedAnnouncements,
        )

        await sendEmailReport(
            interestingAnnouncements,
            finalUninterestingAnnouncements,
            skippedAnnouncements,
            failedAnnouncements,
        )

        console.log('Everything done!');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('❌ An unexpected error occurred during scraping:', errorMessage);

    } finally {
        if (browser) {
            await browser.close();
        }
    }
};

if (require.main === module) {
    console.log("🚀 Running scraper directly via node...");
    idxScraper();
}