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
    const initial = { users: [], messages: [], stories: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

io.on('connection', (socket) => {
  socket.on('join', (phone) => socket.join(phone));
});

app.get('/api/db', (req, res) => res.json(readDB()));

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  const db = readDB();
  res.json(db.users.filter(u => u.phone.includes(q) || (u.name && u.name.toLowerCase().includes(q)) || (u.username && u.username.toLowerCase().includes(q))));
});

app.post('/api/auth/check', (req, res) => {
  const { phone } = req.body;
  const user = readDB().users.find(u => u.phone === phone);
  if (!user) return res.json({ exists: false });
  if (user.cloudPassword) return res.json({ exists: true, requiresPassword: true });
  return res.json({ exists: true, requiresPassword: false, user });
});

app.post('/api/auth/verify-password', (req, res) => {
  const { phone, password } = req.body;
  const user = readDB().users.find(u => u.phone === phone);
  if (user && user.cloudPassword === password) return res.json({ success: true, user });
  res.status(401).json({ error: 'Неверный пароль' });
});

app.post('/api/auth/register', (req, res) => {
  const { phone, name, username, color } = req.body;
  const db = readDB();
  if (db.users.some(u => u.username === username)) return res.status(400).json({ error: 'Username занят' });
  const newUser = { phone, name, username, color, bio: '', cloudPassword: null, avatar: null };
  db.users.push(newUser); writeDB(db); res.json({ success: true, user: newUser });
});

app.post('/api/profile', (req, res) => {
  const { phone, name, bio, avatar } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.phone === phone);
  if (user) { 
    if(name !== undefined) user.name = name; 
    if(bio !== undefined) user.bio = bio; 
    if(avatar !== undefined) user.avatar = avatar;
    writeDB(db); res.json({ success: true, user }); 
  } else res.status(404).json({ error: 'Нет юзера' });
});

app.post('/api/message', (req, res) => {
  const { from, to, text, type } = req.body; 
  const db = readDB();
  if (!db.users.find(u => u.phone === to)) {
    db.users.push({ phone: to, name: 'Пользователь ' + to.slice(-4), username: 'user' + to.slice(-4), color: '#5288c1', bio: '', cloudPassword: null });
  }
  const msg = {
    id: Date.now().toString(), from, to, text, type: type || 'text',
    time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    timestamp: Date.now(), read: false
  };
  db.messages.push(msg); writeDB(db);
  io.to(to).emit('new_message', msg); io.to(from).emit('new_message', msg);
  res.json({ success: true, message: msg });
});

app.post('/api/read', (req, res) => {
  const { from, to } = req.body;
  const db = readDB();
  db.messages.forEach(m => { if (m.from === from && m.to === to && !m.read) m.read = true; });
  writeDB(db); io.to(from).emit('messages_read', { by: to }); res.json({ success: true });
});

app.post('/api/story', (req, res) => {
  const { authorPhone, image, video, caption } = req.body;
  const db = readDB();
  const story = { 
    id: Date.now().toString(), authorPhone, 
    image: image || null, video: video || null, caption: caption || '', 
    time: 'только что', timestamp: Date.now() 
  };
  db.stories.unshift(story); writeDB(db); io.emit('new_story', story);
  res.json({ success: true, story });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
