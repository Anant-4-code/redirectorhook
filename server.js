const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── In-memory agent registry (no database needed) ───────────────
// Format: { "rahul": "callbridge-rahul-x7k2", "priya": "callbridge-priya-a3m9" }
// Agent registers their ntfy topic once when they install the app.
const agents = {};

// ─── ROUTE 1: Agent registers their ntfy topic (one-time setup) ──
// Called from the Android app on first launch
app.post('/register', (req, res) => {
  const { agentId, ntfyTopic } = req.body;

  if (!agentId || !ntfyTopic) {
    return res.status(400).json({ error: 'agentId and ntfyTopic required' });
  }

  agents[agentId.toLowerCase()] = ntfyTopic;
  console.log(`✅ Registered: ${agentId} → ${ntfyTopic}`);
  res.json({ success: true, message: `Agent ${agentId} registered` });
});

// ─── ROUTE 2: Webhook — called by the redirector HTML page ───────
// Your phonelink page adds this POST call before/instead of tel:
app.post('/call', async (req, res) => {
  const { agentId, number } = req.body;

  if (!agentId || !number) {
    return res.status(400).json({ error: 'agentId and number required' });
  }

  const topic = agents[agentId.toLowerCase()];
  if (!topic) {
    return res.status(404).json({ error: `Agent "${agentId}" not registered. Ask them to open the CallBridge app.` });
  }

  // Clean the number — digits and + only
  const cleanNumber = number.replace(/[^0-9+]/g, '');

  try {
    // ntfy expects the payload in its "message" field (or plain text body).
    // Custom keys like { number, agent } are NOT forwarded as the message text.
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

// ─── ROUTE 3: View all registered agents (admin use) ─────────────
app.get('/agents', (req, res) => {
  res.json({ agents: Object.keys(agents), count: Object.keys(agents).length });
});

// ─── Health check ─────────────────────────────────────────────────
app.get('/api', (req, res) => {
  res.json({ status: 'CallBridge running', agents: Object.keys(agents).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌉 CallBridge webhook server running on port ${PORT}`);
});
