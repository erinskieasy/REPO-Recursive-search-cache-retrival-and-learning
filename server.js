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

const Orchestrator = require('./orchestrator');

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

app.post('/api/orchestrate', async (req, res) => {
  const { prompt, streamId, resumeMainIndex, resumeAuditionIndex, resumeIntent, objective } = req.body;
  
  const client = clients.get(parseInt(streamId));
  const sendEvent = client ? (type, payload) => client.write(`data: ${JSON.stringify({ type, payload })}\n\n`) : () => {};

  try {
    const orchestrator = new Orchestrator(db, openai, sendEvent);
    sendEvent('log', `Orchestrator received objective: "${prompt || objective}"`);
    
    let cacheState;
    let actualObjective = prompt || objective;

    if (resumeIntent && resumeIntent !== "") {
       // Resuming search loop
       cacheState = db.prepare('SELECT * FROM intent_cache WHERE intent = ?').get(resumeIntent);
       if (cacheState) {
         cacheState.main_list = JSON.parse(cacheState.main_list || '[]');
         cacheState.audition_queue = JSON.parse(cacheState.audition_queue || '[]');
       }
    } else {
       cacheState = await orchestrator.getMatchedIntentCache(prompt);
       cacheState = await orchestrator.applyActivityLog(cacheState);
    }
    
    if (!cacheState) {
      throw new Error("Could not initialize or find cache state.");
    }

    const result = await orchestrator.buildAndEvaluateBatches(
      actualObjective, 
      cacheState, 
      resumeMainIndex || 0, 
      resumeAuditionIndex || 0
    );

    if (result.exhausted) {
       sendEvent('exhausted', { objective: actualObjective, intent: cacheState.intent });
    } else {
       sendEvent('selection', {
         objective: result.objective,
         intent: result.intent,
         batchIds: result.batchIds,
         batchTools: result.batchTools,
         selectedToolId: result.selectedToolId,
         nextMainIndex: result.nextMainIndex,
         nextAuditionIndex: result.nextAuditionIndex
       });
    }

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    sendEvent('error', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/feedback', (req, res) => {
  const { intent, objective, batchIds, selectedToolId, isBestMatch } = req.body;
  if (!intent || !objective || !batchIds || selectedToolId === undefined) {
     return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    const orchestrator = new Orchestrator(db, openai, () => {});
    orchestrator.applyFeedback(intent, objective, batchIds, selectedToolId, isBestMatch);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
