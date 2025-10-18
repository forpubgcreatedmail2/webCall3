// ============================================================
// Dial — Server.js  |  Mobile Login + WebRTC + Friends System
// Cleaned: static serving fixed, safer user loading, auth responses
// ============================================================

const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const cors = require('cors');

const SECRET = process.env.SECRET || 'supersecretkey';
const USERS_FILE = path.join(__dirname, 'users.json');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static files from project root (so index.html, main.js, style.css load)
const publicDir = __dirname;
app.use(express.static(publicDir));

// Root route (fallback)
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ===== Utility: Load & Save Users =====
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try {
    const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    // Normalize: ensure each user has name, friends, requests
    for (const k of Object.keys(users)) {
      users[k].name = users[k].name || k;
      users[k].friends = users[k].friends || [];
      users[k].requests = users[k].requests || [];
    }
    return users;
  } catch (e) {
    console.warn('Failed to parse users.json:', e);
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ===== Signup =====
app.post('/signup', async (req, res) => {
  const { name, mobile, password, confirm } = req.body;
  if (!name || !mobile || !password || !confirm)
    return res.status(400).json({ error: 'All fields required' });
  if (password !== confirm)
    return res.status(400).json({ error: 'Passwords do not match' });

  const users = loadUsers();
  if (users[mobile]) return res.status(400).json({ error: 'Mobile already registered' });

  try {
    const hash = await bcrypt.hash(password, 10);
    users[mobile] = { name, password: hash, friends: [], requests: [] };
    saveUsers(users);
    res.json({ success: true });
  } catch (err) {
    console.error('Signup failed', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ===== Login =====
app.post('/login', async (req, res) => {
  const { mobile, password } = req.body;
  if (!mobile || !password) return res.status(400).json({ error: 'All fields required' });

  const users = loadUsers();
  const user = users[mobile];
  if (!user) return res.status(400).json({ error: 'Invalid mobile or password' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Invalid mobile or password' });
  const token = jwt.sign({ mobile }, SECRET, { expiresIn: '2h' });
  res.json({ token, mobile, name: user.name });
});

// ===== WebSocket =====
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

// Broadcast online list to all users
function broadcastOnlineList() {
  const users = loadUsers();
  const online = Array.from(clients.keys());
  const payload = {};
  for (const m of Object.keys(users)) {
    payload[m] = {
      online: online.includes(m),
      friends: users[m].friends,
      requests: users[m].requests,
      name: users[m].name,
    };
  }
  const msg = JSON.stringify({ type: 'online_list', users: payload });
  for (const [, ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const { type, from, to, data, token } = msg;

    // ===== Register =====
    if (type === 'register') {
      const payload = verifyToken(token);
      if (!payload || payload.mobile !== from) {
        ws.send(JSON.stringify({ type: 'error', message: 'Auth failed' }));
        ws.close();
        return;
      }
      ws.userId = from;
      clients.set(from, ws);

      const users = loadUsers();
      users[from] = users[from] || { name: from, password: '', friends: [], requests: [] };
      users[from].friends ||= [];
      users[from].requests ||= [];
      saveUsers(users);

      ws.send(JSON.stringify({ type: 'my_profile', profile: users[from] }));
      broadcastOnlineList();
      return;
    }

    // If not registered, reject other messages
    if (!ws.userId) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not registered' }));
      return;
    }

    // ===== Friend Request =====
    if (type === 'friend_request') {
      const users = loadUsers();
      if (!users[from] || !users[to]) return;
      if (users[to].friends.includes(from)) return;

      users[to].requests ||= [];
      if (!users[to].requests.includes(from)) users[to].requests.push(from);
      saveUsers(users);

      if (clients.has(to) && clients.get(to).readyState === WebSocket.OPEN)
        clients.get(to).send(JSON.stringify({ type: 'friend_request', from }));
      if (clients.has(from) && clients.get(from).readyState === WebSocket.OPEN)
        clients.get(from).send(JSON.stringify({ type: 'friend_request_sent', to }));

      broadcastOnlineList();
      return;
    }

    // ===== Friend Accept =====
    if (type === 'friend_accept') {
      const users = loadUsers();
      if (!users[from] || !users[to]) return;
      // remove request from acceptor side (if present)
      users[from].requests = (users[from].requests || []).filter((r) => r !== to);

      if (!users[from].friends.includes(to)) users[from].friends.push(to);
      if (!users[to].friends.includes(from)) users[to].friends.push(from);
      saveUsers(users);

      if (clients.has(to) && clients.get(to).readyState === WebSocket.OPEN)
        clients.get(to).send(JSON.stringify({ type: 'friend_accept', with: from }));
      if (clients.has(from) && clients.get(from).readyState === WebSocket.OPEN)
        clients.get(from).send(JSON.stringify({ type: 'friend_accept', with: to }));

      broadcastOnlineList();
      return;
    }

// ===== Friend Remove =====
if (type === 'friend_remove') {
  const users = loadUsers();
  if (!users[from] || !users[to]) return;

  // Remove each other from friends list
  users[from].friends = (users[from].friends || []).filter(f => f !== to);
  users[to].friends = (users[to].friends || []).filter(f => f !== from);

  // Also remove any pending requests
  users[from].requests = (users[from].requests || []).filter(r => r !== to);
  users[to].requests = (users[to].requests || []).filter(r => r !== from);

  saveUsers(users);

  // Notify both clients if online
  if (clients.has(to) && clients.get(to).readyState === WebSocket.OPEN)
    clients.get(to).send(JSON.stringify({ type: 'friend_removed', by: from }));
  if (clients.has(from) && clients.get(from).readyState === WebSocket.OPEN)
    clients.get(from).send(JSON.stringify({ type: 'friend_removed', by: to }));

  broadcastOnlineList();
  return;
}


    // ===== WebRTC Signaling & Messages =====
    if (to && clients.has(to) && clients.get(to).readyState === WebSocket.OPEN) {
      // forward as-is
      clients.get(to).send(JSON.stringify({ type, from, data }));
    } else if (to) {
      // If the intended client is not connected, inform sender
      ws.send(JSON.stringify({ type: 'error', message: `User ${to} not connected` }));
    }
  });

  ws.on('close', () => {
    if (ws.userId) clients.delete(ws.userId);
    broadcastOnlineList();
  });
});

// Cleanup inactive sockets
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () =>
  console.log(`✅ Server running on port ${PORT} | Open http://localhost:${PORT}`)
);
