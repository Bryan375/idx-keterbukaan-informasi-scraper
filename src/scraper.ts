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
        const dateInput = await page.waitForSelector('input[name="date"]', { timeout: 5000 });

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

    console.log('🚀 Starting IDX Scraper...(New)');

    try {
        const executablePath = process.env.CHROMIUM_PATH || '/usr/lib/chromium/chromium' || undefined;
        
        console.log(`🔧 Attempting to launch browser...`);
        console.log(`📂 Executable path: ${executablePath}`);
        console.log(`⏱️  Launch timeout: 60 seconds`);
        console.log(`\n🚀 Launching Chromium now...`);
        
        try {
            browser = await puppeteer.launch({
                headless: true,
                executablePath: executablePath,
                timeout: 60000, // 60 seconds instead of default 30
                dumpio: true, // Print browser process stdout/stderr to console
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--single-process', // Run in single process mode
                    '--no-zygote' // Don't use zygote process
                ]
            });
            
            console.log('\n✅ Browser launched successfully!');
            console.log(`🌐 Browser version: ${await browser.version()}`);
            console.log(`🔗 WebSocket endpoint: ${browser.wsEndpoint()}`);
            console.log(`📊 Number of pages: ${(await browser.pages()).length}`);
            console.log('');
            
        } catch (launchError: any) {
            console.error(`\n❌❌❌ BROWSER LAUNCH FAILED ❌❌❌`);
            console.error(`Error type: ${launchError.constructor.name}`);
            console.error(`Error message: ${launchError.message}`);
            console.error(`\nFull error:`);
            console.error(launchError);
            
            // Additional diagnostics
            console.error(`\n🔍 Diagnostics:`);
            console.error(`  - Node version: ${process.version}`);
            console.error(`  - Platform: ${process.platform}`);
            console.error(`  - Architecture: ${process.arch}`);
            console.error(`  - CWD: ${process.cwd()}`);
            console.error(`  - Environment variables:`);
            console.error(`    CHROMIUM_PATH: ${process.env.CHROMIUM_PATH || 'not set'}`);
            console.error(`    PUPPETEER_EXECUTABLE_PATH: ${process.env.PUPPETEER_EXECUTABLE_PATH || 'not set'}`);
            
            throw launchError; // Re-throw to be caught by outer catch
        }


        const page: Page = await browser.newPage();

        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent({userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/57.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'})

        await page.setViewport({
            width: Math.floor(1024 + Math.random() * 100),
            height: Math.floor(768 + Math.random() * 100),
        });

        await page.goto(TARGET_URL, {waitUntil: 'networkidle0', timeout: 60000});

        console.log('✅ Page navigation completed');
        

        const pageTitle = await page.title();
        const pageUrl = page.url();
        console.log(`📄 Page Title: "${pageTitle}"`);
        console.log(`🔗 Page URL: ${pageUrl}`);
        
        // Comprehensive bot detection check
        console.log('🔍 Checking for Cloudflare/Bot detection...');
        
        const botDetectionResult = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            const title = document.title.toLowerCase();
            const bodyLower = bodyText.toLowerCase();
            
            return {
                // Page info
                title: document.title,
                bodyPreview: bodyText.substring(0, 1000),
                
                // Title checks
                titleHasChallenge: title.includes('just a moment') ||
                                   title.includes('attention required') ||
                                   title.includes('please wait') ||
                                   title.includes('checking'),
                
                // Body text checks
                bodyHasCloudflare: bodyLower.includes('cloudflare'),
                bodyHasChecking: bodyLower.includes('checking your browser'),
                bodyHasVerify: bodyLower.includes('verify you are human'),
                bodyHasChallenge: bodyLower.includes('challenge'),
                bodyHasWait: bodyLower.includes('please wait'),
                
                // Element checks
                hasCaptchaIframe: !!document.querySelector('iframe[src*="captcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare"]'),
                hasCloudflareDiv: !!document.querySelector('#challenge-running, #challenge-stage, .cf-browser-verification, .cf-challenge-running, [class*="cloudflare"]'),
                hasChallengeScript: !!document.querySelector('script[src*="challenges.cloudflare"], script[src*="challenge-platform"]'),
                
                // Check if page is mostly empty (common with challenges)
                bodyLength: bodyText.length,
                hasMinimalContent: bodyText.length < 500
            };
        });
        
        // Log all detection results
        console.log('\n🔍 Detection Results:');
        console.log('  📄 Title:', botDetectionResult.title);
        console.log('  ❓ Title has challenge keywords:', botDetectionResult.titleHasChallenge);
        console.log('  ☁️  Body mentions Cloudflare:', botDetectionResult.bodyHasCloudflare);
        console.log('  🔄 Body has "checking your browser":', botDetectionResult.bodyHasChecking);
        console.log('  ✋ Body has "verify you are human":', botDetectionResult.bodyHasVerify);
        console.log('  🎯 Body has "challenge":', botDetectionResult.bodyHasChallenge);
        console.log('  ⏳ Body has "please wait":', botDetectionResult.bodyHasWait);
        console.log('  🖼️  Has CAPTCHA iframe:', botDetectionResult.hasCaptchaIframe);
        console.log('  🛡️  Has Cloudflare div:', botDetectionResult.hasCloudflareDiv);
        console.log('  📜 Has challenge script:', botDetectionResult.hasChallengeScript);
        console.log('  📏 Body text length:', botDetectionResult.bodyLength);
        console.log('  📭 Has minimal content:', botDetectionResult.hasMinimalContent);
        console.log('\n📝 Body text preview:');
        console.log(botDetectionResult.bodyPreview);
        console.log('\n');
        
        const isBlocked = botDetectionResult.titleHasChallenge ||
                         (botDetectionResult.bodyHasCloudflare && (botDetectionResult.bodyHasChecking || botDetectionResult.bodyHasVerify)) ||
                         botDetectionResult.hasCaptchaIframe ||
                         botDetectionResult.hasCloudflareDiv ||
                         botDetectionResult.hasChallengeScript;
        
        if (isBlocked) {
            console.log('❌❌❌ BLOCKED BY BOT DETECTION / CLOUDFLARE ❌❌❌');

            console.log('\n⚠️  The scraper has been blocked by bot detection.');
            console.log('\n📸 Screenshots saved:');
            console.log('   - /tmp/after-page-load-*.png');
            console.log('   - /tmp/BLOCKED-cloudflare-challenge-*.png');
            console.log('\n🔧 To view screenshots:');
            console.log('   curl http://localhost:8080/screenshots');
            console.log('\n💡 Solutions:');
            console.log('   1. Use residential proxies');
            console.log('   2. Use Browserless.io or similar service');
            console.log('   3. Add more anti-detection measures');
            console.log('   4. Try running at different times');
            
            return;
        }
        
        console.log('✅ No bot detection found - proceeding with scraping');

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