const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

const express = require('express');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const CONFIG_FILE = path.join(__dirname, 'acquisti-config.json');

app.use(express.json());
app.use(express.static(__dirname));

// ---- CONFIG ----
// Variabili d'ambiente hanno priorità (usate su Render)
// Fallback al file locale per sviluppo
function loadConfig() {
  if (process.env.MONGODB_URI) {
    return {
      connectionString: process.env.MONGODB_URI,
      database: process.env.MONGODB_DATABASE || 'acquisti_categorizzati',
      collection: process.env.MONGODB_COLLECTION || 'dati',
    };
  }
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { connectionString: null, database: 'acquisti_categorizzati', collection: 'dati' }; }
}

function saveConfig(cfg) {
  // Non scrivere su file se la config viene da variabili d'ambiente
  if (process.env.MONGODB_URI) return;
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch {}
}

let config = loadConfig();
let client = null;

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function getDb() {
  if (!config.connectionString) throw new Error('MongoDB non configurato');
  if (!client || !client.topology?.isConnected()) {
    client = new MongoClient(config.connectionString, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
  }
  return client.db(config.database);
}

async function getDataCollection() {
  return (await getDb()).collection(config.collection);
}

async function getUsersCollection() {
  return (await getDb()).collection('users');
}

// ---- STATUS ----
app.get('/api/status', async (req, res) => {
  if (!config.connectionString) return res.json({ connected: false, configured: false });
  try {
    await getDb();
    res.json({ connected: true, configured: true, database: config.database, collection: config.collection });
  } catch (e) {
    client = null;
    res.json({ connected: false, configured: true, error: e.message });
  }
});

// ---- CONNECT ----
app.post('/api/connect', async (req, res) => {
  const { connectionString, database, collection } = req.body;
  if (!connectionString) return res.status(400).json({ error: 'Connection string mancante' });

  let testClient;
  try {
    testClient = new MongoClient(connectionString, { serverSelectionTimeoutMS: 6000 });
    await testClient.connect();
    await testClient.db(database || 'acquisti_categorizzati').command({ ping: 1 });
    await testClient.close();
  } catch (e) {
    try { await testClient?.close(); } catch {}
    return res.status(400).json({ error: `Connessione fallita: ${e.message}` });
  }

  if (client) { try { await client.close(); } catch {} client = null; }

  config = {
    connectionString,
    database: database || 'acquisti_categorizzati',
    collection: collection || 'dati',
  };
  saveConfig(config);
  res.json({ ok: true });
});

// ---- AUTH ----
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username e password richiesti' });
  try {
    const users = await getUsersCollection();
    const user = await users.findOne({ username, password });
    if (!user) return res.status(401).json({ error: 'Utente o password non validi' });
    res.json({ id: user._id, username: user.username });
  } catch (e) {
    client = null;
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username e password richiesti' });
  try {
    const users = await getUsersCollection();
    const exists = await users.findOne({ username });
    if (exists) return res.status(400).json({ error: 'Username già in uso' });
    const id = uid();
    await users.insertOne({ _id: id, username, password });
    res.json({ id, username });
  } catch (e) {
    client = null;
    res.status(500).json({ error: e.message });
  }
});

// Lista utenti (per admin nelle impostazioni)
app.get('/api/users', async (req, res) => {
  try {
    const users = await getUsersCollection();
    const list = await users.find({}, { projection: { password: 0 } }).toArray();
    res.json(list);
  } catch (e) {
    client = null;
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const users = await getUsersCollection();
    await users.deleteOne({ _id: req.params.id });
    const col = await getDataCollection();
    await col.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    client = null;
    res.status(500).json({ error: e.message });
  }
});

// ---- SETTINGS (theme, per utente) ----
app.get('/api/settings/:userId', async (req, res) => {
  try {
    const col = (await getDb()).collection('settings');
    const doc = await col.findOne({ _id: req.params.userId });
    if (!doc) return res.json({});
    const { _id, ...rest } = doc;
    res.json(rest);
  } catch (e) {
    client = null;
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/settings/:userId', async (req, res) => {
  try {
    const col = (await getDb()).collection('settings');
    await col.replaceOne(
      { _id: req.params.userId },
      { _id: req.params.userId, ...req.body },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    client = null;
    res.status(500).json({ error: e.message });
  }
});

// ---- DATA (per utente) ----
app.get('/api/data/:userId', async (req, res) => {
  try {
    const col = await getDataCollection();
    const doc = await col.findOne({ _id: req.params.userId });
    if (!doc) return res.json({ categories: [], items: [] });
    const { _id, ...rest } = doc;
    res.json(rest);
  } catch (e) {
    client = null;
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/data/:userId', async (req, res) => {
  try {
    const col = await getDataCollection();
    await col.replaceOne(
      { _id: req.params.userId },
      { _id: req.params.userId, ...req.body },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    client = null;
    res.status(500).json({ error: e.message });
  }
});

// ---- HEALTH CHECK (usato da Render) ----
app.get('/health', (req, res) => res.json({ ok: true }));

// ---- START ----
app.listen(PORT, async () => {
  console.log(`\nAcquisti Categorizzati in ascolto su http://localhost:${PORT}`);
  if (!process.env.PORT) console.log(`Apri http://localhost:${PORT}/acquisti.html nel browser`);

  // Connessione anticipata a MongoDB all'avvio
  if (config.connectionString) {
    try {
      await getDb();
      console.log('MongoDB connesso.\n');
    } catch (e) {
      console.warn('Attenzione: connessione MongoDB fallita:', e.message, '\n');
    }
  }
});
