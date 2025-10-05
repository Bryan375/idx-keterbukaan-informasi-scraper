import { GoogleGenerativeAI } from "@google/generative-ai";
import pdf from 'pdf-parse';
import * as fs from "node:fs";
import * as path from "node:path";
import { AnnouncementSentiment } from "../types/announcement";
import * as dotenv from "dotenv";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_APP_KEY || '');
const GEMINI_MODEL = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL_NAME || 'gemini-1.5-flash-latest' });
const PROMPT_TEMPLATE = fs.readFileSync(path.resolve(__dirname, '../prompt.txt'), 'utf-8');

export async function analyzePdfBuffer(buffer: Buffer): Promise<AnnouncementSentiment> {
    try {
        const data = await pdf(buffer);
        const documentText = data.text;

        let result;

        if (documentText.trim().length < 100) {
            console.log('      📝 PDF appears to be a scanned image. Switching to multimodal analysis.');
            const imagePart = {
                inlineData: {
                    data: buffer.toString('base64'),
                    mimeType: 'application/pdf'
                }
            };
            const promptForImage = PROMPT_TEMPLATE.replace('{{documentText}}', 'The document text is contained in the attached PDF image.');
            result = await GEMINI_MODEL.generateContent([promptForImage, imagePart]);
        } else {
            const prompt = PROMPT_TEMPLATE.replace('{{documentText}}', documentText.substring(0, 10000));
            result = await GEMINI_MODEL.generateContent(prompt);
        }

        const responseText = result.response.text();
        const jsonRegex = /^```json\s*|\s*```$/g;
        const jsonString = responseText.replace(jsonRegex, '');
        const jsonResponse = JSON.parse(jsonString);

        return {
            isInteresting: jsonResponse.isInteresting || false,
            reasoning: jsonResponse.reasoning || 'No reasoning provided.'
        };

    } catch (error) {
        console.error('   ❌ [Error] Failed to analyze document with Gemini:', error);
        return { isInteresting: false, reasoning: 'Analysis failed due to an error.' };
    }
}