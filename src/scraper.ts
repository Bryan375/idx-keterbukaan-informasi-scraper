import * as dotenv from 'dotenv';
import {AnnouncementSentiment, Announcement} from "./types/announcement";
import {TARGET_URL, NOISE_PATTERNS} from "./config/constants";
import {getFormattedDate} from "./helpers/date.helper";
import {sendEmailReport} from "./services/email.service";
import {analyzeCombinedContent, extractPdfText} from "./services/gemini.service";
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import {Browser, Page} from "puppeteer";
import {Request, Response} from "express";

puppeteer.use(StealthPlugin());

dotenv.config();

const TODAY_DATE = getFormattedDate(new Date());

function parseIndonesianDate(dateStr: string): Date {
    try {
        const months: { [key: string]: number } = {
            'januari': 0, 'februari': 1, 'maret': 2, 'april': 3,
            'mei': 4, 'juni': 5, 'juli': 6, 'agustus': 7,
            'september': 8, 'oktober': 9, 'november': 10, 'desember': 11
        };

        const parts = dateStr.toLowerCase().split(' ');
        if (parts.length >= 4) {
            const day = Number.parseInt(parts[0]);
            const month = months[parts[1]];
            const year = Number.parseInt(parts[2]);
            const timeParts = parts[3].split(':');
            const hour = Number.parseInt(timeParts[0]);
            const minute = Number.parseInt(timeParts[1]);
            const second = Number.parseInt(timeParts[2] || '0');

            return new Date(year, month, day, hour, minute, second);
        }
    } catch (error) {
        console.error('Failed to parse date:', dateStr, error);
    }
    return new Date(0);
}

function isPdfUrl(url: string): boolean {
    return url.toLowerCase().endsWith('.pdf') || url.toLowerCase().includes('.pdf');
}


async function downloadPdfBuffer(page: Page, url: string, pdfLabel: string): Promise<Buffer | null> {
    try {
        console.log(`   📥 Downloading ${pdfLabel}: ${url}`);
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

        return Buffer.from(pdfBufferAsBase64, 'base64');

    } catch (error) {
        console.error(`   ❌ Failed to download ${pdfLabel}:`, error);
        return null;
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

            const titleLink = card.querySelector('h6 a') as HTMLAnchorElement;
            const titleUrl = titleLink?.href || '';

            const attachmentLinks = card.querySelectorAll('ul li a');
            const attachments = Array.from(attachmentLinks).map(link => ({
                text: (link as HTMLElement).innerText.trim(),
                url: (link as HTMLAnchorElement).href,
            }));

            data.push({time, title, titleUrl, attachments});
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

export async function analyzeAnnouncements(
    page: Page,
    allAnnouncements: Omit<Announcement, 'sentiment'>[]
): Promise<Announcement[]> {
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

        console.log(`\n- - - - - - - - - ▶️  [Analyzing] [${ann.time}] "${ann.title}"`);

        const allPdfUrls: { url: string; label: string }[] = [];

        if (ann.titleUrl && isPdfUrl(ann.titleUrl)) {
            allPdfUrls.push({ url: ann.titleUrl, label: 'Title PDF' });
        }

        const pdfAttachments = ann.attachments.filter(att =>
            att.text.toLowerCase().includes('.pdf') || isPdfUrl(att.url)
        );

        for (const att of pdfAttachments) {
            const index = pdfAttachments.indexOf(att);
            allPdfUrls.push({ url: att.url, label: `Attachment PDF ${index + 1}` });
        }

        let sentiment: AnnouncementSentiment;

        if (allPdfUrls.length > 0) {
            console.log(`   📚 Found ${allPdfUrls.length} PDF(s) total (including title). Downloading all...`);

            const pdfBuffers: Buffer[] = [];

            for (const pdfInfo of allPdfUrls) {
                const buffer = await downloadPdfBuffer(page, pdfInfo.url, pdfInfo.label);
                if (buffer) {
                    pdfBuffers.push(buffer);
                }
                await delay(2000);
            }

            if (pdfBuffers.length === 0) {
                console.log(`   ❌ Failed to download any PDFs`);
                sentiment = { isInteresting: false, reasoning: 'Gagal mengunduh PDF.' };
            } else {
                console.log(`   ✅ Successfully downloaded ${pdfBuffers.length} PDF(s). Extracting text...`);

                const combinedTexts: string[] = [];
                const scannedPdfBuffers: Buffer[] = [];

                for (let i = 0; i < pdfBuffers.length; i++) {
                    const { text, isScanned } = await extractPdfText(pdfBuffers[i]);

                    if (isScanned) {
                        console.log(`      📸 PDF ${i + 1} is a scanned image`);
                        scannedPdfBuffers.push(pdfBuffers[i]);
                    } else if (text.trim().length > 0) {
                        console.log(`      📝 PDF ${i + 1} has ${text.length} characters of text`);
                        combinedTexts.push(`\n--- PDF ${i + 1} ---\n${text}`);
                    }
                }

                const combinedText = combinedTexts.join('\n\n');


                console.log(`   🔍 Analyzing combined content (${combinedText.length} chars text + ${scannedPdfBuffers.length} scanned PDFs)...`);

                sentiment = await analyzeCombinedContent(combinedText, scannedPdfBuffers, ann.title);

                if (sentiment.isInteresting) {
                    console.log(`   ✅ [Interesting] Found significant event! ${sentiment.reasoning}`);
                } else {
                    console.log(`   ℹ️  [Not Interesting] ${sentiment.reasoning}`);
                }
            }
        }
        else {
            console.log(`   ⚠️  No PDFs found in title or attachments.`);
            sentiment = { isInteresting: false, reasoning: 'Tidak ada PDF untuk dianalisis.' };
        }

        analyzedAnnouncements.push({...ann, sentiment});

        await delay(5000);
    }

    return analyzedAnnouncements;
}


async function idxScraper() {
    if (!process.env.GEMINI_APP_KEY) {
        console.error('❌ GEMINI_APP_KEY is not set');
        return;
    }
    let browser: Browser | null = null;

    console.log('🚀 Starting IDX Scraper...');

    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page: Page = await browser.newPage();

        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent({userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/57.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'})

        await page.goto(TARGET_URL, {waitUntil: 'networkidle0'});

        const successClickedDate = await clickDateInputField(page);

        if (!successClickedDate) {
            console.log('Failed to find or click the date input field on the page.');
            return;
        }

        const allAnnouncements: Omit<Announcement, 'sentiment'>[] = await extractAllAnnouncements(page);
        console.log(`Total of announcements: ${allAnnouncements.length}`)

        allAnnouncements.sort((a, b) => {
            const dateA = parseIndonesianDate(a.time);
            const dateB = parseIndonesianDate(b.time);
            return dateB.getTime() - dateA.getTime();
        });
        console.log(`✅ Sorted announcements by time (newest first)`);

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
}

export const idxScraperEndpoint = (req: Request, res: Response) => {
    console.log('▶️  IDX Scraper endpoint triggered.');
    res.status(202).send('Scraper triggered successfully.');

    idxScraper().catch(error => {
        console.error('❌ An unexpected error occurred during scraping:', error);
        res.status(500).send('An unexpected error occurred during scraping.');
    })
}

if (require.main === module) {
    idxScraper();
}