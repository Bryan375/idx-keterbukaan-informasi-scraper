import puppeteer, {Browser, Page} from 'puppeteer';
import {GoogleGenerativeAI} from "@google/generative-ai";
import * as dotenv from 'dotenv';
import pdf from 'pdf-parse';
import Mailjet from "node-mailjet";
import * as fs from "node:fs";
import * as path from "node:path";

dotenv.config();

const TARGET_URL = 'https://www.idx.co.id/id/perusahaan-tercatat/keterbukaan-informasi/'
const NOISE_PATTERNS: string[] = [
    'Laporan Bulanan Registrasi Pemegang Efek',
    'Laporan Harian atas Nilai Aktiva Bersih',
    'Laporan Jumlah Peredaran Unit Penyertaan',
    'Laporan Jumlah Structured Warrant Beredar',
    'Laporan Kepemilikan Saham',
    'Perubahan Corporate Secretary',
    'Perubahan Internal Audit',
    'Perubahan Komite Audit',
    'Perubahan Komite Nominasi dan Remunerasi',
    'Penyampaian Bukti Iklan',
    'Penyampaian Materi Public Expose',
    'Informasi Kupon',
    'Jatuh Tempo',
    'Laporan Bulanan Aktivitas Eksplorasi'
];
const TODAY_DATE = getFormattedDate(new Date());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_APP_KEY || '');
const GEMINI_MODEL = genAI.getGenerativeModel({model: process.env.GEMINI_MODEL_NAME || 'gemini-2.5-flash-lite'});
const PROMPT_TEMPLATE = fs.readFileSync(path.resolve(__dirname, '../prompt.txt'), 'utf-8');


interface AnnouncementSentiment {
    isInteresting: boolean;
    reasoning?: string;
}

interface Announcement {
    time: string;
    title: string;
    attachments: { text: string; url: string }[];
    sentiment: AnnouncementSentiment;
}


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

        const data = await pdf(buffer);
        const documentText = data.text;

        let result;

        if (documentText.trim().length < 100) {
            console.log('📝 PDF appears to be a scanned image. Switching to multimodal analysis.');
            const imagePart = {
                inlineData: {
                    data: buffer.toString('base64'),
                    mimeType: 'application/pdf'
                }
            };
            result = await GEMINI_MODEL.generateContent([PROMPT_TEMPLATE, imagePart]);
        } else {
            const prompt = `${PROMPT_TEMPLATE}\n\nDocument Text:\n--- \n${documentText.substring(0, 10000)} \n--- `;
            result = await GEMINI_MODEL.generateContent(prompt);
        }

        const responseText = result.response.text();

        const jsonRegex = /^```json\s*|\s*```$/g;
        const jsonString = responseText.replaceAll(jsonRegex, '');

        const jsonResponse = JSON.parse(jsonString);
        console.log('Result:', JSON.stringify(jsonResponse, null, 2));

        return {
            isInteresting: jsonResponse.isInteresting || false,
            reasoning: jsonResponse.reasoning || 'No reasoning provided.'
        };


    } catch (error) {
        console.error(`❌ Failed to analyze document ${title}-number(${attachmentNumber}) with this url: ${url}`, error);
        return {isInteresting: false, reasoning: 'Analysis failed.'};
    }
}


export function getFormattedDate(date: Date): string {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = (date.getDate()).toString().padStart(2, '0');

    return `${year}-${month}-${day}`;
}

export async function clickDateInputField(page: Page): Promise<boolean> {
    const dateInput = await page.$('input[name="date"]');

    if (!dateInput) return false;

    await dateInput.click();

    console.log(`▶️  Scraping announcements for date: ${TODAY_DATE}`);

    await page.keyboard.type(`${TODAY_DATE} ~ ${TODAY_DATE}`);
    await page.keyboard.press('Enter');

    return true;
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

function formatAnnouncementForEmail(announcements: Announcement[]): string {
    if (announcements.length === 0) return '<li>None</li>';
    return announcements.map(ann => `
            <li>
                <b>${ann.title}</b><br/>
                <i>Reasoning: ${ann.sentiment.reasoning}</i><br/>
                <a href="${ann.attachments.find(a => a.text.toLowerCase().includes('.pdf'))?.url || '#'}">Link to PDF</a>
            </li>
        `).join('');
}

async function sendEmailReport(
    interestingAnnouncements: Announcement[],
    uninterestingAnnouncements: Announcement[],
    skippedAnnouncements: Announcement[],
    failedAnnouncements: Announcement[],

): Promise<void> {
    const { MAILJET_API_KEY, MAILJET_API_SECRET, SENDER_EMAIL, RECEIVER_EMAIL } = process.env;

    if (!MAILJET_API_KEY || !MAILJET_API_SECRET || !SENDER_EMAIL || !RECEIVER_EMAIL) {
        console.error('Email credentials (MAILJET_API_KEY, MAILJET_API_SECRET, SENDER_EMAIL, RECEIVER_EMAIL) are not set. Skipping email report.');
    }

    const mailJet = new Mailjet({
        apiKey: MAILJET_API_KEY,
        apiSecret: MAILJET_API_SECRET,
    });

    const htmlContent = `
        <h1>IDX Scraper Report - ${new Date().toLocaleDateString('id-ID')}</h1>
        
        <h2>✨ ${interestingAnnouncements.length} Interesting Announcements</h2>
        <ul>${formatAnnouncementForEmail(interestingAnnouncements)}</ul>
        
        <h2>🧐 ${uninterestingAnnouncements.length} Uninteresting Announcements (Analyzed)</h2>
        <ul>${formatAnnouncementForEmail(uninterestingAnnouncements)}</ul>
        
        <h2>🔇 ${skippedAnnouncements.length} Skipped Announcements (Filtered)</h2>
        <ul>${formatAnnouncementForEmail(skippedAnnouncements)}</ul>
        
        <h2>❌ ${failedAnnouncements.length} Failed Announcements</h2>
        <ul>${formatAnnouncementForEmail(failedAnnouncements)}</ul>
    `;

    const request = mailJet
        .post('send', { version: 'v3.1'})
        .request({
            Messages: [
                {
                    From: {
                        Email: SENDER_EMAIL,
                        Name: "Ayang"
                    },
                    To: [
                        {
                            Email: RECEIVER_EMAIL,
                        },
                    ],
                    Subject: `IDX Scraper Report: ${interestingAnnouncements.length} interesting announcements found!`,
                    HTMLPart: htmlContent,
                },
            ],
        });

    request.then(() => {
        console.log('✅ Email report sent successfully via Mailjet!');
    }).catch((error) => {
        console.error('❌ Failed to send email report via Mailjet:', error);
    });
}


export async function scrapeAnnouncements() {
    if (!process.env.GEMINI_APP_KEY) {
        console.error('❌ GEMINI_APP_KEY is not set');
        return;
    }

    console.log('🚀 Memulai browser...');
    const browser: Browser = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page: Page = await browser.newPage();

    try {
        await page.goto(TARGET_URL, {waitUntil: 'networkidle2'});

        const successClickedDate = await clickDateInputField(page);

        if (!successClickedDate) {
            console.error('❌ Gagal mengekstrak informasi dari halaman');
            return;
        }

        const allAnnouncements: Omit<Announcement, 'sentiment'>[] = [];

        await page.waitForNetworkIdle({idleTime: 1000});

        do {
            const currentPageData = await scrapeCurrentPage(page);

            allAnnouncements.push(...currentPageData);

            if (await hasNextPage(page)) {
                await goToNextPage(page);

                await page.waitForNetworkIdle({idleTime: 1000});

            } else {
                break;
            }
        } while (true);

        const noiseRegex = new RegExp(NOISE_PATTERNS.join('|'), 'i');
        const analyzedAnnouncements: Announcement[] = [];
        console.log(`Total of announcements: ${allAnnouncements.length}`)

        for (const ann of allAnnouncements) {
            if (noiseRegex.test(ann.title)) {
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

        const interestingAnnouncements = analyzedAnnouncements.filter(ann => ann.sentiment.isInteresting);
        const skippedAnnouncements = analyzedAnnouncements.filter(ann => ann.sentiment.reasoning === 'Filtered out by title noise pattern.');
        const failedAnnouncements = analyzedAnnouncements.filter(ann => ann.sentiment.reasoning === 'Analysis failed.');
        const uninterestingAnalyzedAnnouncements = analyzedAnnouncements.filter(ann => (!ann.sentiment.isInteresting && ann.sentiment.reasoning !== 'Analysis failed.') || (!ann.sentiment.isInteresting && ann.sentiment.reasoning !== 'Filtered out by title noise pattern.'));

        console.log(`
                ========================================
                            SCRAPING COMPLETE
                ========================================
        `);

        console.log(`✨ Ditemukan ${interestingAnnouncements.length} pengumuman menarik berdasarkan analisis AI:`);
        for (const ann of interestingAnnouncements) {
            console.log(`- 📢 Judul: ${ann.title}`);
            console.log(`  - 🤔 Alasan: ${ann.sentiment.reasoning}`);
            console.log(`  - 🔗 Link: ${ann.attachments.find(a => a.text.toLowerCase().includes('.pdf'))?.url || 'N/A'}\n`);
        }

        console.log(`\n---`);
        console.log(`
🧐 Ditemukan ${uninterestingAnalyzedAnnouncements.length} pengumuman yang dinilai tidak menarik oleh AI:`);
        for (const ann of uninterestingAnalyzedAnnouncements) {
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

        await sendEmailReport(
            interestingAnnouncements,
            uninterestingAnalyzedAnnouncements,
            skippedAnnouncements,
            failedAnnouncements,
        )


    } catch (error) {
        console.error('❌ Terjadi kesalahan:', error);
    } finally {
        await browser.close()
    }

}

scrapeAnnouncements()

