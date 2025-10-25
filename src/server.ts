import express from "express";
import { idxScraperEndpoint } from "./scraper";

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/scrape', idxScraperEndpoint);

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
