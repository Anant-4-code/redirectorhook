const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Node 18+ has global fetch. In some hosts/buildpacks Node may be older.
// Fallback to node-fetch (lazy import) so /call failures are actionable.
const fetchFn =
  typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const {
  deriveAgentSecret,
  encryptNumber,
  isEncryptedPayload,
  normalizeEncryptedPayload,
} = require('./crypto');
const { parsePhoneList, normalizeIndianPhone } = require('./phone-utils');
const { checkCallLimit, limitConfig } = require('./call-limits');

const NTFY_BASE_URL = (process.env.NTFY_BASE_URL || 'https://ntfy.sh').trim().replace(/\/$/, '');
const NTFY_PUSH_RETRIES = Math.min(5, Math.max(1, parseInt(process.env.NTFY_PUSH_RETRIES || '3', 10) || 3));
const NTFY_PUSH_TIMEOUT_MS = parseInt(process.env.NTFY_PUSH_TIMEOUT_MS || '15000', 10) || 15000;

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
      const candidates = parsePhoneList(String(number));
      if (candidates.length === 1) {
        const enc = encryptNumber(candidates[0], record.secret);
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

/** Supports legacy string topic or { topic }. Secret is always derived from agent name. */
function getAgent(agentId) {
  const entry = agents[agentKey(agentId)];
  if (!entry) return null;
  const topic = typeof entry === 'string' ? entry : entry.topic;
  if (!topic) return null;
  return { topic, secret: deriveAgentSecret(agentId) };
}

function saveAgent(agentId, topic) {
  agents[agentKey(agentId)] = { topic };
  saveAgents();
}

function ntfyPublishUrl(topic) {
  return `${NTFY_BASE_URL}/${encodeURIComponent(topic)}`;
}

function isNtfyQuotaError(status, bodyText) {
  return status === 429 && /quota|limit reached/i.test(bodyText || '');
}

async function pushToNtfy(topic, messageBody) {
  let lastErr = null;

  for (let attempt = 1; attempt <= NTFY_PUSH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NTFY_PUSH_TIMEOUT_MS);

    try {
      const response = await fetchFn(ntfyPublishUrl(topic), {
        method: 'POST',
        headers: {
          Title: 'Incoming Call',
          Tags: 'phone',
          Priority: 'high',
        },
        body: messageBody,
        signal: controller.signal,
      });

      if (response.ok) {
        console.log(`   ntfy OK → ${NTFY_BASE_URL} topic ${topic}`);
        return;
      }

      const text = await response.text().catch(() => '');
      const err = new Error(`ntfy responded with ${response.status}: ${text}`);
      err.status = response.status;
      err.quota = isNtfyQuotaError(response.status, text);

      if (err.quota || response.status === 429) {
        throw err;
      }

      lastErr = err;
      if (attempt < NTFY_PUSH_RETRIES && response.status >= 500) {
        await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }
      throw err;
    } catch (e) {
      if (e.quota) throw e;
      if (e.name === 'AbortError') {
        lastErr = new Error(`ntfy request timed out after ${NTFY_PUSH_TIMEOUT_MS}ms`);
      } else {
        lastErr = e;
      }
      if (attempt < NTFY_PUSH_RETRIES) {
        await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr || new Error('ntfy push failed');
}

loadAgents();

// ─── Agent registers ntfy topic + receives encryption secret ─────
app.post('/register', (req, res) => {
  const { agentId, ntfyTopic } = req.body;

  if (!agentId || !ntfyTopic) {
    return res.status(400).json({ error: 'agentId and ntfyTopic required' });
  }

  saveAgent(agentId, ntfyTopic);
  const secret = deriveAgentSecret(agentId);

  console.log(`✅ Registered: ${agentId} → ${ntfyTopic}`);
  res.json({
    success: true,
    message: `Agent ${agentId} registered`,
    agentSecret: secret,
    topic: ntfyTopic,
    ntfyBaseUrl: NTFY_BASE_URL,
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
  const cleanNumber = normalizeIndianPhone(number);
  if (!cleanNumber) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }
  const e = encryptNumber(cleanNumber, deriveAgentSecret(agentId));
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
  const cleanNumber = normalizeIndianPhone(number);
  if (!cleanNumber) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }
  const e = encryptNumber(cleanNumber, deriveAgentSecret(agentId));
  const base = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;

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
    const cleanNumber = normalizeIndianPhone(number);
    if (!cleanNumber) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    encryptedPayload = encryptNumber(cleanNumber, deriveAgentSecret(agentId));
  }

  const limited = checkCallLimit();
  if (limited) {
    return res.status(limited.status).json({
      error: limited.error,
      detail: limited.detail,
    });
  }

  try {
    await pushToNtfy(record.topic, encryptedPayload);
    console.log(`📞 Call routed (encrypted): ${agentId}`);
    res.json({ success: true, routed: true, encrypted: true });
  } catch (err) {
    console.error('ntfy push failed:', err.message);

    if (err.quota) {
      return res.status(503).json({
        error: 'Push service daily limit reached (ntfy.sh free tier)',
        detail: err.message,
        fix:
          'Set NTFY_BASE_URL to your own ntfy server (see docker-compose.ntfy.yml). '
          + 'Self-hosted ntfy has no 250/day cap. Target capacity: 20 calls/sec, 25000/day.',
        ntfyBaseUrl: NTFY_BASE_URL,
      });
    }

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
    ntfyBaseUrl: NTFY_BASE_URL,
    callLimits: limitConfig(),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌉 CallBridge webhook server running on port ${PORT}`);
  console.log(`   Agent registry: ${AGENTS_FILE}`);
  console.log(`   ntfy publish: ${NTFY_BASE_URL}`);
  console.log(`   Encryption: AES-256-GCM (decrypt on device only)`);
  const limits = limitConfig();
  if (limits.enabled) {
    console.log(`   Call limits: ${limits.maxPerSecond}/sec, ${limits.maxPerDay}/day`);
  } else {
    console.log('   Call limits: off (use self-hosted ntfy for production volume)');
  }
});
