'use strict';
/* End-to-end test: starts the real server, connects bots over HTTP + SSE and plays hands. */
const assert = require('assert');
const { createApp } = require('../server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = (c) => c.repeat(20);

async function post(base, path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
}

async function openStream(base, room, token, onState) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events?room=${room}&token=${token}`, { signal: ac.signal });
  assert.strictEqual(res.status, 200, 'SSE opens');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block), data = /^data: (.+)$/m.exec(block);
          if (ev && ev[1] === 'state' && data) onState(JSON.parse(data[1]));
        }
      }
    } catch { /* aborted */ }
  })();
  return { close: () => ac.abort() };
}

(async () => {
  const app = createApp({
    noPersist: true,
    timing: { runout: 15, showdown: 50, uncontested: 25, nextHand: 25, disconnect: 400 },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  // ---- static + health
  let r = await fetch(base + '/healthz'); assert.strictEqual(r.status, 200);
  r = await fetch(base + '/../server.js'); assert.notStrictEqual(r.status, 200, 'no path traversal');
  r = await fetch(base + '/%2e%2e/server.js'); assert.notStrictEqual(r.status, 200, 'no encoded path traversal');
  console.log('ok  health check and path traversal blocked');

  // ---- create / join validation
  const A = tok('a'), B = tok('b'), C = tok('c');
  let res = await post(base, '/api/join', { token: 'short', name: 'x', create: true });
  assert.strictEqual(res.status, 400);
  res = await post(base, '/api/join', { token: A, name: '   ', create: true });
  assert.strictEqual(res.status, 400, 'empty name rejected');
  res = await post(base, '/api/join', { token: A, name: 'Alice', create: true, bb: 20, startStack: 1000, turnSeconds: 45 });
  assert(res.ok && /^[A-Z2-9]{4}$/.test(res.room), 'room created');
  const code = res.room;
  res = await post(base, '/api/join', { token: B, name: 'alice', room: code });
  assert.strictEqual(res.status, 409, 'duplicate name rejected');
  res = await post(base, '/api/join', { token: B, name: 'Bob', room: 'ZZZZ' });
  assert.strictEqual(res.status, 404, 'unknown room');
  res = await post(base, '/api/join', { token: B, name: 'Bob', room: code.toLowerCase() });
  assert(res.ok, 'room codes are case-insensitive');
  res = await post(base, '/api/join', { token: C, name: 'Cara', room: code });
  assert(res.ok);
  const info = await (await fetch(`${base}/api/room?code=${code}`)).json();
  assert.deepStrictEqual(info.players, ['Alice', 'Bob', 'Cara']);
  console.log('ok  room creation and join validation');

  // ---- streams + bots
  const states = {};
  const sent = new Set();
  let privacyChecks = 0;
  let handsSeen = 0, lastHand = 0;
  const botFor = (token) => async (st) => {
    states[token] = st;
    // privacy: never see another player's cards unless it is a revealed showdown
    const t = st.table;
    for (const s of t.seats) {
      if (!s || s.isYou || !s.cards.length) continue;
      const hidden = s.cards.every((c) => c === '??');
      if (t.phase !== 'showdown' || !t.result || !t.result.contested) assert(hidden, 'opponent cards leaked');
      privacyChecks++;
    }
    if (token === A && t.phase === 'showdown' && t.handNo !== lastHand) { lastHand = t.handNo; handsSeen++; }
    if (t.actor >= 0 && t.actor === st.you && t.legal && !t.runout) {
      const key = `${token}:${t.handNo}:${t.phase}:${t.currentBet}:${t.seats[t.actor].chips}`;
      if (sent.has(key)) return;
      sent.add(key);
      const lg = t.legal;
      const roll = Math.random();
      let action = 'call', amount;
      if (roll < 0.1) action = 'fold';
      else if (roll < 0.5) action = lg.canCheck ? 'check' : 'call';
      else if (roll < 0.85 && lg.canRaise) { action = 'raise'; amount = Math.floor(lg.minRaiseTo + Math.random() * (lg.maxRaiseTo - lg.minRaiseTo) * 0.3); }
      else if (lg.canRaise && Math.random() < 0.3) action = 'allin';
      const rr = await post(base, '/api/action', { token, room: code, action, amount });
      assert(rr.ok, `bot action rejected: ${JSON.stringify(rr)} ${action} ${amount}`);
    }
    // rebuy if broke between hands
    const me = t.seats[st.you];
    if (me && me.chips === 0 && t.phase === 'showdown') {
      const key = `rebuy:${token}:${t.handNo}`;
      if (!sent.has(key)) { sent.add(key); await post(base, '/api/rebuy', { token, room: code }); }
    }
  };

  const sA = await openStream(base, code, A, botFor(A));
  const sB = await openStream(base, code, B, botFor(B));
  let sC = await openStream(base, code, C, botFor(C));
  await sleep(150);
  assert(states[A] && states[A].you >= 0, 'received state');
  assert.strictEqual(states[A].started, false);

  // only the host may start
  res = await post(base, '/api/start', { token: B, room: code });
  assert.strictEqual(res.ok, false, 'non-host cannot start');
  // out-of-turn action rejected before game starts
  res = await post(base, '/api/action', { token: B, room: code, action: 'fold' });
  assert.strictEqual(res.ok, false);
  res = await post(base, '/api/action', { token: 'z'.repeat(20), room: code, action: 'fold' });
  assert.strictEqual(res.status, 404, 'stranger rejected');

  // chat
  res = await post(base, '/api/chat', { token: B, room: code, text: 'hello <b>table</b>' });
  assert(res.ok);
  await sleep(100);
  assert.strictEqual(states[A].chat.at(-1).from, 'Bob');
  assert.strictEqual(states[A].chat.at(-1).text, 'hello <b>table</b>', 'raw text stored; client must escape');
  console.log('ok  streams, host-only start, rejected strangers, chat');

  res = await post(base, '/api/start', { token: A, room: code });
  assert(res.ok, 'host starts the game');

  // ---- play
  const deadline = Date.now() + 90000;
  let reconnected = false;
  while (handsSeen < 25 && Date.now() < deadline) {
    await sleep(50);
    // mid-game: Cara loses her connection and comes back
    if (!reconnected && handsSeen >= 5) {
      reconnected = true;
      sC.close();
      await sleep(120);
      assert.strictEqual(app.rooms.get(code).table.player(C).connected, false, 'disconnect detected');
      sC = await openStream(base, code, C, botFor(C));
      await sleep(120);
      assert.strictEqual(app.rooms.get(code).table.player(C).connected, true, 'reconnect restores seat');
    }
  }
  assert(handsSeen >= 25, `only ${handsSeen} hands completed in time`);
  console.log(`ok  played ${handsSeen} hands over HTTP/SSE (${privacyChecks} privacy checks), reconnect works`);

  // ---- leaderboard is zero-sum and counts hands
  const lb = await (await fetch(base + '/api/leaderboard')).json();
  assert(lb.ok && lb.rows.length === 3);
  assert.strictEqual(lb.rows.reduce((s, x) => s + x.net, 0), 0, 'leaderboard nets sum to zero');
  assert(lb.rows.every((x) => x.hands >= 20), 'hands counted');
  console.log('ok  leaderboard: ' + lb.rows.map((x) => `${x.name} ${x.net >= 0 ? '+' : ''}${x.net} (${x.hands}h)`).join(', '));

  // ---- leave
  sA.close(); sB.close();
  res = await post(base, '/api/leave', { token: B, room: code });
  assert(res.ok);
  await sleep(200);
  assert.strictEqual(app.rooms.get(code).table.seatOf(B) === -1 || app.rooms.get(code).table.player(B).leaving, true, 'left player gone');
  const sAfter = states[C];
  assert(sAfter, 'remaining player still receives state');
  sC.close();
  console.log('ok  leaving the table');

  // ---- action timer: a player who never acts is auto-folded and sat out
  const app2 = createApp({ noPersist: true, timing: { runout: 15, showdown: 50, uncontested: 25, nextHand: 25, disconnect: 200, turnMs: 250 } });
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${app2.server.address().port}`;
  const j1 = await post(base2, '/api/join', { token: tok('d'), name: 'Dan', create: true, bb: 20, startStack: 1000 });
  await post(base2, '/api/join', { token: tok('e'), name: 'Eve', room: j1.room });
  const st = {};
  const sd = await openStream(base2, j1.room, tok('d'), (s) => { st.d = s; });
  const se = await openStream(base2, j1.room, tok('e'), (s) => { st.e = s; });
  await sleep(100);
  await post(base2, '/api/start', { token: tok('d'), room: j1.room });
  await sleep(900);
  const log = st.d.table.log.join('\n');
  assert(/ran out of time/.test(log), 'timeout logged');
  assert(st.d.table.seats.filter(Boolean).some((s) => s.sitOut), 'timed-out player is sitting out');
  sd.close(); se.close();
  await app2.close();
  console.log('ok  action timer auto-folds and sits out an idle player');

  await app.close();
  console.log('\nAll server tests passed.');
  process.exit(0);
})().catch((e) => {
  console.error('\nSERVER TEST FAILED:', e);
  process.exit(1);
});
