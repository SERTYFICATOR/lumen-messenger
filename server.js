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

// ==========================================
//  УМНАЯ БАЗА ДАННЫХ (Не теряет аккаунты)
// ==========================================
function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { users: [], messages: [], stories: [], channels: [], requests: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!data.users) data.users = [];
    if (!data.messages) data.messages = [];
    if (!data.stories) data.stories = [];
    if (!data.channels) data.channels = [];
    if (!data.requests) data.requests = [];
    return data;
  } catch (e) {
    return { users: [], messages: [], stories: [], channels: [], requests: [] };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  // Дублируем в системную папку (чтобы Render не стер при перезагрузке)
  const backup = path.join(__dirname, '..', 'database_backup.json');
  try { fs.writeFileSync(backup, JSON.stringify(data, null, 2)); } catch(e) {}
}

// Инициализация базы ИИ
const dbInit = readDB();
if (!dbInit.users.find(u => u.phone === 'AI_BOT')) {
  dbInit.users.push({ 
    phone: 'AI_BOT', 
    name: 'Lumen AI', 
    username: 'ai_bot', 
    color: '#ba68c8', 
    bio: 'Искусственный интеллект' 
  });
  writeDB(dbInit);
}

io.on('connection', (socket) => {
  socket.on('join', (phone) => socket.join(phone));
});

// --- API ---
app.get('/api/db', (req, res) => res.json(readDB()));

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  const db = readDB();
  const results = db.users.filter(u => 
    u.phone !== 'AI_BOT' && (
      (u.phone && u.phone.includes(q)) || 
      (u.name && u.name.toLowerCase().includes(q)) || 
      (u.username && u.username.toLowerCase().includes(q))
    )
  );
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

// Система друзей
app.post('/api/friend/request', (req, res) => {
  const db = readDB();
  if (!db.requests.find(r => r.from === req.body.from && r.to === req.body.to)) {
    db.requests.push({ id: Date.now().toString(), from: req.body.from, to: req.body.to });
    writeDB(db);
    io.to(req.body.to).emit('new_request', { from: req.body.from });
  }
  res.json({ success: true });
});

app.post('/api/friend/accept', (req, res) => {
  const db = readDB();
  db.requests = db.requests.filter(r => !(r.from === req.body.from && r.to === req.body.to));
  writeDB(db);
  io.to(req.body.from).emit('friend_accepted', { by: req.body.to });
  res.json({ success: true });
});

app.post('/api/friend/decline', (req, res) => {
  const db = readDB();
  db.requests = db.requests.filter(r => !(r.from === req.body.from && r.to === req.body.to));
  writeDB(db);
  res.json({ success: true });
});

// Каналы
app.post('/api/channel', (req, res) => {
  const db = readDB();
  const channel = { id: Date.now().toString(), ...req.body, subscribers: [req.body.authorPhone] };
  db.channels.push(channel); writeDB(db); io.emit('new_channel', channel);
  res.json({ success: true, channel });
});

// Сообщения
app.post('/api/message', (req, res) => {
  const db = readDB();
  if (!db.users.find(u => u.phone === req.body.to)) {
    db.users.push({ phone: req.body.to, name: 'Пользователь', username: 'user' + req.body.to.slice(-4), color: '#5288c1' });
  }
  const msg = {
    id: Date.now().toString(), from: req.body.from, to: req.body.to, text: req.body.text, type: req.body.type || 'text',
    time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    timestamp: Date.now(), read: false
  };
  db.messages.push(msg); writeDB(db);
  io.to(msg.to).emit('new_message', msg); io.to(msg.from).emit('new_message', msg);

  // Логика ИИ-бота
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

function getAIResponse(text) {
  const t = text.toLowerCase();
  if (t.includes('привет')) return 'Привет! Я ИИ Lumen. Чем помочь?';
  if (t.includes('как дела')) return 'У меня всё отлично! А у тебя?';
  if (t.includes('кто ты')) return 'Я твой цифровой помощник.';
  return `Ты написал: "${text}". Я пока учусь анализировать.`;
}

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

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
