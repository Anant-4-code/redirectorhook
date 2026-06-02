const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const {
  generateSecret,
  encryptNumber,
  isEncryptedPayload,
  normalizeEncryptedPayload,
} = require('./crypto');

/** Use `p` in URLs — Google Sheets breaks `&e=` (HTML entity / truncation → `&te=`). */
function readEncryptedFromQuery(query) {
  const raw = query.p || query.e || query.te;
  return raw ? normalizeEncryptedPayload(String(raw)) : null;
}

function readEncryptedFromBody(body) {
  const raw = body.p || body.e;
  return raw ? normalizeEncryptedPayload(String(raw)) : null;
}

const app = express();

app.use(cors());
app.use(express.json());

// Strip plain number from URL before page loads (302 → ?p=enc:v1:...)
app.get('/', (req, res, next) => {
  const { agent, number } = req.query;
  const existingEnc = readEncryptedFromQuery(req.query);
  if (agent && number && !existingEnc) {
    const record = getAgent(String(agent));
    if (record?.secret) {
      const clean = String(number).replace(/[^0-9+]/g, '');
      if (clean) {
        const enc = encryptNumber(clean, record.secret);
        const q = `agent=${encodeURIComponent(agent)}&p=${encodeURIComponent(enc)}`;
        return res.redirect(302, `/?${q}`);
      }
    }
  }
  next();
});

app.use(express.static(path.join(__dirname)));

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

function agentKey(agentId) {
  return agentId.toLowerCase();
}

/** Supports legacy string topic or { topic, secret }. */
function getAgent(agentId) {
  const entry = agents[agentKey(agentId)];
  if (!entry) return null;
  if (typeof entry === 'string') {
    return { topic: entry, secret: null };
  }
  return { topic: entry.topic, secret: entry.secret || null };
}

function saveAgent(agentId, topic, secret) {
  agents[agentKey(agentId)] = { topic, secret };
  saveAgents();
}

async function pushToNtfy(topic, encryptedMessage) {
  const response = await fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: encryptedMessage,
      title: 'Incoming Call Request',
      tags: ['phone'],
    }),
  });
  if (!response.ok) {
    throw new Error(`ntfy responded with ${response.status}`);
  }
}

loadAgents();

// ─── Agent registers ntfy topic + receives encryption secret ─────
app.post('/register', (req, res) => {
  const { agentId, ntfyTopic } = req.body;

  if (!agentId || !ntfyTopic) {
    return res.status(400).json({ error: 'agentId and ntfyTopic required' });
  }

  const existing = getAgent(agentId);
  const secret = existing?.secret || generateSecret();
  saveAgent(agentId, ntfyTopic, secret);

  console.log(`✅ Registered: ${agentId} → ${ntfyTopic}`);
  res.json({
    success: true,
    message: `Agent ${agentId} registered`,
    agentSecret: secret,
  });
});

// ─── Seal number for URL (no plain number in address bar) ──────────
app.post('/seal', (req, res) => {
  const { agentId, number } = req.body;
  if (!agentId || !number) {
    return res.status(400).json({ error: 'agentId and number required' });
  }

  const record = getAgent(agentId);
  if (!record) {
    return res.status(404).json({ error: `Agent "${agentId}" not registered` });
  }
  if (!record.secret) {
    return res.status(400).json({ error: 'Agent must re-register in CallBridge app' });
  }

  const cleanNumber = String(number).replace(/[^0-9+]/g, '');
  const e = encryptNumber(cleanNumber, record.secret);
  res.json({ e, encrypted: true });
});

// ─── Build encrypted link for Google Sheets (API key required) ───
app.post('/encrypt', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!process.env.SHEET_API_KEY || apiKey !== process.env.SHEET_API_KEY) {
    return res.status(403).json({ error: 'Invalid or missing X-API-Key' });
  }

  const { agentId, number } = req.body;
  if (!agentId || !number) {
    return res.status(400).json({ error: 'agentId and number required' });
  }

  const record = getAgent(agentId);
  if (!record) {
    return res.status(404).json({ error: `Agent "${agentId}" not registered` });
  }
  if (!record.secret) {
    return res.status(400).json({ error: 'Agent must re-register in CallBridge app' });
  }

  const cleanNumber = String(number).replace(/[^0-9+]/g, '');
  const e = encryptNumber(cleanNumber, record.secret);
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

  res.json({
    e,
    p: e,
    url: `${base}/?agent=${encodeURIComponent(agentId)}&p=${encodeURIComponent(e)}`,
  });
});

// ─── Webhook — number encrypted before ntfy; app decrypts ─────────
app.post('/call', async (req, res) => {
  const { agentId, number } = req.body;
  const encFromBody = readEncryptedFromBody(req.body);

  if (!agentId || (!number && !encFromBody)) {
    return res.status(400).json({ error: 'agentId and (number or encrypted p) required' });
  }

  const record = getAgent(agentId);
  if (!record) {
    return res.status(404).json({
      error: `Agent "${agentId}" not registered. Open the CallBridge app on their phone once to sync.`,
    });
  }

  let encryptedPayload;

  if (encFromBody) {
    if (!isEncryptedPayload(encFromBody)) {
      return res.status(400).json({ error: 'Invalid encrypted payload — use Re-register in app' });
    }
    encryptedPayload = encFromBody;
  } else {
    if (!record.secret) {
      return res.status(400).json({
        error: 'Agent must re-register in CallBridge app to enable encryption',
      });
    }
    const cleanNumber = String(number).replace(/[^0-9+]/g, '');
    encryptedPayload = encryptNumber(cleanNumber, record.secret);
  }

  try {
    await pushToNtfy(record.topic, encryptedPayload);
    console.log(`📞 Call routed (encrypted): ${agentId}`);
    res.json({ success: true, routed: true, encrypted: true });
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
    encryption: true,
    agentsFile: AGENTS_FILE,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌉 CallBridge webhook server running on port ${PORT}`);
  console.log(`   Agent registry: ${AGENTS_FILE}`);
  console.log(`   Encryption: AES-256-GCM (decrypt on device only)`);
});
