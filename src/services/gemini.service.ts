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

export async function extractPdfText(buffer: Buffer): Promise<{ text: string; isScanned: boolean }> {
    try {
        const data = await pdf(buffer);
        const documentText = data.text;

        if (documentText.trim().length < 100) {
            return {text: '', isScanned: true};
        }

        return {text: documentText, isScanned: false};
    } catch (error) {
        console.error('   ❌ [Error] Failed to extract text from PDF:', error);
        return {text: '', isScanned: false};
    }
}

export async function analyzeCombinedContent(
    combinedText: string,
    scannedPdfBuffers: Buffer[],
    title: string
): Promise<AnnouncementSentiment> {
    const maxRetries = 5;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let result;

            if (scannedPdfBuffers.length > 0) {
                console.log(`      📸 Analyzing ${scannedPdfBuffers.length} scanned PDF(s) with multimodal approach`);

                const parts: any[] = [];

                if (combinedText.trim().length > 0) {
                    parts.push(`${PROMPT_TEMPLATE}\n\nJudul: ${title}\n\nKonten Teks:\n${combinedText.substring(0, 10000)}\n\nBerikut adalah PDF yang di-scan:`);
                } else {
                    parts.push(`${PROMPT_TEMPLATE}\n\nJudul: ${title}\n\nBerikut adalah PDF yang di-scan:`);
                }

                for (const element of scannedPdfBuffers) {
                    parts.push({
                        inlineData: {
                            data: element.toString('base64'),
                            mimeType: 'application/pdf'
                        }
                    });
                }

                result = await GEMINI_MODEL.generateContent(parts);
            }
            else if (combinedText.trim().length > 0) {
                console.log(`      📝 Analyzing combined text (${combinedText.length} characters)`);
                const prompt = `${PROMPT_TEMPLATE}\n\nJudul: ${title}\n\nKonten:\n${combinedText.substring(0, 20000)}`;
                result = await GEMINI_MODEL.generateContent(prompt);
            }
            else {
                return { isInteresting: false, reasoning: 'Tidak ada konten untuk dianalisis.' };
            }

            const responseText = result.response.text();
            const jsonRegex = /(^```json\s*|```$)/g;
            const jsonString = responseText.replaceAll(jsonRegex, '');
            const jsonResponse = JSON.parse(jsonString);

            return {
                isInteresting: jsonResponse.isInteresting || false,
                reasoning: jsonResponse.reasoning || 'Tidak ada alasan yang diberikan.'
            };

        } catch (error: any) {

            const isRateLimitError = error?.status === 503 || error?.status === 429;

            if (isRateLimitError && attempt < maxRetries) {
                const waitTime = Math.pow(3, attempt) * 2500;
                console.log(`      ⏳ Rate limit hit (${error.status}). Retrying in ${waitTime/1000}s... (Attempt ${attempt}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }

            console.error('   ❌ [Error] Failed to analyze combined content with Gemini:', error);
            break;
        }
    }

    return { isInteresting: false, reasoning: 'Analisis gagal karena error setelah beberapa percobaan.' };
}