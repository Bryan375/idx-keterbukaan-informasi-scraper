import Mailjet from 'node-mailjet';
import { Announcement } from '../types/announcement';
import * as dotenv from "dotenv";

dotenv.config();

function formatAnnouncementsForEmail(announcements: Announcement[], includeReasoning = false): string {
    if (announcements.length === 0) return '<li>None</li>';
    return announcements.map(ann => `
            <li>
                <b>${ann.title}</b><br/>
                ${includeReasoning ? `<i>Reasoning: ${ann.sentiment.reasoning}</i><br/>` : ''}
                <a href="${ann.attachments.find(a => a.text.toLowerCase().includes('.pdf'))?.url || '#'}">Link to PDF</a>
            </li>
        `).join('');
}

export async function sendEmailReport(
    interestingAnnouncements: Announcement[],
    uninterestingAnnouncements: Announcement[],
    skippedAnnouncements: Announcement[],
    failedAnnouncements: Announcement[],
): Promise<void> {
    const { MAILJET_API_KEY, MAILJET_API_SECRET, SENDER_EMAIL, RECEIVER_EMAIL } = process.env;

    if (!MAILJET_API_KEY || !MAILJET_API_SECRET || !SENDER_EMAIL || !RECEIVER_EMAIL) {
        console.error('Email credentials are not fully set. Skipping email report.');
        return;
    }

    const mailjet = new Mailjet({ apiKey: MAILJET_API_KEY, apiSecret: MAILJET_API_SECRET });

    const htmlContent = `
        <h1>IDX Scraper Report - ${new Date().toLocaleDateString('en-CA')}</h1>
        <h2>✨ ${interestingAnnouncements.length} Interesting Announcements</h2>
        <ul>${formatAnnouncementsForEmail(interestingAnnouncements, true)}</ul>
        <h2>🧐 ${uninterestingAnnouncements.length} Uninteresting Announcements</h2>
        <ul>${formatAnnouncementsForEmail(uninterestingAnnouncements, true)}</ul>
        <h2>🔇 ${skippedAnnouncements.length} Skipped Announcements</h2>
        <ul>${formatAnnouncementsForEmail(skippedAnnouncements)}</ul>
        <h2>❌ ${failedAnnouncements.length} Failed Announcements</h2>
        <ul>${formatAnnouncementsForEmail(failedAnnouncements)}</ul>
    `;

    try {
        await mailjet.post('send', { version: 'v3.1' }).request({
            Messages: [{
                From: { Email: SENDER_EMAIL, Name: "IDX Scraper Report" },
                To: [{ Email: RECEIVER_EMAIL }],
                Subject: `IDX Scraper Report: ${interestingAnnouncements.length} interesting announcements found!`,
                HTMLPart: htmlContent
            }]
        });
        console.log('\n\n✅ Email report sent successfully via Mailjet!');
    } catch (error) {
        console.error('\n\n❌ Failed to send email report via Mailjet:', error);
    }
}
