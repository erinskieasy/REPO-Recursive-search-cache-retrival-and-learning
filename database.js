const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'tools.db');

function initDB() {
  const db = new Database(dbPath);

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');

  // Create tools table with JSON attributes column
  db.exec(`
    CREATE TABLE IF NOT EXISTS tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      properties TEXT -- This will store JSON data
    )
  `);

  // Create batch_results table
  db.exec(`
    CREATE TABLE IF NOT EXISTS batch_results (
      batch_id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_number INTEGER NOT NULL,
      tools_scanned INTEGER NOT NULL,
      tools_found_count INTEGER NOT NULL,
      found_tools_details TEXT, -- Storing matching tools as JSON
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed with dummy tools if empty
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM tools');
  const { count } = countStmt.get();

  if (count === 0) {
    const insertTool = db.prepare('INSERT INTO tools (name, description, properties) VALUES (?, ?, ?)');
    
    const dummyTools = [
      { name: "Google Search Tool", description: "Performs general web searches to find information on the internet.", properties: { requiresApi: true, rateLimit: 100 } },
      { name: "Calculator", description: "Evaluates mathematical expressions.", properties: { requiresApi: false } },
      { name: "Weather API", description: "Fetches current weather conditions for a given location.", properties: { requiresApi: true, provider: "OpenWeather" } },
      { name: "Wikipedia Lookup", description: "Finds summary articles from Wikipedia.", properties: { language: "en" } },
      { name: "PDF Parser", description: "Extracts text and metadata from PDF files.", properties: { formats: ["pdf"] } },
      { name: "Image Generator", description: "Generates images using AI based on a prompt.", properties: { costPerImage: 0.05 } },
      { name: "Stock Ticker", description: "Gets real-time stock prices and financial news.", properties: { requiresApi: true, delay: "15min" } },
      { name: "Flight Tracker", description: "Finds live flight statuses and gate information.", properties: { requiresApi: true } },
      { name: "Email Sender", description: "Sends emails programmatically.", properties: { protocols: ["smtp", "imap"] } },
      { name: "Translator", description: "Translates text between multiple languages.", properties: { supportedLanguages: 50 } },
      { name: "Code formatter", description: "Formats source code automatically.", properties: { languages: ["js", "py", "java"] } },
      { name: "Map Router", description: "Calculates optimal driving routes and distances.", properties: { provider: "GoogleMaps" } },
      { name: "News Scraper", description: "Scrapes latest headlines from major news outlets.", properties: { maxSources: 10 } },
      { name: "Calendar Manager", description: "Reads and writes events to a user's calendar.", properties: { platforms: ["Google", "Outlook"] } },
      { name: "Currency Converter", description: "Converts values between fiat and cryptocurrencies.", properties: { updates: "live" } }
    ];

    const insertMany = db.transaction((tools) => {
      for (const tool of tools) {
        insertTool.run(tool.name, tool.description, JSON.stringify(tool.properties));
      }
    });

    insertMany(dummyTools);
    console.log("Seeded database with dummy tools.");
  }

  // Clear batch results for a fresh start on each run (optional, but good for testing)
  // db.exec(`DELETE FROM batch_results`);
  
  return db;
}

module.exports = { initDB };
