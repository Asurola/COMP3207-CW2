'use strict';

const express = require('express');
const app = express();
const http = require('http');
const https = require('https');

const server = require('http').Server(app);
const io = require('socket.io')(server);

app.set('view engine', 'ejs');
app.use('/static', express.static('public'));

app.get('/', (req, res) => {
  res.render('client');
});
app.get('/display', (req, res) => {
  res.render('display');
});

const BACKEND_ENDPOINT = process.env.BACKEND || 'http://localhost:8181';

let state = {
  phase: 'joining',
  players: [],
  audience: [],
  admin: null,
  currentRound: 1,
  sessionPrompts: [],
  promptSubmitters: [],
  activePrompts: [],
  currentPromptIndex: 0,
  currentVoters: [],
  answeredPlayers: [],
  scores: {}
};

function broadcast() {
  io.emit('state', state);
}

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const base = new URL(BACKEND_ENDPOINT);
    const useHttps = base.protocol === 'https:';
    const mod = useHttps ? https : http;
    const bodyStr = body ? JSON.stringify(body) : '';
    const port = base.port ? parseInt(base.port) : (useHttps ? 443 : 80);

    const options = {
      hostname: base.hostname,
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };

    const req = mod.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON response')); }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Prompt documents from /utils/get store translations as texts:[{language,text}].
// The test backend may return a plain `text` string instead — handle both.
function extractPromptText(doc) {
  if (typeof doc.text === 'string' && doc.text) return doc.text;
  if (Array.isArray(doc.texts)) {
    const en = doc.texts.find(t => t.language === 'en');
    if (en && en.text) return en.text;
    if (doc.texts[0] && doc.texts[0].text) return doc.texts[0].text;
  }
  return null;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function allocatePrompts(players, prompts) {
  const shuffled = shuffle(players);
  const N = shuffled.length;
  const allocated = [];

  if (N % 2 === 0) {
    for (let i = 0; i < N / 2; i++) {
      const p1 = shuffled[i * 2].username;
      const p2 = shuffled[i * 2 + 1].username;
      const text = prompts[i % prompts.length];
      allocated.push({ text, players: [p1, p2], answers: { [p1]: '', [p2]: '' }, votes: { [p1]: 0, [p2]: 0 } });
    }
  } else {
    for (let i = 0; i < N; i++) {
      const p1 = shuffled[i].username;
      const p2 = shuffled[(i + 1) % N].username;
      const text = prompts[i % prompts.length];
      allocated.push({ text, players: [p1, p2], answers: { [p1]: '', [p2]: '' }, votes: { [p1]: 0, [p2]: 0 } });
    }
  }

  return allocated;
}

async function startAnswering() {
  const playerNames = state.players.map(p => p.username);
  const N = state.players.length;
  const needed = N % 2 === 0 ? N / 2 : N;

  let pastPrompts = [];
  try {
    const res = await apiRequest('GET', '/utils/get', { players: playerNames, tag_list: ['quiplash'] });
    if (Array.isArray(res)) {
      pastPrompts = res.map(extractPromptText).filter(Boolean);
    }
  } catch (e) {
    console.error('Failed to fetch past prompts:', e.message);
  }

  const half = Math.ceil(needed / 2);
  const fromPast = shuffle(pastPrompts).slice(0, half);
  const fromSession = shuffle(state.sessionPrompts).slice(0, needed - fromPast.length);
  let combined = [...fromPast, ...fromSession];

  if (combined.length < needed) {
    const remaining = shuffle([...pastPrompts, ...state.sessionPrompts]).filter(p => !combined.includes(p));
    combined = [...combined, ...remaining].slice(0, needed);
  }

  if (combined.length === 0) combined = ['What would make the worst name for a pet?'];
  while (combined.length < needed) combined = [...combined, ...combined];
  combined = combined.slice(0, needed);

  state.activePrompts = allocatePrompts(state.players, combined);
  state.answeredPlayers = [];
  state.currentPromptIndex = 0;
  state.phase = 'answering';
  broadcast();
}

function applyScores() {
  const prompt = state.activePrompts[state.currentPromptIndex];
  if (!prompt) return;
  const [p1, p2] = prompt.players;
  if (!state.scores[p1]) state.scores[p1] = 0;
  if (!state.scores[p2]) state.scores[p2] = 0;
  state.scores[p1] += state.currentRound * (prompt.votes[p1] || 0) * 100;
  state.scores[p2] += state.currentRound * (prompt.votes[p2] || 0) * 100;
  const pl1 = state.players.find(p => p.username === p1);
  const pl2 = state.players.find(p => p.username === p2);
  if (pl1) pl1.score = state.scores[p1];
  if (pl2) pl2.score = state.scores[p2];
}

async function advance(username) {
  if (state.admin !== username) return;

  switch (state.phase) {
    case 'joining':
      if (state.players.length < 3) return;
      state.phase = 'prompt';
      broadcast();
      break;

    case 'prompt':
      await startAnswering();
      break;

    case 'answering':
      state.currentPromptIndex = 0;
      state.currentVoters = [];
      state.phase = 'voting';
      broadcast();
      break;

    case 'voting':
      state.phase = 'voting_results';
      broadcast();
      break;

    case 'voting_results':
      applyScores();
      state.currentPromptIndex++;
      if (state.currentPromptIndex < state.activePrompts.length) {
        state.currentVoters = [];
        state.phase = 'voting';
      } else {
        state.phase = 'scores';
      }
      broadcast();
      break;

    case 'scores':
      if (state.currentRound < 3) {
        state.currentRound++;
        state.sessionPrompts = [];
        state.promptSubmitters = [];
        state.phase = 'prompt';
        broadcast();
      } else {
        state.phase = 'game_over';
        broadcast();
        for (const player of state.players) {
          try {
            await apiRequest('PUT', '/player/update', {
              username: player.username,
              add_to_games_played: 1,
              add_to_score: state.scores[player.username] || 0
            });
          } catch (e) {
            console.error('Failed to update player stats:', player.username, e.message);
          }
        }
      }
      break;
  }
}

function addToGame(socket, username) {
  const existingPlayer = state.players.find(p => p.username === username);
  if (existingPlayer) {
    existingPlayer.socketId = socket.id;
    return;
  }
  const existingAudience = state.audience.find(p => p.username === username);
  if (existingAudience) {
    existingAudience.socketId = socket.id;
    return;
  }

  if (state.phase === 'joining' && state.players.length < 8) {
    if (state.players.length === 0) state.admin = username;
    state.players.push({ username, socketId: socket.id, score: 0 });
    state.scores[username] = 0;
  } else {
    state.audience.push({ username, socketId: socket.id });
  }
}

io.on('connection', socket => {
  console.log('New connection:', socket.id);
  socket.emit('state', state);

  socket.on('register', async ({ username, password }) => {
    try {
      const res = await apiRequest('POST', '/player/register', { username, password });
      if (res.result) {
        addToGame(socket, username);
        socket.emit('register', { result: true, msg: res.msg });
        broadcast();
      } else {
        socket.emit('register', { result: false, msg: res.msg });
      }
    } catch (e) {
      socket.emit('register', { result: false, msg: 'Server error' });
    }
  });

  socket.on('login', async ({ username, password }) => {
    try {
      const res = await apiRequest('GET', '/player/login', { username, password });
      if (res.result) {
        addToGame(socket, username);
        socket.emit('login', { result: true, msg: res.msg });
        broadcast();
      } else {
        socket.emit('login', { result: false, msg: res.msg });
      }
    } catch (e) {
      socket.emit('login', { result: false, msg: 'Server error' });
    }
  });

  socket.on('prompt', async ({ username, text }) => {
    try {
      const res = await apiRequest('POST', '/prompt/create', { text, username, tags: ['quiplash'] });
      if (res.result) {
        state.sessionPrompts.push(text);
        if (!state.promptSubmitters.includes(username)) state.promptSubmitters.push(username);
        socket.emit('prompt', { result: true, msg: res.msg });
        broadcast();
      } else {
        socket.emit('prompt', { result: false, msg: res.msg });
      }
    } catch (e) {
      socket.emit('prompt', { result: false, msg: 'Server error' });
    }
  });

  socket.on('answer', ({ username, promptIndex, answer }) => {
    const prompt = state.activePrompts[promptIndex];
    if (!prompt || !prompt.players.includes(username)) {
      socket.emit('answer', { result: false, msg: 'Invalid prompt or player' });
      return;
    }
    prompt.answers[username] = answer;

    const myPrompts = state.activePrompts.filter(p => p.players.includes(username));
    const allDone = myPrompts.every(p => p.answers[username] && p.answers[username] !== '');
    if (allDone && !state.answeredPlayers.includes(username)) {
      state.answeredPlayers.push(username);
    }

    socket.emit('answer', { result: true, msg: 'OK' });
    broadcast();
  });

  socket.on('vote', ({ username, choice }) => {
    const prompt = state.activePrompts[state.currentPromptIndex];
    if (!prompt) {
      socket.emit('vote', { result: false, msg: 'No active prompt' });
      return;
    }
    if (state.currentVoters.includes(username)) {
      socket.emit('vote', { result: false, msg: 'Already voted' });
      return;
    }
    const votedFor = choice === 'A' ? prompt.players[0] : prompt.players[1];
    if (votedFor === username) {
      socket.emit('vote', { result: false, msg: 'Cannot vote for yourself' });
      return;
    }
    prompt.votes[votedFor]++;
    state.currentVoters.push(username);
    socket.emit('vote', { result: true, msg: 'OK' });
    broadcast();
  });

  socket.on('next', async ({ username }) => {
    await advance(username);
  });

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
  });
});

function startServer() {
  const PORT = process.env.PORT || 8080;
  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

if (module === require.main) {
  startServer();
}

module.exports = server;
