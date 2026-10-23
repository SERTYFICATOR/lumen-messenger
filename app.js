'use strict';

// Определяем адрес сервера автоматически (работает и локально, и на Render)
const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API = isLocalhost ? 'http://localhost:3000/api' : '/api';
const SOCKET_URL = isLocalhost ? 'http://localhost:3000' : '/';

const socket = io(SOCKET_URL);

const $ = id => document.getElementById(id);
const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const initials = n => n.trim().split(/\s+/).map(w => w[0]).slice(0,2).join('').toUpperCase() || '?';
const randColor = () => ['#e57373','#64b5f6','#81c784','#ffb74d','#ba68c8','#4db6ac','#f06292','#9575cd'][Math.floor(Math.random()*8)];

let currentUser = null;
let DB = { users: [], messages: [], stories: [] };
let activeChatId = null;

// ==========================================
//  УВЕДОМЛЕНИЯ
// ==========================================
function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch (e) {}
}

let unreadTotal = 0;
function updateTitleAndFavicon() {
  unreadTotal = DB.messages.filter(m => m.to === currentUser.phone && !m.read).length;
  document.title = unreadTotal > 0 ? `(${unreadTotal}) Lumen` : 'Lumen';
  
  const canvas = document.createElement('canvas');
  canvas.width = 32; canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#5288c1';
  ctx.beginPath();
  ctx.arc(16, 16, 14, 0, 2 * Math.PI);
  ctx.fill();
  
  if (unreadTotal > 0) {
    ctx.fillStyle = '#ff3b30';
    ctx.beginPath();
    ctx.arc(24, 8, 8, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(unreadTotal > 9 ? '9+' : unreadTotal, 24, 8);
  }
  
  let link = document.querySelector("link[rel~='icon']");
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  link.href = canvas.toDataURL('image/png');
}

function showToastNotification(senderName, text) {
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    new Notification(`Сообщение от ${senderName}`, { body: text || 'Вложение' });
  }
  const toastEl = document.createElement('div');
  toastEl.className = 'toast-notification';
  toastEl.innerHTML = `
    <div class="toast-notification__icon">💬</div>
    <div class="toast-notification__content">
      <strong>${esc(senderName)}</strong>
      <span>${esc(text || 'Фото')}</span>
    </div>
  `;
  document.body.appendChild(toastEl);
  requestAnimationFrame(() => toastEl.classList.add('show'));
  setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => toastEl.remove(), 300);
  }, 4000);
  playNotificationSound();
}

function setupNotifications() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default' && !localStorage.getItem('lumen_notif_asked')) {
    const btn = document.createElement('button');
    btn.textContent = '🔔 Включить уведомления о сообщениях';
    btn.style.cssText = 'position:fixed; bottom:20px; left:50%; transform:translateX(-50%); z-index:9999; padding:12px 24px; background:var(--accent); color:#fff; border:none; border-radius:20px; cursor:pointer; font-size:14px; box-shadow:0 4px 15px rgba(0,0,0,0.3); font-family:inherit;';
    btn.onclick = async () => {
      await Notification.requestPermission();
      localStorage.setItem('lumen_notif_asked', 'true');
      btn.remove();
      if (Notification.permission === 'granted') toast('Уведомления включены!');
    };
    document.body.appendChild(btn);
    setTimeout(() => btn.remove(), 15000);
  }
}

socket.on('new_message', (msg) => {
  if (!currentUser) return;
  if (msg.from !== currentUser.phone && activeChatId !== msg.from) {
    const sender = DB.users.find(u => u.phone === msg.from);
    showToastNotification(sender ? sender.name : 'Друг', msg.text);
  }
  loadDB().then(() => {
    if (activeChatId === msg.from) {
      fetch(`${API}/read`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: msg.from, to: currentUser.phone })
      }).then(() => loadDB());
      renderMessages(DB.users.find(u => u.phone === msg.from));
    }
  });
});

socket.on('messages_read', () => {
  loadDB().then(() => {
    if (activeChatId) renderMessages(DB.users.find(u => u.phone === activeChatId));
  });
});

// ==========================================
//  ВСПОМОГАТЕЛЬНЫЕ
// ==========================================
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2200);
}

function openModal(html) { $('modal').innerHTML = html; $('modalOverlay').classList.remove('hidden'); }
function closeModal() { $('modalOverlay').classList.add('hidden'); $('modal').innerHTML = ''; }
$('modalOverlay').addEventListener('click', e => { if (e.target.id === 'modalOverlay') closeModal(); });

async function loadDB() {
  try {
    const res = await fetch(`${API}/db`);
    DB = await res.json();
    renderAll();
    updateTitleAndFavicon();
  } catch (e) { console.error(e); toast('Ошибка подключения к серверу'); }
}

function showAuthScreen() {
  $('authScreen').classList.remove('hidden');
  $('appInner').classList.add('hidden');
  $('authStepPhone').classList.remove('hidden');
  $('authStepPassword').classList.add('hidden');
  $('authStepCode').classList.add('hidden');
  $('authStepName').classList.add('hidden');
}

async function showApp(user) {
  currentUser = user;
  localStorage.setItem('lumen_user', JSON.stringify(user));
  $('authScreen').classList.add('hidden');
  $('appInner').classList.remove('hidden');
  socket.emit('join', currentUser.phone);
  setupNotifications();
  await loadDB();
}

// ==========================================
//  АВТОРИЗАЦИЯ
// ==========================================
let pendingPhone = '';
let pendingCode = '';

$('authSendCode').addEventListener('click', async () => {
  const phone = $('authPhone').value.trim();
  if (!/^\+?[\d\s\-()]{7,}$/.test(phone)) { toast('Введите корректный номер'); return; }
  try {
    const res = await fetch(`${API}/auth/check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    
    pendingPhone = phone;
    $('authStepPhone').classList.add('hidden');
    
    if (data.exists) {
      if (data.requiresPassword) {
        $('authStepPassword').classList.remove('hidden');
        $('authPassword').focus();
      } else {
        pendingCode = String(Math.floor(10000 + Math.random() * 90000));
        $('authCodeHint').textContent = `Демо-код: ${pendingCode}`;
        $('authStepCode').classList.remove('hidden');
      }
    } else {
      pendingCode = String(Math.floor(10000 + Math.random() * 90000));
      $('authCodeHint').textContent = `Демо-код: ${pendingCode}`;
      $('authStepCode').classList.remove('hidden');
    }
  } catch(e) { toast('Сервер не запущен или ошибка сети'); }
});

$('authVerifyPassword').addEventListener('click', async () => {
  const password = $('authPassword').value.trim();
  if (!password) { toast('Введите пароль'); return; }
  const res = await fetch(`${API}/auth/verify-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: pendingPhone, password })
  });
  const data = await res.json();
  if (res.ok) showApp(data.user);
  else toast(data.error || 'Неверный пароль');
});

$('authBackFromPass').addEventListener('click', () => {
  $('authStepPassword').classList.add('hidden');
  $('authStepPhone').classList.remove('hidden');
});

$('authBack').addEventListener('click', () => {
  $('authStepCode').classList.add('hidden');
  $('authStepPhone').classList.remove('hidden');
});

$('authVerifyCode').addEventListener('click', async () => {
  if ($('authCode').value.trim() !== pendingCode) { toast('Неверный код'); return; }
  const res = await fetch(`${API}/auth/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: pendingPhone })
  });
  const data = await res.json();
  if (data.exists) showApp(data.user);
  else {
    $('authStepCode').classList.add('hidden');
    $('authStepName').classList.remove('hidden');
  }
});

$('authFinish').addEventListener('click', async () => {
  const name = $('authName').value.trim();
  const username = $('authUsername').value.trim().replace(/^@/, '');
  if (!name || !username) { toast('Заполните поля'); return; }
  const res = await fetch(`${API}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: pendingPhone, name, username, color: randColor() })
  });
  const data = await res.json();
  if (res.ok) showApp(data.user); else toast(data.error || 'Ошибка');
});

// ==========================================
//  РЕНДЕР
// ==========================================
function renderAll() {
  if (!currentUser) return;
  renderChatList();
  renderStories();
}

function renderChatList(filter = '') {
  const q = filter.trim().toLowerCase();
  const list = $('chatList');
  list.innerHTML = '';
  const contactPhones = new Set();
  DB.messages.forEach(m => {
    if (m.from === currentUser.phone) contactPhones.add(m.to);
    if (m.to === currentUser.phone) contactPhones.add(m.from);
  });

  const chatList = [];
  contactPhones.forEach(phone => {
    const contact = DB.users.find(u => u.phone === phone);
    if (!contact) return;
    const msgs = DB.messages.filter(m => 
      (m.from === currentUser.phone && m.to === phone) || (m.from === phone && m.to === currentUser.phone)
    ).sort((a, b) => a.timestamp - b.timestamp);
    const last = msgs[msgs.length - 1];
    const unread = msgs.filter(m => m.from === phone && !m.read).length;
    chatList.push({ phone, contact, last, unread, lastTime: last ? last.timestamp : 0 });
  });

  chatList.sort((a, b) => b.lastTime - a.lastTime);
  const filtered = chatList.filter(item => !q || item.contact.name.toLowerCase().includes(q));
  
  if (!filtered.length) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:14px;padding:20px;text-align:center">Нет чатов. Добавьте друга!</p>';
    return;
  }

  filtered.forEach(item => {
    const li = document.createElement('li');
    li.className = 'chat-item' + (activeChatId === item.phone ? ' active' : '');
    const prefix = item.last && item.last.from === currentUser.phone ? 'Вы: ' : '';
    const preview = item.last ? prefix + (item.last.image ? '📷 Фото' : item.last.text) : '';
    li.innerHTML = `
      <div class="avatar" style="background:${item.contact.color}">${esc(initials(item.contact.name))}</div>
      <div class="chat-item__body">
        <div class="chat-item__top">
          <span class="chat-item__name">${esc(item.contact.name)}</span>
          <span class="chat-item__time">${item.last ? item.last.time : ''}</span>
        </div>
        <div class="chat-item__preview">${esc(preview)}</div>
      </div>
      ${item.unread ? `<span class="unread-badge">${item.unread}</span>` : ''}
    `;
    li.addEventListener('click', () => openChat(item.phone));
    list.appendChild(li);
  });
}

function renderStories() {
  const bar = $('storiesBar');
  bar.innerHTML = '';
  const add = document.createElement('div');
  add.className = 'story-item';
  add.innerHTML = `<div class="story-ring story-ring--add"><div class="story-inner">＋</div></div><div class="story-label">Добавить</div>`;
  add.addEventListener('click', openStoryCapture);
  bar.appendChild(add);
  DB.stories.forEach(s => {
    const author = DB.users.find(u => u.phone === s.authorPhone);
    if (!author) return;
    const item = document.createElement('div');
    item.className = 'story-item';
    item.innerHTML = `
      <div class="story-ring"><div class="story-inner" style="background:${author.color}">${s.image ? `<img src="${s.image}">` : esc(initials(author.name))}</div></div>
      <div class="story-label">${esc(author.name.split(' ')[0])}</div>
    `;
    item.addEventListener('click', () => openStoryViewer(s.id));
    bar.appendChild(item);
  });
}

async function openChat(phone) {
  const contact = DB.users.find(u => u.phone === phone);
  if (!contact) return;
  activeChatId = phone;
  await fetch(`${API}/read`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: phone, to: currentUser.phone })
  });
  $('chatEmpty').classList.add('hidden');
  $('chatWindow').classList.remove('hidden');
  $('appInner').classList.add('chat-open');
  $('chatName').textContent = contact.name;
  $('chatAvatar').textContent = initials(contact.name);
  $('chatAvatar').style.background = contact.color;
  await loadDB();
  renderMessages(contact);
  $('messageInput').focus();
}

function renderMessages(contact) {
  const box = $('messages');
  box.innerHTML = '';
  const msgs = DB.messages.filter(m => 
    (m.from === currentUser.phone && m.to === contact.phone) || (m.from === contact.phone && m.to === currentUser.phone)
  ).sort((a, b) => a.timestamp - b.timestamp);
  msgs.forEach(m => {
    const isOut = m.from === currentUser.phone;
    const div = document.createElement('div');
    div.className = 'msg ' + (isOut ? 'out' : 'in');
    div.innerHTML = `<div class="bubble">${m.image ? `<img src="${m.image}">` : ''}${esc(m.text)}</div><div class="msg__meta"><span>${m.time}</span></div>`;
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}

async function sendMessage() {
  const input = $('messageInput');
  const text = input.value.trim();
  if (!text || !activeChatId) return;
  await fetch(`${API}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: currentUser.phone, to: activeChatId, text }) });
  input.value = '';
  await loadDB();
  renderMessages(DB.users.find(u => u.phone === activeChatId));
}

$('sendBtn').addEventListener('click', sendMessage);
$('messageInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) sendMessage(); });
$('searchInput').addEventListener('input', () => renderChatList($('searchInput').value));

$('backBtn').addEventListener('click', () => {
  $('appInner').classList.remove('chat-open');
  activeChatId = null;
  $('chatWindow').classList.add('hidden');
  $('chatEmpty').classList.remove('hidden');
  renderChatList($('searchInput').value);
});

$('newChatBtn').addEventListener('click', () => {
  openModal(`
    <h3>Добавить друга</h3>
    <div class="modal-field"><label>Имя</label><input id="fName" placeholder="Имя" maxlength="40"></div>
    <div class="modal-field"><label>Username</label><input id="fUsername" placeholder="username" maxlength="32"></div>
    <div class="modal-field"><label>Телефон</label><input id="fPhone" placeholder="+7 900 000-00-00" maxlength="20"></div>
    <div class="modal-actions"><button class="modal-btn" id="fCancel">Отмена</button><button class="modal-btn primary" id="fAdd">Добавить</button></div>
  `);
  $('fCancel').onclick = closeModal;
  $('fAdd').onclick = async () => {
    const name = $('fName').value.trim();
    const username = $('fUsername').value.trim();
    const phone = $('fPhone').value.trim();
    if (!name || !phone) { toast('Заполните поля'); return; }
    await fetch(`${API}/friend`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, username, phone, color: randColor() }) });
    closeModal();
    await loadDB();
    openChat(phone);
  };
});

$('menuBtn').addEventListener('click', () => {
  openModal(`
    <h3>Меню</h3>
    <div class="profile-item" id="mProfile"><div class="profile-item__icon">👤</div><div class="profile-item__text"><strong>Профиль</strong></div></div>
    <div class="profile-item danger" id="mLogout"><div class="profile-item__icon">🚪</div><div class="profile-item__text"><strong>Выйти</strong></div></div>
    <div class="modal-actions"><button class="modal-btn" id="mClose">Закрыть</button></div>
  `);
  $('mClose').onclick = closeModal;
  $('mLogout').onclick = () => { localStorage.removeItem('lumen_user'); location.reload(); };
});

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    if (tab === 'chats') $('profilePanel').classList.add('hidden');
    if (tab === 'friends') openFriendsPanel();
    if (tab === 'profile') openProfilePanel();
  });
});

function openFriendsPanel() {
  $('profilePanelTitle').textContent = 'Друзья';
  $('profileBody').innerHTML = `<div id="friendsList"></div>`;
  $('profilePanel').classList.remove('hidden');
  const list = $('friendsList');
  DB.users.filter(u => u.phone !== currentUser.phone).forEach(f => {
    const div = document.createElement('div');
    div.className = 'profile-item';
    div.innerHTML = `<div class="avatar small" style="background:${f.color}">${esc(initials(f.name))}</div><div class="profile-item__text"><strong>${esc(f.name)}</strong><span>${f.phone}</span></div>`;
    div.onclick = () => { $('profilePanel').classList.add('hidden'); openChat(f.phone); };
    list.appendChild(div);
  });
}

function openProfilePanel() {
  $('profilePanelTitle').textContent = 'Профиль';
  $('profileBody').innerHTML = `
    <div class="profile-field"><label>Имя</label><input id="pName" value="${esc(currentUser.name)}"></div>
    <div class="profile-field"><label>О себе</label><textarea id="pBio">${esc(currentUser.bio || '')}</textarea></div>
    <button class="profile-save" id="pSave">Сохранить</button>
    
    <div class="profile-section-title">Безопасность</div>
    <div class="profile-field">
      <label>Облачный пароль</label>
      <input type="password" id="pPassword" placeholder="Установить пароль" maxlength="50">
      <div class="hint">Пароль будет запрашиваться при входе с нового устройства</div>
    </div>
    <button class="profile-save" id="pSavePass" style="background: var(--danger);">Обновить пароль</button>
  `;
  $('profilePanel').classList.remove('hidden');

  $('pSave').onclick = async () => {
    await fetch(`${API}/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: currentUser.phone, name: $('pName').value, bio: $('pBio').value }) });
    toast('Профиль сохранён');
    await loadDB();
  };

  $('pSavePass').onclick = async () => {
    const pass = $('pPassword').value.trim();
    if (!pass) { toast('Введите пароль'); return; }
    await fetch(`${API}/profile/password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: currentUser.phone, newPassword: pass })
    });
    toast('Облачный пароль установлен!');
    $('pPassword').value = '';
  };
}

// Истории
let captureStream, capturedImage = null;
async function openStoryCapture() {
  $('storyCapture').classList.remove('hidden');
  $('capturePreview').classList.add('hidden');
  $('captureVideo').classList.remove('hidden');
  try {
    captureStream = await navigator.mediaDevices.getUserMedia({ video: true });
    $('captureVideo').srcObject = captureStream;
  } catch { toast('Камера недоступна'); }
}
$('captureCancel').onclick = () => { if (captureStream) captureStream.getTracks().forEach(t => t.stop()); $('storyCapture').classList.add('hidden'); };
$('captureShutter').onclick = () => {
  const v = $('captureVideo'), c = $('captureCanvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  capturedImage = c.toDataURL('image/jpeg');
  $('captureVideo').classList.add('hidden');
  $('capturePreview').src = capturedImage;
  $('capturePreview').classList.remove('hidden');
  $('capturePublish').classList.remove('hidden');
};
$('storyPublishBtn').onclick = async () => {
  await fetch(`${API}/story`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ authorPhone: currentUser.phone, image: capturedImage, caption: $('storyCaption').value }) });
  $('storyCapture').classList.add('hidden');
  await loadDB();
};
function openStoryViewer(id) {
  const s = DB.stories.find(x => x.id === id);
  if (!s) return;
  $('storyViewer').classList.remove('hidden');
  $('storyMedia').innerHTML = `<img src="${s.image}"><div class="caption">${esc(s.caption)}</div>`;
}
$('storyClose').onclick = () => $('storyViewer').classList.add('hidden');

// Старт
const savedUser = JSON.parse(localStorage.getItem('lumen_user'));
if (savedUser) showApp(savedUser); else showAuthScreen();