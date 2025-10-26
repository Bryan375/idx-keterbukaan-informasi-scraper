# IDX Keterbukaan Informasi Scraper

This project is a Node.js application designed to scrape the "Keterbukaan Informasi" (Information Disclosure) section of the Indonesia Stock Exchange (IDX) website. It uses Puppeteer to control a headless browser, analyzes the content of PDF announcements with the Google Gemini API to identify potentially significant corporate actions, and sends a summary report via email using Mailjet.

## Features

- **Automated Scraping**: Uses Puppeteer to navigate the IDX website and retrieve daily announcements.
- **AI-Powered Analysis**: Leverages the Google Gemini API to analyze PDF documents and determine if they contain interesting financial events.
- **Email Reporting**: Sends a formatted HTML email report summarizing interesting, uninteresting, and skipped announcements.
- **Configurable**: Noise patterns and other constants can be configured in `src/config/constants.ts`.
- **Dockerized**: Includes a `Dockerfile` and `docker-compose.yml` for a consistent and isolated runtime environment.

---

## Prerequisites

Before you begin, ensure you have the following installed:

- [Node.js](https://nodejs.org/en/) (v18 or later)
- [npm](https://www.npmjs.com/)
- [Docker](https://www.docker.com/products/docker-desktop/) and [Docker Compose](https://docs.docker.com/compose/) (for the Docker-based workflow)

---

## Setup

1.  **Clone the repository**:
    ```bash
    git clone <your-repository-url>
    cd idx-scrapper
    ```

2.  **Install dependencies**:
    ```bash
    npm install
    ```

3.  **Set up environment variables**:
    Create a `.env` file in the root of the project by copying the example:
    ```bash
    cp .env.example .env
    ```
    Now, open the `.env` file and fill in your actual API keys and sender email:
    ```env
    # Gemini API Key for AI analysis
    GEMINI_APP_KEY=your_gemini_api_key

    # Mailjet API Keys for sending email reports
    MAILJET_API_KEY=your_mailjet_api_key
    MAILJET_API_SECRET=your_mailjet_api_secret

    # Email configuration
    SENDER_EMAIL="your-name@example.com"
    ```

---

## Running the Application

This project provides two methods for running the server: directly on your local machine or inside a Docker container.

### Method 1: Direct Local Run (Simplest)

This method runs the Node.js server directly on your macOS.

1.  **Build the TypeScript code**:
    ```bash
    npm run build
    ```

2.  **Start the server**:
    ```bash
    npm start
    ```
    The server will start on `http://localhost:3000` (or the port defined in `src/server.ts`).

3.  **Trigger the scraper**:
    Open a new terminal and send a request to the `/scrape` endpoint:
    ```bash
    curl http://localhost:3000/scrape
    ```

### Method 2: Docker-Based Run (Recommended for Consistency)

This method uses Docker and Docker Compose to run the application in an isolated and consistent environment.

1.  **Build and start the container**:
    The `--build` flag ensures the Docker image is rebuilt with your latest code changes.
    ```bash
    docker-compose up --build
    ```
    The server will start on `http://localhost:8080` (as defined in `docker-compose.yml`).

2.  **Trigger the scraper**:
    Open a new terminal and send a request to the `/scrape` endpoint:
    ```bash
    curl http://localhost:8080/scrape
    ```

3.  **View logs**:
    To see the live output from the scraper, open another terminal and run:
    ```bash
    docker-compose logs -f
    ```

4.  **Stopping the container**:
    Press `Ctrl+C` in the terminal where `docker-compose up` is running, or run the following command from another terminal:
    ```bash
    docker-compose down
    ```