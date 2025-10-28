import { GoogleGenerativeAI } from "@google/generative-ai";
import pdf from 'pdf-parse';
import { AnnouncementSentiment } from "../types/announcement";
import * as dotenv from "dotenv";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_APP_KEY || '');
const GEMINI_MODEL = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL_NAME || 'gemini-1.5-flash-latest' });
const PROMPT_TEMPLATE = `
Analyze the following corporate announcement from the Indonesia Stock Exchange (IDX).
Determine if it describes a significant, actionable event for an investor. Focus on identifying events like:
- Rights Issue (PMHMETD)
- Private Placement (PMTHMETD)
- Acquisition or Merger
- Stock Split
- Share Buyback
- Significant change in ownership (Perubahan Kepemilikan Saham)
- Potential Backdoor Listing
- Joint Venture

Based on the text, answer with a JSON object in the following format and nothing else:
"{ "isInteresting": boolean, "reasoning": "Explain why this is or is not an interesting event for an investor." }"

Please provide the response in a valid JSON format like this
"{ "isInteresting": boolean, "reasoning": "Explain why this is or is not an interesting event for an investor." }"

If got error, please provide the error message in Indonesian in this format
"{ "isInteresting": false, "reasoning": "Error: {{error message}}" }"

For all reasoning, please provide the reasoning in Indonesian.
`

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