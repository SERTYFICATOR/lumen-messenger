const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { users: [], messages: [], stories: [], channels: [], requests: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  ['users', 'messages', 'stories', 'channels', 'requests'].forEach(k => { if (!db[k]) db[k] = []; });
  return db;
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  try { fs.writeFileSync(path.join(__dirname, '..', 'database_backup.json'), JSON.stringify(data, null, 2)); } catch(e) {}
}

const dbInit = readDB();
if (!dbInit.users.find(u => u.phone === 'AI_BOT')) {
  dbInit.users.push({ phone: 'AI_BOT', name: 'Lumen AI', username: 'ai_bot', color: '#ba68c8', bio: 'Искусственный интеллект' });
  writeDB(dbInit);
}

io.on('connection', (socket) => {
  socket.on('join', (phone) => socket.join(phone));
});

app.get('/api/db', (req, res) => res.json(readDB()));

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  const db = readDB();
  const results = db.users.filter(u => u.phone !== 'AI_BOT' && (
    u.phone.includes(q) || (u.name && u.name.toLowerCase().includes(q)) || (u.username && u.username.toLowerCase().includes(q))
  ));
  res.json(results);
});

app.post('/api/auth/check', (req, res) => {
  const user = readDB().users.find(u => u.phone === req.body.phone);
  if (!user) return res.json({ exists: false });
  if (user.cloudPassword) return res.json({ exists: true, requiresPassword: true });
  return res.json({ exists: true, requiresPassword: false, user });
});

app.post('/api/auth/verify-password', (req, res) => {
  const user = readDB().users.find(u => u.phone === req.body.phone);
  if (user && user.cloudPassword === req.body.password) return res.json({ success: true, user });
  res.status(401).json({ error: 'Неверный пароль' });
});

app.post('/api/auth/register', (req, res) => {
  const db = readDB();
  if (db.users.some(u => u.username === req.body.username)) return res.status(400).json({ error: 'Username занят' });
  const newUser = { ...req.body, bio: '', cloudPassword: null, avatar: null };
  db.users.push(newUser); writeDB(db); res.json({ success: true, user: newUser });
});

app.post('/api/profile', (req, res) => {
  const db = readDB();
  const user = db.users.find(u => u.phone === req.body.phone);
  if (user) { Object.assign(user, req.body); writeDB(db); res.json({ success: true, user }); }
  else res.status(404).json({ error: 'Нет юзера' });
});

app.post('/api/friend/request', (req, res) => {
  const db = readDB();
  if (!db.requests.find(r => r.from === req.body.from && r.to === req.body.to)) {
    db.requests.push({ id: Date.now().toString(), from: req.body.from, to: req.body.to });
    writeDB(db); io.to(req.body.to).emit('new_request', { from: req.body.from });
  }
  res.json({ success: true });
});

app.post('/api/friend/accept', (req, res) => {
  const db = readDB();
  db.requests = db.requests.filter(r => !(r.from === req.body.from && r.to === req.body.to));
  writeDB(db); io.to(req.body.from).emit('friend_accepted', { by: req.body.to });
  res.json({ success: true });
});

app.post('/api/friend/decline', (req, res) => {
  const db = readDB();
  db.requests = db.requests.filter(r => !(r.from === req.body.from && r.to === req.body.to));
  writeDB(db); res.json({ success: true });
});

// --- КАНАЛЫ ---
app.post('/api/channel/create', (req, res) => {
  const db = readDB();
  const channel = { 
    id: 'ch_' + Date.now(), 
    name: req.body.name, 
    description: req.body.description || '', 
    authorPhone: req.body.authorPhone, 
    subscribers: [req.body.authorPhone],
    messages: [] 
  };
  db.channels.push(channel); writeDB(db); io.emit('new_channel', channel);
  res.json({ success: true, channel });
});

app.post('/api/channel/subscribe', (req, res) => {
  const db = readDB();
  const channel = db.channels.find(c => c.id === req.body.channelId);
  if (channel && !channel.subscribers.includes(req.body.phone)) {
    channel.subscribers.push(req.body.phone); writeDB(db);
  }
  res.json({ success: true });
});

// --- СООБЩЕНИЯ ---
app.post('/api/message', (req, res) => {
  const { from, to, text, type, replyTo } = req.body;
  const db = readDB();
  
  // Если это канал
  if (to.startsWith('ch_')) {
    const channel = db.channels.find(c => c.id === to);
    if (channel && channel.authorPhone === from) {
      const msg = { id: Date.now().toString(), from, to, text, type: type || 'text', replyTo, time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }), timestamp: Date.now(), read: false };
      channel.messages.push(msg); writeDB(db);
      io.emit('channel_message', { channelId: to, msg });
    }
    return res.json({ success: true });
  }

  // Обычный чат
  if (!db.users.find(u => u.phone === to)) {
    db.users.push({ phone: to, name: 'Пользователь', username: 'user' + to.slice(-4), color: '#5288c1' });
  }
  const msg = {
    id: Date.now().toString(), from, to, text, type: type || 'text', replyTo,
    time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    timestamp: Date.now(), read: false
  };
  db.messages.push(msg); writeDB(db);
  io.to(msg.to).emit('new_message', msg); io.to(msg.from).emit('new_message', msg);

  if (msg.to === 'AI_BOT') {
    setTimeout(() => {
      const aiMsg = {
        id: Date.now().toString(), from: 'AI_BOT', to: msg.from, text: getAIResponse(msg.text), type: 'text',
        time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
        timestamp: Date.now(), read: false
      };
      db.messages.push(aiMsg); writeDB(db);
      io.to(msg.from).emit('new_message', aiMsg);
    }, 1000);
  }
  res.json({ success: true, message: msg });
});

app.post('/api/message/edit', (req, res) => {
  const db = readDB();
  const msg = db.messages.find(m => m.id === req.body.id);
  if (msg && msg.from === req.body.phone) { msg.text = req.body.text; writeDB(db); io.emit('msg_edited', msg); }
  res.json({ success: true });
});

app.post('/api/message/delete', (req, res) => {
  const db = readDB();
  db.messages = db.messages.filter(m => !(m.id === req.body.id && m.from === req.body.phone));
  writeDB(db); io.emit('msg_deleted', req.body.id); res.json({ success: true });
});

app.post('/api/read', (req, res) => {
  const db = readDB();
  db.messages.forEach(m => { if (m.from === req.body.from && m.to === req.body.to) m.read = true; });
  writeDB(db); io.to(req.body.from).emit('messages_read', { by: req.body.to }); res.json({ success: true });
});

app.post('/api/story', (req, res) => {
  const db = readDB();
  const story = { id: Date.now().toString(), ...req.body, time: 'только что', timestamp: Date.now() };
  db.stories.unshift(story); writeDB(db); io.emit('new_story', story);
  res.json({ success: true, story });
});

function getAIResponse(text) {
  const t = text.toLowerCase();
  if (t.includes('привет')) return 'Привет! Я ИИ Lumen. Чем помочь?';
  if (t.includes('как дела')) return 'У меня всё отлично! А у тебя?';
  if (t.includes('кто ты')) return 'Я твой цифровой помощник.';
  return `Ты написал: "${text}". Я пока учусь анализировать.`;
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
