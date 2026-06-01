const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Persist agents to disk (survives restarts if Railway volume or local file exists)
const AGENTS_FILE = process.env.AGENTS_FILE
  || path.join(process.env.DATA_DIR || __dirname, 'agents.json');

let agents = {};

function loadAgents() {
  try {
    if (fs.existsSync(AGENTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
      agents = typeof data === 'object' && data !== null ? data : {};
      console.log(`Loaded ${Object.keys(agents).length} agent(s) from ${AGENTS_FILE}`);
    }
  } catch (err) {
    console.error('Failed to load agents:', err.message);
    agents = {};
  }
}

function saveAgents() {
  try {
    const dir = path.dirname(AGENTS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));
  } catch (err) {
    console.error('Failed to save agents:', err.message);
  }
}

loadAgents();

// ─── ROUTE 1: Agent registers their ntfy topic (one-time setup) ──
app.post('/register', (req, res) => {
  const { agentId, ntfyTopic } = req.body;

  if (!agentId || !ntfyTopic) {
    return res.status(400).json({ error: 'agentId and ntfyTopic required' });
  }

  agents[agentId.toLowerCase()] = ntfyTopic;
  saveAgents();
  console.log(`✅ Registered: ${agentId} → ${ntfyTopic}`);
  res.json({ success: true, message: `Agent ${agentId} registered` });
});

// ─── ROUTE 2: Webhook — called by the redirector HTML page ───────
app.post('/call', async (req, res) => {
  const { agentId, number } = req.body;

  if (!agentId || !number) {
    return res.status(400).json({ error: 'agentId and number required' });
  }

  const topic = agents[agentId.toLowerCase()];
  if (!topic) {
    return res.status(404).json({
      error: `Agent "${agentId}" not registered. Open the CallBridge app on their phone once to sync.`,
    });
  }

  const cleanNumber = number.replace(/[^0-9+]/g, '');

  try {
    const response = await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: cleanNumber,
        title: 'Incoming Call Request',
        tags: ['phone'],
      }),
    });

    if (!response.ok) {
      throw new Error(`ntfy responded with ${response.status}`);
    }

    console.log(`📞 Call routed: ${agentId} → ${cleanNumber}`);
    res.json({ success: true, routed: true, number: cleanNumber });
  } catch (err) {
    console.error('ntfy push failed:', err.message);
    res.status(500).json({ error: 'Failed to send push notification', detail: err.message });
  }
});

app.get('/agents', (req, res) => {
  res.json({ agents: Object.keys(agents), count: Object.keys(agents).length });
});

app.get('/api', (req, res) => {
  res.json({
    status: 'CallBridge running',
    agents: Object.keys(agents).length,
    agentsFile: AGENTS_FILE,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌉 CallBridge webhook server running on port ${PORT}`);
  console.log(`   Agent registry: ${AGENTS_FILE}`);
});
