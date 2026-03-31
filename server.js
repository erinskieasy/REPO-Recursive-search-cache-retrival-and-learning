require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const { initDB } = require('./database');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let openai;
try {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} catch (e) {
  console.error("Failed to initialize OpenAI client - check API key");
}

const db = initDB();

async function primaryAgent(userPrompt) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'You are an intent extraction agent. Extract the core tool capability the user is requesting (e.g., "web search", "image generation"). Return exactly a JSON object with one key "intent" containing your extracted requirement as a string.'
      },
      { role: 'user', content: userPrompt }
    ],
    response_format: { type: 'json_object' }
  });

  const parsed = JSON.parse(response.choices[0].message.content);
  return parsed.intent;
}

async function toolSearchAgent(intent, sendEvent) {
  let offset = 0;
  const batchSize = 5;
  let totalMatches = 0;
  let allMatchedTools = [];
  let batchNumber = 1;

  while (true) {
    const batchStmt = db.prepare('SELECT id, name, description, properties FROM tools LIMIT ? OFFSET ?');
    const tools = batchStmt.all(batchSize, offset);

    if (tools.length === 0) break;

    sendEvent('log', `Searching batch ${batchNumber} (${tools.length} tools) for intent: "${intent}"...`);

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a Tool Search AI. You will be provided with an intent and a list of tools (in JSON format). Evaluate which tools in the list can satisfy the intent. Return exactly a JSON object containing a key "matchedIds", which is an array of integer IDs of the tools that match the intent.`
          },
          { role: 'user', content: JSON.stringify({ intent, tools }) }
        ],
        response_format: { type: 'json_object' }
      });

      const parsed = JSON.parse(response.choices[0].message.content);
      const matchedIds = parsed.matchedIds || [];
      const matchingToolsInBatch = tools.filter(t => matchedIds.includes(t.id));

      totalMatches += matchedIds.length;
      allMatchedTools.push(...matchingToolsInBatch);

      // Record to DB as per instructions
      const insertResult = db.prepare(`
        INSERT INTO batch_results (batch_number, tools_scanned, tools_found_count, found_tools_details)
        VALUES (?, ?, ?, ?)
      `);
      insertResult.run(batchNumber, tools.length, matchedIds.length, JSON.stringify(matchingToolsInBatch));
      
      sendEvent('log', `Batch ${batchNumber} complete: found ${matchedIds.length} capability matches.`);
      if (matchingToolsInBatch.length > 0) {
        sendEvent('match', matchingToolsInBatch);
      }
    } catch (err) {
      console.error(`Tool Search AI Error on batch ${batchNumber}:`, err);
      sendEvent('log', `Error processing batch ${batchNumber}`);
    }

    offset += batchSize;
    batchNumber++;
  }

  return { totalMatches, tools: allMatchedTools };
}

// Map of active SSE clients
const clients = new Map();

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now();
  clients.set(clientId, res);

  // Send initial event
  res.write(`data: ${JSON.stringify({ type: 'connected', id: clientId })}\n\n`);

  req.on('close', () => {
    clients.delete(clientId);
  });
});

app.post('/api/search', async (req, res) => {
  const { prompt, streamId } = req.body;
  if (!prompt || !streamId) return res.status(400).json({ error: 'Missing parameters' });

  const client = clients.get(parseInt(streamId));
  if (!client) return res.status(400).json({ error: 'Stream not found' });

  const sendEvent = (type, payload) => {
    client.write(`data: ${JSON.stringify({ type, payload })}\n\n`);
  };

  try {
    sendEvent('log', `Primary Agent received prompt: "${prompt}"`);
    const intent = await primaryAgent(prompt);
    sendEvent('log', `Primary Agent extracted intent: "${intent}"`);

    sendEvent('log', `Handing off to Tool Search AI...`);
    const result = await toolSearchAgent(intent, sendEvent);

    sendEvent('done', {
      totalMatches: result.totalMatches,
      intent
    });

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    sendEvent('error', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/tools', (req, res) => {
  try {
    const stmt = db.prepare('SELECT id, name, description, properties FROM tools ORDER BY id DESC');
    const tools = stmt.all().map(t => ({
      ...t,
      properties: JSON.parse(t.properties || '{}')
    }));
    res.json({ tools });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tools', (req, res) => {
  const { name, description, properties } = req.body;
  if (!name || !description) return res.status(400).json({ error: 'Name and description are required' });
  
  try {
    const stmt = db.prepare('INSERT INTO tools (name, description, properties) VALUES (?, ?, ?)');
    const result = stmt.run(name, description, JSON.stringify(properties || {}));
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tools/:id', (req, res) => {
  const { id } = req.params;
  const { name, description, properties } = req.body;
  if (!name || !description) return res.status(400).json({ error: 'Name and description are required' });
  
  try {
    const stmt = db.prepare('UPDATE tools SET name = ?, description = ?, properties = ? WHERE id = ?');
    const result = stmt.run(name, description, JSON.stringify(properties || {}), id);
    if (result.changes === 0) return res.status(404).json({ error: 'Tool not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tools/:id', (req, res) => {
  const { id } = req.params;
  try {
    const stmt = db.prepare('DELETE FROM tools WHERE id = ?');
    const result = stmt.run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'Tool not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
