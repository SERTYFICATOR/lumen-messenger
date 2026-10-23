const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// ВСТАВЬТЕ СЮДА ВАШУ ССЫЛКУ ИЗ MONGODB ATLAS
// Пример: mongodb+srv://user:password@cluster0.abcde.mongodb.net/lumen?retryWrites=true&w=majority
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/lumen'; 

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// --- СХЕМЫ БАЗЫ ДАННЫХ ---
const User = mongoose.model('User', new mongoose.Schema({
  phone: { type: String, unique: true },
  name: String, username: String, color: String, avatar: String, bio: String, cloudPassword: String
}));

const Message = mongoose.model('Message', new mongoose.Schema({
  from: String, to: String, text: String, type: String, time: String, timestamp: Number, read: Boolean
}));

const Story = mongoose.model('Story', new mongoose.Schema({
  authorPhone: String, image: String, video: String, time: String, timestamp: Number
}));

const Channel = mongoose.model('Channel', new mongoose.Schema({
  id: String, name: String, description: String, authorPhone: String, subscribers: [String]
}));

// --- API ---
io.on('connection', (socket) => {
  socket.on('join', (phone) => socket.join(phone));
});

app.get('/api/db', async (req, res) => {
  const users = await User.find();
  const messages = await Message.find();
  const stories = await Story.find().sort({timestamp: -1});
  const channels = await Channel.find();
  res.json({ users, messages, stories, channels });
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  const users = await User.find({
    $or: [
      { phone: { $regex: q, $options: 'i' } },
      { name: { $regex: q, $options: 'i' } },
      { username: { $regex: q, $options: 'i' } }
    ]
  });
  res.json(users);
});

app.post('/api/auth/check', async (req, res) => {
  const user = await User.findOne({ phone: req.body.phone });
  if (!user) return res.json({ exists: false });
  if (user.cloudPassword) return res.json({ exists: true, requiresPassword: true });
  res.json({ exists: true, requiresPassword: false, user });
});

app.post('/api/auth/verify-password', async (req, res) => {
  const user = await User.findOne({ phone: req.body.phone });
  if (user && user.cloudPassword === req.body.password) return res.json({ success: true, user });
  res.status(401).json({ error: 'Неверный пароль' });
});

app.post('/api/auth/register', async (req, res) => {
  if (await User.findOne({ username: req.body.username })) return res.status(400).json({ error: 'Username занят' });
  const newUser = new User({ ...req.body, bio: '', cloudPassword: null, avatar: null });
  await newUser.save();
  res.json({ success: true, user: newUser });
});

app.post('/api/profile', async (req, res) => {
  const user = await User.findOneAndUpdate({ phone: req.body.phone }, req.body, { new: true });
  res.json({ success: true, user });
});

app.post('/api/channel', async (req, res) => {
  const newChannel = new Channel({ id: Date.now().toString(), ...req.body, subscribers: [req.body.authorPhone] });
  await newChannel.save();
  io.emit('new_channel', newChannel);
  res.json({ success: true, channel: newChannel });
});

app.post('/api/message', async (req, res) => {
  const { from, to, text, type } = req.body;
  const msg = new Message({
    from, to, text, type: type || 'text',
    time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    timestamp: Date.now(), read: false
  });
  await msg.save();
  
  io.to(to).emit('new_message', msg);
  io.to(from).emit('new_message', msg);

  // ОТВЕТ ИСКУССТВЕННОГО ИНТЕЛЛЕКТА (Если пишем в чат ИИ)
  if (to === 'AI_BOT') {
    setTimeout(async () => {
      const aiText = getAIResponse(text);
      const aiMsg = new Message({
        from: 'AI_BOT', to: from, text: aiText, type: 'text',
        time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
        timestamp: Date.now(), read: false
      });
      await aiMsg.save();
      io.to(from).emit('new_message', aiMsg);
    }, 1000);
  }
  res.json({ success: true, message: msg });
});

// Простая имитация ИИ
function getAIResponse(text) {
  const t = text.toLowerCase();
  if (t.includes('привет') || t.includes('здравствуй')) return 'Привет! Я искусственный интеллект Lumen. Чем могу помочь?';
  if (t.includes('как дела')) return 'У меня всё отлично, я же программа! А у тебя как?';
  if (t.includes('погода')) return 'Я не могу посмотреть в окно, но могу сказать, что в интернете всегда облачно ☁️';
  if (t.includes('кто ты')) return 'Я твой цифровой помощник, созданный на базе Lumen.';
  if (t.includes('шутка')) return 'Почему программисты путают Хэллоуин и Рождество? Потому что Oct 31 == Dec 25!';
  return `Интересный вопрос! Вы написали: "${text}". Я пока учусь, но обязательно запомню это.`;
}

app.post('/api/read', async (req, res) => {
  await Message.updateMany({ from: req.body.from, to: req.body.to, read: false }, { read: true });
  io.to(req.body.from).emit('messages_read', { by: req.body.to });
  res.json({ success: true });
});

app.post('/api/story', async (req, res) => {
  const story = new Story({ ...req.body, time: 'только что', timestamp: Date.now() });
  await story.save();
  io.emit('new_story', story);
  res.json({ success: true, story });
});

// Запуск сервера после подключения к БД
mongoose.connect(MONGO_URI).then(() => {
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => console.error('DB Connection Error:', err));
