import {hasNextPage} from "../scraper";
import {getFormattedDate} from "../helpers/date.helper";

describe('getTodayDate', () => {
    it('should return today date in YYYY-MM-DD format', () => {
        const testDate = new Date('2025-09-20')

        const result = getFormattedDate(testDate);

        expect(result).toBe('2025-09-18')
    });
});

describe('hasNextPage', () => {
    it('should return true when the next page button exists and is enabled', async () => {
        const mockPage = {
            $: jest.fn().mockResolvedValue({}),
        } as any;

        const result = await hasNextPage(mockPage);

        expect(result).toBe(true);
    });
})