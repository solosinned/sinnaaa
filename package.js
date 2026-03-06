const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// ================== In‑memory data stores ==================
let users = [];               // { email, username, password, avatar, role }
let messages = [];            // { username, text, channel, timestamp, id, replyTo? }
let typing = {};              // { channel: [usernames] }
let muted = [];               // list of usernames
let banned = [];              // list of emails
let friends = {};             // { username: [friendUsername] }
let friendRequests = {};      // { username: [fromUsername] }
let notifications = {};       // { username: [ {type, from, read, timestamp} ] }

// ================== Initialise default data ==================
function initData() {
  // Ensure owner exists
  const ownerEmail = 'tokyosidz@gmail.com';
  const ownerUsername = 'TokyoSidz';
  const ownerPassword = 'soloissinned';

  const existingOwner = users.find(u => u.email === ownerEmail);
  if (!existingOwner) {
    users.push({
      email: ownerEmail,
      username: ownerUsername,
      password: ownerPassword,
      avatar: '👑',
      role: 'owner'
    });
  } else {
    existingOwner.password = ownerPassword;
    existingOwner.role = 'owner';
  }

  // Add a demo user if none exist
  if (!users.some(u => u.username === 'demo')) {
    users.push({
      email: 'demo@demo.com',
      username: 'demo',
      password: 'demo',
      avatar: '😀',
      role: 'user'
    });
  }

  // Add some initial messages
  if (messages.length === 0) {
    const now = Date.now();
    messages.push(
      { username: 'TokyoSidz', text: 'Welcome! I am the owner.', channel: 'general', timestamp: now - 3600000, id: '1' },
      { username: 'demo', text: 'Hey everyone!', channel: 'general', timestamp: now - 1800000, id: '2' }
    );
  }
}
initData();

// Helper to find user by username
function getUserByUsername(username) {
  return users.find(u => u.username === username);
}

// Helper to find user by email
function getUserByEmail(email) {
  return users.find(u => u.email === email);
}

// ================== Socket.io logic ==================
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  let currentUser = null;

  // --- Authentication ---
  socket.on('login', ({ email, password }) => {
    const user = users.find(u => u.email === email && u.password === password);
    if (!user) {
      socket.emit('login_error', 'Invalid email or password.');
      return;
    }
    if (banned.includes(email)) {
      socket.emit('login_error', 'This account has been banned.');
      return;
    }
    currentUser = user;
    socket.join(`user:${user.username}`);   // Private room for notifications
    socket.emit('login_success', { username: user.username, role: user.role, avatar: user.avatar });
    // Send initial data
    socket.emit('initial_messages', messages.filter(m => m.channel === 'general'));
    socket.emit('initial_users', users.map(u => ({ username: u.username, role: u.role, avatar: u.avatar, online: false }))); // online status handled separately
    socket.emit('initial_friends', friends[user.username] || []);
    socket.emit('initial_friend_requests', friendRequests[user.username] || []);
    socket.emit('initial_notifications', notifications[user.username] || []);
    // Broadcast user joined
    io.emit('user_joined', user.username);
  });

  socket.on('register', ({ email, username, password }) => {
    if (getUserByEmail(email) || getUserByUsername(username)) {
      socket.emit('register_error', 'Email or username already taken.');
      return;
    }
    const newUser = { email, username, password, avatar: '😀', role: 'user' };
    users.push(newUser);
    currentUser = newUser;
    socket.join(`user:${username}`);
    socket.emit('register_success', { username, role: 'user', avatar: '😀' });
    // Send initial data
    socket.emit('initial_messages', messages.filter(m => m.channel === 'general'));
    socket.emit('initial_users', users.map(u => ({ username: u.username, role: u.role, avatar: u.avatar, online: false })));
    socket.emit('initial_friends', []);
    socket.emit('initial_friend_requests', []);
    socket.emit('initial_notifications', []);
    io.emit('user_joined', username);
  });

  // --- Reconnect / page refresh ---
  socket.on('reconnect_user', (username) => {
    const user = getUserByUsername(username);
    if (user) {
      currentUser = user;
      socket.join(`user:${username}`);
      socket.emit('login_success', { username: user.username, role: user.role, avatar: user.avatar });
      socket.emit('initial_messages', messages.filter(m => m.channel === 'general'));
      socket.emit('initial_users', users.map(u => ({ username: u.username, role: u.role, avatar: u.avatar, online: false })));
      socket.emit('initial_friends', friends[username] || []);
      socket.emit('initial_friend_requests', friendRequests[username] || []);
      socket.emit('initial_notifications', notifications[username] || []);
      io.emit('user_joined', username);
    }
  });

  // --- Messaging ---
  socket.on('send_message', (msgData) => {
    if (!currentUser) return;
    if (muted.includes(currentUser.username)) {
      socket.emit('error', 'You are muted.');
      return;
    }
    const newMsg = {
      username: currentUser.username,
      text: msgData.text,
      channel: msgData.channel,
      timestamp: Date.now(),
      id: Date.now().toString() + Math.random().toString(36).substring(2),
      replyTo: msgData.replyTo
    };
    messages.push(newMsg);
    // Broadcast to everyone in that channel (including sender)
    io.emit('new_message', newMsg);

    // If it's a reply, notify the original author (if not yourself)
    if (msgData.replyTo) {
      const originalMsg = messages.find(m => m.id === msgData.replyTo);
      if (originalMsg && originalMsg.username !== currentUser.username) {
        addNotification(originalMsg.username, { type: 'reply', from: currentUser.username, read: false, timestamp: Date.now() });
        io.to(`user:${originalMsg.username}`).emit('new_notification', notifications[originalMsg.username]?.[0]);
      }
    }
  });

  // --- Typing ---
  socket.on('typing', ({ channel, isTyping }) => {
    if (!currentUser) return;
    if (!typing[channel]) typing[channel] = [];
    const idx = typing[channel].indexOf(currentUser.username);
    if (isTyping && idx === -1) typing[channel].push(currentUser.username);
    else if (!isTyping && idx !== -1) typing[channel].splice(idx, 1);
    // Broadcast typing status to everyone in that channel
    socket.broadcast.emit('typing_update', { channel, typing: typing[channel] || [] });
  });

  // --- Friend requests ---
  socket.on('send_friend_request', (targetUsername) => {
    if (!currentUser) return;
    if (targetUsername === currentUser.username) return;
    const target = getUserByUsername(targetUsername);
    if (!target) return;
    if (!friendRequests[targetUsername]) friendRequests[targetUsername] = [];
    if (friendRequests[targetUsername].includes(currentUser.username)) return;
    friendRequests[targetUsername].push(currentUser.username);
    addNotification(targetUsername, { type: 'friend_request', from: currentUser.username, read: false, timestamp: Date.now() });
    io.to(`user:${targetUsername}`).emit('new_friend_request', currentUser.username);
    io.to(`user:${targetUsername}`).emit('new_notification', notifications[targetUsername]?.[0]);
  });

  socket.on('accept_friend_request', (fromUsername) => {
    if (!currentUser) return;
    const from = getUserByUsername(fromUsername);
    if (!from) return;
    // Remove from requests
    if (friendRequests[currentUser.username]) {
      friendRequests[currentUser.username] = friendRequests[currentUser.username].filter(r => r !== fromUsername);
    }
    // Add to friends lists
    if (!friends[currentUser.username]) friends[currentUser.username] = [];
    if (!friends[fromUsername]) friends[fromUsername] = [];
    if (!friends[currentUser.username].includes(fromUsername)) friends[currentUser.username].push(fromUsername);
    if (!friends[fromUsername].includes(currentUser.username)) friends[fromUsername].push(currentUser.username);
    // Notify both
    io.to(`user:${currentUser.username}`).emit('friend_accepted', fromUsername);
    io.to(`user:${fromUsername}`).emit('friend_accepted', currentUser.username);
    addNotification(fromUsername, { type: 'friend_accept', from: currentUser.username, read: false, timestamp: Date.now() });
    io.to(`user:${fromUsername}`).emit('new_notification', notifications[fromUsername]?.[0]);
  });

  // --- Mute / Ban (admin/owner only) ---
  socket.on('mute_user', (targetUsername) => {
    if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'owner')) return;
    if (muted.includes(targetUsername)) {
      muted = muted.filter(u => u !== targetUsername);
    } else {
      muted.push(targetUsername);
    }
    io.emit('user_muted', { username: targetUsername, muted: muted.includes(targetUsername) });
  });

  socket.on('ban_user', (targetUsername) => {
    if (!currentUser || currentUser.role !== 'owner') return;
    const target = getUserByUsername(targetUsername);
    if (!target) return;
    banned.push(target.email);
    users = users.filter(u => u.username !== targetUsername);
    // Remove from friends/requests etc.
    delete friends[targetUsername];
    delete friendRequests[targetUsername];
    // Notify everyone
    io.emit('user_banned', targetUsername);
    // Force disconnect the banned user if online
    const sockets = Array.from(io.sockets.sockets.values());
    sockets.forEach(s => {
      if (s.currentUser && s.currentUser.username === targetUsername) {
        s.emit('banned');
        s.disconnect(true);
      }
    });
  });

  socket.on('make_admin', (targetUsername) => {
    if (!currentUser || currentUser.role !== 'owner') return;
    const target = getUserByUsername(targetUsername);
    if (target) {
      target.role = 'admin';
      io.emit('user_role_changed', { username: targetUsername, role: 'admin' });
    }
  });

  // --- Presence ---
  socket.on('presence', () => {
    if (currentUser) {
      io.emit('user_presence', { username: currentUser.username, online: true });
    }
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    if (currentUser) {
      io.emit('user_left', currentUser.username);
      // Clean up typing indicators
      for (const ch in typing) {
        const idx = typing[ch].indexOf(currentUser.username);
        if (idx !== -1) {
          typing[ch].splice(idx, 1);
          io.emit('typing_update', { channel: ch, typing: typing[ch] });
        }
      }
    }
  });
});

// Helper to add a notification
function addNotification(username, notif) {
  if (!notifications[username]) notifications[username] = [];
  notifications[username].unshift(notif);
  if (notifications[username].length > 50) notifications[username].pop();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});