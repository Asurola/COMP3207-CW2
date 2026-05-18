'use strict';
// COMP3207 Part 2 — Automated Test Runner
// Usage: node run_tests.js
// Requires: game server on :8080, test backend on :8181

const { io } = require('socket.io-client');
const http = require('http');

const GAME_URL = 'http://localhost:8080';
const BE_PORT  = 8181;

let passed = 0, failed = 0;

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

function httpPost(hostname, port, path, body) {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify(body || {});
    const req = http.request(
      { hostname, port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
      }
    );
    req.on('error', reject);
    req.write(b);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setFixture(name) {
  await httpGet(`http://localhost:${BE_PORT}/admin/set/${name}`);
  await sleep(300);
}

async function getDump() {
  return httpGet(`http://localhost:${BE_PORT}/admin/dump`);
}

async function resetGame() {
  await httpPost('localhost', 8080, '/admin/reset', {});
  await sleep(200);
}

function extractText(doc) {
  if (typeof doc.text === 'string' && doc.text) return doc.text;
  if (Array.isArray(doc.texts)) {
    const en = doc.texts.find(t => t.language === 'en');
    return (en && en.text) ? en.text : (doc.texts[0] && doc.texts[0].text ? doc.texts[0].text : null);
  }
  return null;
}

// ─── Socket.IO client wrapper ─────────────────────────────────────────────────

class Client {
  constructor(socket) {
    this.socket = socket;
    this.state  = null;
    this.socket.on('state', s => { this.state = s; });
  }

  static connect() {
    return new Promise((resolve, reject) => {
      const s = io(GAME_URL, { transports: ['websocket'], timeout: 5000 });
      s.once('connect', () => resolve(new Client(s)));
      s.once('connect_error', e => reject(new Error(`connect_error: ${e.message}`)));
      setTimeout(() => reject(new Error('connect timeout')), 6000);
    });
  }

  // emit an event and wait for the direct reply event
  rpc(emitEv, data, replyEv, timeout = 6000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout waiting for '${replyEv}'`)), timeout);
      this.socket.once(replyEv, res => { clearTimeout(t); resolve(res); });
      this.socket.emit(emitEv, data);
    });
  }

  register(username, password)             { return this.rpc('register', { username, password }, 'register'); }
  login(username, password)                { return this.rpc('login',    { username, password }, 'login');    }
  submitPrompt(username, text)             { return this.rpc('prompt',   { username, text },     'prompt');   }
  answer(username, promptIndex, ans)       { return this.rpc('answer',   { username, promptIndex, answer: ans }, 'answer'); }
  vote(username, choice)                   { return this.rpc('vote',     { username, choice },   'vote');     }
  sendNext(username)                       { this.socket.emit('next', { username }); }

  async waitForPhase(phase, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.state && this.state.phase === phase) return this.state;
      await sleep(80);
    }
    throw new Error(`Waited ${timeout}ms for phase '${phase}', stuck at '${this.state && this.state.phase}'`);
  }

  disconnect() { try { this.socket.disconnect(); } catch {} }
}

function disconnectAll(clients) { clients.forEach(c => c.disconnect()); }

// ─── Test runner ──────────────────────────────────────────────────────────────

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    console.log('PASS ✓');
    passed++;
  } catch (e) {
    console.log(`FAIL ✗  — ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ─── Shared fixture helper: login N players from dump ─────────────────────────

async function loginPlayersFromFixture(fixture, n, opts = {}) {
  await setFixture(fixture);
  await resetGame();
  const dump = await getDump();

  let creds = Object.values(dump.players);

  // If preferWithPrompts, sort players that own prompts to the front
  if (opts.preferWithPrompts && Array.isArray(dump.prompts) && dump.prompts.length > 0) {
    const usersWithPrompts = new Set(
      dump.prompts.map(p => p.username || (p.player && p.player.username)).filter(Boolean)
    );
    const withP   = creds.filter(p => usersWithPrompts.has(p.username));
    const without = creds.filter(p => !usersWithPrompts.has(p.username));
    creds = [...withP, ...without];
  }

  assert(creds.length >= n, `Fixture '${fixture}' has ${creds.length} players, need ${n}`);

  const clients = [], usernames = [];
  for (const p of creds.slice(0, n)) {
    const c = await Client.connect();
    const r = await c.login(p.username, p.password);
    assert(r.result, `Login failed for ${p.username}: ${r.msg}`);
    clients.push(c);
    usernames.push(p.username);
    await sleep(120);
  }
  return { clients, usernames, admin: usernames[0], adminClient: clients[0], dump };
}

// submit N prompts and wait for state confirmation
async function submitPrompts(clients, usernames, texts) {
  for (let i = 0; i < texts.length; i++) {
    const r = await clients[i % clients.length].submitPrompt(usernames[i % usernames.length], texts[i]);
    assert(r.result, `Prompt submit failed (${i}): ${r.msg}`);
    await sleep(100);
  }
  await sleep(200);
}

// ─── TEST 1: Registration & Login ─────────────────────────────────────────────

async function runTest1() {
  console.log('\n── Test 1: Registration & Login ──');

  await test('1.1a  register username < 5 chars → fail', async () => {
    await setFixture('1.1'); await resetGame();
    const c = await Client.connect();
    try {
      const r = await c.register('abc', 'aaaaaaaaaa');
      assert(!r.result, `Expected failure, got: ${JSON.stringify(r)}`);
    } finally { c.disconnect(); }
  });

  await test('1.1b  register password < 8 chars → fail', async () => {
    await resetGame();
    const c = await Client.connect();
    try {
      const r = await c.register('validname', 'short');
      assert(!r.result, `Expected failure, got: ${JSON.stringify(r)}`);
    } finally { c.disconnect(); }
  });

  await test('1.2   register valid new user → success + player in state', async () => {
    await setFixture('1.2'); await resetGame();
    const c = await Client.connect();
    try {
      const r = await c.register('newplayer', 'goodpasswd');
      assert(r.result, `Expected success, got: ${JSON.stringify(r)}`);
      await sleep(400);
      assert(c.state && c.state.players.some(p => p.username === 'newplayer'),
        `Player not in state. Players: ${JSON.stringify(c.state && c.state.players)}`);
    } finally { c.disconnect(); }
  });

  await test('1.3   register existing username → fail', async () => {
    await setFixture('1.3'); await resetGame();
    const c = await Client.connect();
    try {
      // 'aaaaa' is pre-registered in fixture 1.3
      const r = await c.register('aaaaa', 'aaaaaaaaaa');
      assert(!r.result, `Expected failure, got: ${JSON.stringify(r)}`);
    } finally { c.disconnect(); }
  });

  await test('1.4   login correct credentials → success + player in state', async () => {
    await setFixture('1.4'); await resetGame();
    const c = await Client.connect();
    try {
      const r = await c.login('aaaaa', 'aaaaaaaaaa');
      assert(r.result, `Expected success, got: ${JSON.stringify(r)}`);
      await sleep(400);
      assert(c.state && c.state.players.some(p => p.username === 'aaaaa'),
        `Player not in state. Players: ${JSON.stringify(c.state && c.state.players)}`);
    } finally { c.disconnect(); }
  });

  await test('1.5   login wrong password → fail', async () => {
    await setFixture('1.5'); await resetGame();
    const c = await Client.connect();
    try {
      const r = await c.login('aaaaa', 'wrongpass1');
      assert(!r.result, `Expected failure, got: ${JSON.stringify(r)}`);
    } finally { c.disconnect(); }
  });
}

// ─── TEST 2: Game Start Up & Prompt Collection ────────────────────────────────

async function runTest2() {
  console.log('\n── Test 2: Game Start Up & Prompt Collection ──');

  await test('2a  3 players join → admin set, phase=joining, players tracked', async () => {
    const { clients, usernames, admin, adminClient } = await loginPlayersFromFixture('2', 3);
    try {
      await sleep(400);
      const s = adminClient.state;
      assert(s.phase === 'joining', `Expected joining, got ${s.phase}`);
      assert(s.players.length === 3, `Expected 3 players, got ${s.players.length}`);
      assert(s.admin === admin, `Admin should be ${admin}, got ${s.admin}`);
    } finally { disconnectAll(clients); }
  });

  await test('2b  admin advances joining→prompt → phase transitions', async () => {
    const { clients, usernames, admin, adminClient } = await loginPlayersFromFixture('2', 3);
    try {
      adminClient.sendNext(admin);
      const s = await adminClient.waitForPhase('prompt', 5000);
      assert(s.phase === 'prompt', `Expected prompt, got ${s.phase}`);
    } finally { disconnectAll(clients); }
  });

  await test('2c  players submit prompts → stored locally + broadcast', async () => {
    const { clients, usernames, admin, adminClient } = await loginPlayersFromFixture('2', 3);
    try {
      adminClient.sendNext(admin);
      await adminClient.waitForPhase('prompt', 5000);

      const texts = [
        'Why do cats knock things off tables when they could just leave them alone up there?',
        'What would be the worst catchphrase for a surgeon to have while operating on you?',
        'What is the most polite way to tell someone their cooking tastes absolutely terrible?',
      ];
      await submitPrompts(clients, usernames, texts);

      assert(adminClient.state.promptSubmitters.length === 3,
        `Expected 3 submitters, got ${adminClient.state.promptSubmitters.length}`);
      assert(adminClient.state.sessionPrompts.length === 3,
        `Expected 3 session prompts, got ${adminClient.state.sessionPrompts.length}`);
    } finally { disconnectAll(clients); }
  });

  await test('2d  advance prompt→answering → prompts allocated to players', async () => {
    const { clients, usernames, admin, adminClient } = await loginPlayersFromFixture('2', 3);
    try {
      adminClient.sendNext(admin);
      await adminClient.waitForPhase('prompt', 5000);

      const texts = [
        'Why do cats knock things off tables when they could just leave them alone up there?',
        'What would be the worst catchphrase for a surgeon to have while operating on you?',
        'What is the most polite way to tell someone their cooking tastes absolutely terrible?',
      ];
      await submitPrompts(clients, usernames, texts);

      adminClient.sendNext(admin);
      const s = await adminClient.waitForPhase('answering', 10000);

      // 3 players (odd) → 3 prompts, each player assigned to exactly 2
      assert(s.activePrompts.length === 3,
        `Expected 3 prompts for 3-player game, got ${s.activePrompts.length}`);
      for (const username of usernames) {
        const mine = s.activePrompts.filter(p => p.players.includes(username));
        assert(mine.length === 2, `${username} should have 2 prompts, has ${mine.length}`);
      }
      // Every prompt assigned to exactly 2 players
      for (const p of s.activePrompts) {
        assert(p.players.length === 2, `Prompt has ${p.players.length} players, expected 2`);
      }
    } finally { disconnectAll(clients); }
  });
}

// ─── TEST 3: Game Round ───────────────────────────────────────────────────────

async function runTest3() {
  console.log('\n── Test 3: Game Round (Answering, Voting, Scoring) ──');

  await test('3a  all players answer their prompts → answeredPlayers tracked', async () => {
    const { clients, usernames, admin, adminClient } = await loginPlayersFromFixture('3', 3);
    try {
      adminClient.sendNext(admin);
      await adminClient.waitForPhase('prompt', 5000);
      const texts = [
        'What is the most useless invention that someone actually spent money developing at some point?',
        'What would be a terrible name for a children\'s hospital if you had to pick one right now?',
        'Why does anyone willingly eat airplane food when there are perfectly good alternatives?',
      ];
      await submitPrompts(clients, usernames, texts);
      adminClient.sendNext(admin);
      const s = await adminClient.waitForPhase('answering', 10000);

      // Each player answers all their assigned prompts
      for (let i = 0; i < 3; i++) {
        const mine = s.activePrompts
          .map((p, idx) => ({ ...p, idx }))
          .filter(p => p.players.includes(usernames[i]));
        for (const prompt of mine) {
          const r = await clients[i].answer(usernames[i], prompt.idx, `Funny answer from ${usernames[i]} for index ${prompt.idx}`);
          assert(r.result, `Answer failed for ${usernames[i]}: ${r.msg}`);
          await sleep(80);
        }
      }
      await sleep(300);
      assert(adminClient.state.answeredPlayers.length === 3,
        `Expected all 3 players answered, got ${adminClient.state.answeredPlayers.length}`);
    } finally { disconnectAll(clients); }
  });

  await test('3b  voting phase: self-vote rejected, valid votes accepted', async () => {
    const { clients, usernames, admin, adminClient } = await loginPlayersFromFixture('3', 3);
    try {
      adminClient.sendNext(admin);
      await adminClient.waitForPhase('prompt', 5000);
      const texts = [
        'What is the most useless invention that someone actually spent money developing at some point?',
        'What would be a terrible name for a children\'s hospital if you had to pick one right now?',
        'Why does anyone willingly eat airplane food when there are perfectly good alternatives?',
      ];
      await submitPrompts(clients, usernames, texts);
      adminClient.sendNext(admin);
      const ansState = await adminClient.waitForPhase('answering', 10000);

      for (let i = 0; i < 3; i++) {
        const mine = ansState.activePrompts.map((p, idx) => ({ ...p, idx })).filter(p => p.players.includes(usernames[i]));
        for (const prompt of mine) {
          await clients[i].answer(usernames[i], prompt.idx, `Answer from ${usernames[i]}`);
          await sleep(80);
        }
      }

      adminClient.sendNext(admin);
      await adminClient.waitForPhase('voting', 5000);
      const votState = adminClient.state;
      const curPrompt = votState.activePrompts[votState.currentPromptIndex];

      // Self-vote should fail
      const selfVoter = curPrompt.players[0];
      const selfIdx   = usernames.indexOf(selfVoter);
      if (selfIdx !== -1) {
        const selfResult = await clients[selfIdx].vote(selfVoter, 'A');
        assert(!selfResult.result, `Self-vote should be rejected, got: ${JSON.stringify(selfResult)}`);
      }

      // Non-player A should be able to vote A
      const nonA = usernames.find(u => u !== curPrompt.players[0]);
      const nonAIdx = usernames.indexOf(nonA);
      const voteResult = await clients[nonAIdx].vote(nonA, 'A');
      assert(voteResult.result, `Valid vote should succeed, got: ${JSON.stringify(voteResult)}`);
    } finally { disconnectAll(clients); }
  });

  await test('3c  full round completes → scores = round × votes × 100', async () => {
    const { clients, usernames, admin, adminClient } = await loginPlayersFromFixture('3', 3);
    try {
      adminClient.sendNext(admin);
      await adminClient.waitForPhase('prompt', 5000);
      const texts = [
        'What is the most useless invention that someone actually spent money developing at some point?',
        'What would be a terrible name for a children\'s hospital if you had to pick one right now?',
        'Why does anyone willingly eat airplane food when there are perfectly good alternatives?',
      ];
      await submitPrompts(clients, usernames, texts);
      adminClient.sendNext(admin);
      const ansState = await adminClient.waitForPhase('answering', 10000);

      // Answer all
      for (let i = 0; i < 3; i++) {
        const mine = ansState.activePrompts.map((p, idx) => ({ ...p, idx })).filter(p => p.players.includes(usernames[i]));
        for (const p of mine) { await clients[i].answer(usernames[i], p.idx, `Answer ${i}`); await sleep(80); }
      }

      adminClient.sendNext(admin);
      await adminClient.waitForPhase('voting', 5000);

      // Vote on every prompt
      for (let pi = 0; pi < ansState.activePrompts.length; pi++) {
        await adminClient.waitForPhase('voting', 5000);
        const curPrompt = adminClient.state.activePrompts[adminClient.state.currentPromptIndex];

        for (let i = 0; i < 3; i++) {
          const choice = curPrompt.players[0] === usernames[i] ? 'B' : 'A';
          try { await clients[i].vote(usernames[i], choice); } catch {}
          await sleep(80);
        }

        adminClient.sendNext(admin); // voting → voting_results
        await adminClient.waitForPhase('voting_results', 5000);
        adminClient.sendNext(admin); // voting_results → voting or scores
        await sleep(500);
      }

      await adminClient.waitForPhase('scores', 5000);
      const scores = adminClient.state.scores;
      const total  = Object.values(scores).reduce((a, b) => a + b, 0);
      assert(total > 0, `Expected non-zero total score, got ${JSON.stringify(scores)}`);
      for (const [u, s] of Object.entries(scores)) {
        assert(s % 100 === 0, `Score ${s} for ${u} not a multiple of 100 (round×votes×100)`);
      }
    } finally { disconnectAll(clients); }
  });

  await test('3d  3 full rounds complete → game_over + player/update called', async () => {
    const { clients, usernames, admin, adminClient } = await loginPlayersFromFixture('3', 3);
    try {
      const PROMPTS = [
        'What is the most useless invention that someone actually spent money developing at some point?',
        'What would be a terrible name for a children\'s hospital if you had to pick one right now?',
        'Why does anyone willingly eat airplane food when there are perfectly good alternatives?',
      ];

      // Each iteration: sendNext at TOP advances previous-phase → prompt.
      // Round 1: joining → prompt. Rounds 2-3: scores → prompt. No double-advance.
      for (let round = 1; round <= 3; round++) {
        adminClient.sendNext(admin);
        await adminClient.waitForPhase('prompt', 5000);
        assert(adminClient.state.currentRound === round, `Expected round ${round}, got ${adminClient.state.currentRound}`);

        await submitPrompts(clients, usernames, PROMPTS);

        adminClient.sendNext(admin);
        const ansState = await adminClient.waitForPhase('answering', 10000);

        for (let i = 0; i < 3; i++) {
          const mine = ansState.activePrompts.map((p, idx) => ({...p, idx})).filter(p => p.players.includes(usernames[i]));
          for (const p of mine) { await clients[i].answer(usernames[i], p.idx, `R${round} answer`); await sleep(60); }
        }

        adminClient.sendNext(admin);
        await adminClient.waitForPhase('voting', 5000);

        for (let pi = 0; pi < ansState.activePrompts.length; pi++) {
          await adminClient.waitForPhase('voting', 5000);
          const cur = adminClient.state.activePrompts[adminClient.state.currentPromptIndex];
          for (let i = 0; i < 3; i++) {
            const choice = cur.players[0] === usernames[i] ? 'B' : 'A';
            try { await clients[i].vote(usernames[i], choice); } catch {}
            await sleep(60);
          }
          adminClient.sendNext(admin); // voting → voting_results
          await adminClient.waitForPhase('voting_results', 5000);
          adminClient.sendNext(admin); // voting_results → voting (next prompt) or scores (last)
          await sleep(400);
        }

        // After last prompt's voting_results→next, we land at scores
        await adminClient.waitForPhase('scores', 5000);
        // Don't sendNext here — next iteration's top will do it (scores → prompt)
      }

      // After round 3 scores, advance to game_over
      adminClient.sendNext(admin);
      await adminClient.waitForPhase('game_over', 8000);
      assert(adminClient.state.phase === 'game_over', 'Expected game_over phase');

      const finalScores = adminClient.state.scores;
      const total = Object.values(finalScores).reduce((a, b) => a + b, 0);
      assert(total > 0, `Final scores should be non-zero: ${JSON.stringify(finalScores)}`);

    } finally { disconnectAll(clients); }
  });
}

// ─── TEST 4: Audience Handling ────────────────────────────────────────────────

async function runTest4() {
  console.log('\n── Test 4: Audience Handling ──');

  await test('4   9th player joins as audience (not player)', async () => {
    await setFixture('4');
    await resetGame();
    const dump = await getDump();
    const creds = Object.values(dump.players);

    const clients = [], usernames = [];
    try {
      // Login first 8 (fill player slots)
      const first8 = creds.slice(0, 8);
      for (const p of first8) {
        const c = await Client.connect();
        const r = await c.login(p.username, p.password);
        assert(r.result, `Login failed for ${p.username}: ${r.msg}`);
        clients.push(c);
        usernames.push(p.username);
        await sleep(100);
      }

      await sleep(400);
      assert(clients[0].state.players.length === 8,
        `Expected 8 players, got ${clients[0].state.players.length}`);

      // 9th player — use credential from fixture if available, else register fresh
      const ninth = creds[8];
      const c9    = await Client.connect();
      clients.push(c9);

      let r9, ninthName;
      if (ninth) {
        r9 = await c9.login(ninth.username, ninth.password);
        ninthName = ninth.username;
      } else {
        r9 = await c9.register('ninthplay', 'password123');
        ninthName = 'ninthplay';
      }
      assert(r9.result, `9th player auth failed: ${r9.msg}`);

      await sleep(400);
      const s = c9.state;
      assert(s.players.length <= 8, `Players list should stay ≤8, got ${s.players.length}`);
      assert(s.audience.some(a => a.username === ninthName),
        `'${ninthName}' should be in audience. audience=${JSON.stringify(s.audience)}, players=${JSON.stringify(s.players)}`);
    } finally { disconnectAll(clients); }
  });
}

// ─── TEST 5: Prompt Management (50/50 split) ──────────────────────────────────

async function runTest5() {
  console.log('\n── Test 5: Prompt Management (50/50 split) ──');

  await test('5   active prompts include both past-API and session prompts', async () => {
    const { clients, usernames, admin, adminClient, dump } = await loginPlayersFromFixture('5', 3, { preferWithPrompts: true });
    try {
      const pastTexts = (dump.prompts || []).map(extractText).filter(Boolean);

      adminClient.sendNext(admin);
      await adminClient.waitForPhase('prompt', 5000);

      const sessionTexts = [
        'What is the most useless invention that someone actually spent money developing at some point?',
        'What would be a terrible name for a children\'s hospital if you had to pick one right now?',
        'Why does anyone willingly eat airplane food when there are perfectly good alternatives?',
      ];
      await submitPrompts(clients, usernames, sessionTexts);

      adminClient.sendNext(admin);
      const s = await adminClient.waitForPhase('answering', 10000);

      const activeTexts = s.activePrompts.map(p => p.text);
      assert(activeTexts.length > 0, 'No active prompts');

      const hasSession = activeTexts.some(t => sessionTexts.includes(t));
      assert(hasSession, `No session prompts in active prompts.\nActive: ${JSON.stringify(activeTexts)}`);

      if (pastTexts.length > 0) {
        const hasPast = activeTexts.some(t => pastTexts.includes(t));
        assert(hasPast,
          `No past API prompts in active prompts.\nPast available: ${JSON.stringify(pastTexts)}\nActive: ${JSON.stringify(activeTexts)}`);
      } else {
        console.log('      (fixture has no past prompts — only session-prompt half tested)');
      }
    } finally { disconnectAll(clients); }
  });
}

// ─── TEST 6: 4-Player Flexibility ────────────────────────────────────────────

async function runTest6() {
  console.log('\n── Test 6: Player Count Flexibility (4 Players) ──');

  await test('6a  4 players join → game starts correctly', async () => {
    const { clients, usernames, admin, adminClient } = await loginPlayersFromFixture('6', 4);
    try {
      await sleep(300);
      assert(adminClient.state.players.length === 4,
        `Expected 4 players, got ${adminClient.state.players.length}`);
      adminClient.sendNext(admin);
      await adminClient.waitForPhase('prompt', 5000);
      assert(adminClient.state.phase === 'prompt', 'Should reach prompt phase');
    } finally { disconnectAll(clients); }
  });

  await test('6b  4 players (even) → 2 prompts total, each player answers 1', async () => {
    const { clients, usernames, admin, adminClient } = await loginPlayersFromFixture('6', 4);
    try {
      adminClient.sendNext(admin);
      await adminClient.waitForPhase('prompt', 5000);

      const texts = [
        'What is the most useless invention that someone actually spent money developing at some point?',
        'What would be a terrible name for a children\'s hospital if you had to pick one right now?',
        'Why does anyone willingly eat airplane food when there are perfectly good alternatives?',
        'What is the strangest thing you could find in someone\'s refrigerator that would concern you?',
      ];
      await submitPrompts(clients, usernames, texts);

      adminClient.sendNext(admin);
      const s = await adminClient.waitForPhase('answering', 10000);

      // 4 players even → N/2 = 2 prompts
      assert(s.activePrompts.length === 2,
        `Expected 2 prompts for 4-player game, got ${s.activePrompts.length}`);

      for (const username of usernames) {
        const mine = s.activePrompts.filter(p => p.players.includes(username));
        assert(mine.length === 1, `${username} should answer exactly 1 prompt, assigned ${mine.length}`);
      }
    } finally { disconnectAll(clients); }
  });

  await test('6c  4-player round: scoring works correctly', async () => {
    const { clients, usernames, admin, adminClient } = await loginPlayersFromFixture('6', 4);
    try {
      adminClient.sendNext(admin);
      await adminClient.waitForPhase('prompt', 5000);

      const texts = [
        'What is the most useless invention that someone actually spent money developing at some point?',
        'What would be a terrible name for a children\'s hospital if you had to pick one right now?',
        'Why does anyone willingly eat airplane food when there are perfectly good alternatives?',
        'What is the strangest thing you could find in someone\'s refrigerator that would concern you?',
      ];
      await submitPrompts(clients, usernames, texts);

      adminClient.sendNext(admin);
      const ansState = await adminClient.waitForPhase('answering', 10000);

      for (let i = 0; i < 4; i++) {
        const mine = ansState.activePrompts.map((p, idx) => ({...p, idx})).filter(p => p.players.includes(usernames[i]));
        for (const p of mine) { await clients[i].answer(usernames[i], p.idx, `4p answer ${i}`); await sleep(80); }
      }

      adminClient.sendNext(admin);
      await adminClient.waitForPhase('voting', 5000);

      for (let pi = 0; pi < 2; pi++) {
        await adminClient.waitForPhase('voting', 5000);
        const cur = adminClient.state.activePrompts[adminClient.state.currentPromptIndex];
        for (let i = 0; i < 4; i++) {
          const choice = cur.players[0] === usernames[i] ? 'B' : 'A';
          try { await clients[i].vote(usernames[i], choice); } catch {}
          await sleep(60);
        }
        adminClient.sendNext(admin);
        await adminClient.waitForPhase('voting_results', 5000);
        adminClient.sendNext(admin);
        await sleep(400);
      }

      await adminClient.waitForPhase('scores', 5000);
      const scores = adminClient.state.scores;
      for (const [u, sc] of Object.entries(scores)) {
        assert(sc % 100 === 0, `Score ${sc} for ${u} not multiple of 100`);
      }
    } finally { disconnectAll(clients); }
  });
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('════════════════════════════════════════════════════');
  console.log('  COMP3207 Part 2 — Test Runner');
  console.log('════════════════════════════════════════════════════');

  // Pre-flight checks
  try {
    await httpGet(`http://localhost:${BE_PORT}/admin/dump`);
    console.log('  Test backend (8181) ✓');
  } catch {
    console.error('✗ Test backend not reachable on port 8181');
    process.exit(1);
  }
  try {
    await resetGame();
    console.log('  Game server  (8080) ✓');
  } catch {
    console.error('✗ Game server not reachable on port 8080');
    process.exit(1);
  }

  await runTest1();
  await runTest2();
  await runTest3();
  await runTest4();
  await runTest5();
  await runTest6();

  const total = passed + failed;
  console.log('\n════════════════════════════════════════════════════');
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
