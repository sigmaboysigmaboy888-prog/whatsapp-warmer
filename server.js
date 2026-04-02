const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure sessions folder exists
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

// Store active sessions
const sessions = new Map();
const messageStats = new Map();
const groupCache = new Map();

// Helper functions
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);
const formatNumber = (number) => {
  let clean = number.toString().replace(/\D/g, '');
  if (!clean.endsWith('@c.us')) clean = clean + '@c.us';
  return clean;
};

// Generate random Indonesian numbers
const generateRandomNumbers = (count) => {
  const prefixes = ['62812', '62813', '62821', '62822', '62851', '62852', '62853', '62857', '62858', '62859', '62877', '62878', '62879', '62881', '62882', '62883', '62895', '62896', '62897', '62898', '62899'];
  const numbers = [];
  for (let i = 0; i < count; i++) {
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const suffix = Math.floor(Math.random() * 10000000).toString().padStart(7, '0');
    numbers.push(prefix + suffix);
  }
  return [...new Set(numbers)];
};

// Create WhatsApp client with pairing support
function createClient(sessionId, io, socketId, pairingCode = null) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId, dataPath: sessionsDir }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
  });

  client.on('qr', async (qr) => {
    const qrImage = await QRCode.toDataURL(qr);
    io.to(socketId).emit('qr', { sessionId, qr: qrImage });
  });

  client.on('ready', async () => {
    // Get all chats and groups
    const chats = await client.getChats();
    const groups = chats.filter(chat => chat.isGroup).map(chat => ({
      id: chat.id._serialized,
      name: chat.name,
      participantCount: chat.participants?.length || 0
    }));
    
    io.to(socketId).emit('ready', { 
      sessionId, 
      message: 'WhatsApp Connected!',
      groups: groups
    });
    
    if (!messageStats.has(sessionId)) {
      messageStats.set(sessionId, { totalSent: 0, history: [], isWarming: false });
    }
  });

  client.on('authenticated', () => {
    io.to(socketId).emit('authenticated', { sessionId });
  });

  client.on('auth_failure', (msg) => {
    io.to(socketId).emit('error', { sessionId, message: 'Auth failed: ' + msg });
  });

  client.on('disconnected', (reason) => {
    sessions.delete(sessionId);
    io.to(socketId).emit('disconnected', { sessionId, message: 'Disconnected: ' + reason });
  });

  // If pairing code provided, use it
  if (pairingCode) {
    client.on('qr', () => {});
    client.initialize();
    setTimeout(() => {
      client.requestPairingCode(pairingCode);
    }, 2000);
  } else {
    client.initialize();
  }
  
  return client;
}

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('⚡ Client connected:', socket.id);

  // Connect via QR
  socket.on('connect-wa', async ({ sessionId }) => {
    if (sessions.has(sessionId)) {
      socket.emit('ready', { sessionId, message: 'Already connected' });
      return;
    }
    const client = createClient(sessionId, io, socket.id, null);
    sessions.set(sessionId, { client, socketId: socket.id });
  });

  // Connect via Pairing Code (FAST!)
  socket.on('connect-wa-pairing', async ({ sessionId, phoneNumber }) => {
    if (sessions.has(sessionId)) {
      socket.emit('ready', { sessionId, message: 'Already connected' });
      return;
    }
    
    let cleanNumber = phoneNumber.toString().replace(/\D/g, '');
    if (cleanNumber.startsWith('0')) cleanNumber = '62' + cleanNumber.substring(1);
    if (!cleanNumber.startsWith('62')) cleanNumber = '62' + cleanNumber;
    
    socket.emit('pairing-started', { sessionId, message: `Requesting pairing code for ${cleanNumber}...` });
    
    const client = createClient(sessionId, io, socket.id, cleanNumber);
    sessions.set(sessionId, { client, socketId: socket.id });
  });

  // Disconnect
  socket.on('disconnect-wa', ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (session && session.client) {
      session.client.destroy();
      sessions.delete(sessionId);
      socket.emit('disconnected', { sessionId, message: 'Disconnected' });
    }
  });

  // Get groups list
  socket.on('get-groups', async ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session || !session.client) {
      socket.emit('error', { message: 'Not connected!' });
      return;
    }
    
    try {
      const chats = await session.client.getChats();
      const groups = chats.filter(chat => chat.isGroup).map(chat => ({
        id: chat.id._serialized,
        name: chat.name,
        participantCount: chat.participants?.length || 0
      }));
      socket.emit('groups-list', { groups });
    } catch(e) {
      socket.emit('error', { message: 'Failed to get groups' });
    }
  });

  // Get group members
  socket.on('get-group-members', async ({ sessionId, groupId }) => {
    const session = sessions.get(sessionId);
    if (!session || !session.client) {
      socket.emit('error', { message: 'Not connected!' });
      return;
    }
    
    try {
      const chat = await session.client.getChatById(groupId);
      const members = chat.participants.map(p => p.id._serialized.replace('@c.us', ''));
      socket.emit('group-members', { members, count: members.length });
    } catch(e) {
      socket.emit('error', { message: 'Failed to get members' });
    }
  });

  // START WARMING ENGINE
  socket.on('start-warming', async ({ sessionId, targetMode, groupId, randomCount, texts, delayMin, delayMax, sendMode }) => {
    const session = sessions.get(sessionId);
    if (!session || !session.client) {
      socket.emit('error', { message: 'WhatsApp not connected!' });
      return;
    }

    const stats = messageStats.get(sessionId) || { totalSent: 0, history: [], isWarming: true };
    stats.isWarming = true;
    messageStats.set(sessionId, stats);
    
    let targetNumbers = [];
    
    // Get target numbers based on mode
    if (targetMode === 'group') {
      if (!groupId) {
        socket.emit('error', { message: 'No group selected!' });
        return;
      }
      try {
        const chat = await session.client.getChatById(groupId);
        targetNumbers = chat.participants.map(p => p.id._serialized.replace('@c.us', ''));
        socket.emit('warming-status', { message: `Found ${targetNumbers.length} members in group` });
      } catch(e) {
        socket.emit('error', { message: 'Failed to get group members' });
        return;
      }
    } else if (targetMode === 'random') {
      targetNumbers = generateRandomNumbers(randomCount || 50);
      socket.emit('warming-status', { message: `Generated ${targetNumbers.length} random numbers` });
    }
    
    if (targetNumbers.length === 0) {
      socket.emit('error', { message: 'No targets found!' });
      return;
    }
    
    socket.emit('warming-started', { sessionId, totalTargets: targetNumbers.length });
    
    let sentCount = 0;
    
    for (const contact of targetNumbers) {
      if (!stats.isWarming) break;
      
      let messageToSend = '';
      if (sendMode === 'random') {
        const randomIndex = Math.floor(Math.random() * texts.length);
        messageToSend = texts[randomIndex];
        await sendMessage(session.client, contact, messageToSend, socket, stats, sessionId);
        sentCount++;
      } else {
        for (const text of texts) {
          if (!stats.isWarming) break;
          messageToSend = text;
          await sendMessage(session.client, contact, messageToSend, socket, stats, sessionId);
          sentCount++;
          const delay = randomDelay(delayMin, delayMax);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      
      const delay = randomDelay(delayMin, delayMax);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    stats.isWarming = false;
    messageStats.set(sessionId, stats);
    socket.emit('warming-completed', { sessionId, totalSent: sentCount });
  });

  async function sendMessage(client, contact, message, socket, stats, sessionId) {
    try {
      const formattedNumber = formatNumber(contact);
      await client.sendMessage(formattedNumber, message);
      
      stats.totalSent++;
      stats.history.unshift({
        contact,
        message: message.substring(0, 50),
        time: new Date().toISOString()
      });
      if (stats.history.length > 50) stats.history.pop();
      messageStats.set(sessionId, stats);
      
      socket.emit('stats-update', {
        totalSent: stats.totalSent,
        lastMessage: { contact, message: message.substring(0, 50), time: new Date().toISOString() }
      });
    } catch (error) {
      socket.emit('warning', { message: `Failed to send to ${contact}: ${error.message}` });
    }
  }

  socket.on('stop-warming', ({ sessionId }) => {
    const stats = messageStats.get(sessionId);
    if (stats) {
      stats.isWarming = false;
      messageStats.set(sessionId, stats);
    }
    socket.emit('warming-stopped', { sessionId });
  });

  socket.on('get-stats', ({ sessionId }) => {
    const stats = messageStats.get(sessionId) || { totalSent: 0, history: [] };
    socket.emit('stats-data', stats);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', sessions: sessions.size, timestamp: Date.now() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🔥 WhatsApp Warmer Cyberpunk running on port ${PORT}`);
});
