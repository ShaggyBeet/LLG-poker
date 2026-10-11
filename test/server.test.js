'use strict';
// End-to-end: boots the real server, plays a hand over HTTP + SSE, checks privacy and the leaderboard.
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3200 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${PORT}`;
const statsFile = path.join(os.tmpdir(), `poker-stats-${process.pid}.json`);
const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, STATS_FILE: statsFile }, stdio: 'ignore' });
const post = (cmd, body) => fetch(`${base}/api/${cmd}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function listen(room, pid) {
  const state = { last: null, chats: [] };
  const req = http.get(`${base}/api/events?room=${room}&pid=${pid}`, res => {
    res.setEncoding('utf8'); let buf = '';
    res.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const m = buf.slice(0, i); buf = buf.slice(i + 2);
        if (m.startsWith('data: ')) { const j = JSON.parse(m.slice(6)); if (j.t === 'state') state.last = j; else if (j.t === 'chat') state.chats.push(j); }
      }
    });
  });
  state.close = () => req.destroy();
  return state;
}

(async () => {
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/healthz`); break; } catch (e) { await sleep(100); } }
    const A = 'a'.repeat(20), B = 'b'.repeat(20);
    const c = await post('join', { pid: A, name: 'Alice', create: true, chips: 500, sb: 5 });
    assert(/^[A-Z]{4}$/.test(c.room), 'room code issued');
    const j = await post('join', { pid: B, name: 'Bob', room: c.room });
    assert.strictEqual(j.room, c.room);
    assert.strictEqual((await post('join', { pid: B, name: 'X', room: 'ZZZZ' })).status, 404, 'unknown table');
    const a = listen(c.room, A), b = listen(c.room, B);
    await sleep(300);
    assert.strictEqual((await post('start', { room: c.room, pid: B })).status, 400, 'only host starts');
    assert.strictEqual((await post('start', { room: c.room, pid: A })).status, 200);
    await sleep(300);

    // privacy: each player sees own cards, only card backs for the opponent
    const sa = a.last, sb = b.last;
    const meA = sa.players.find(p => p.id === sa.you), oppA = sa.players.find(p => p.id !== sa.you);
    assert.strictEqual(meA.cards.length, 2); assert(meA.cards.every(x => x >= 0));
    assert.deepStrictEqual(oppA.cards, [-1, -1]);
    assert(!JSON.stringify(sa).includes(B) && !JSON.stringify(sb).includes(A), 'secret ids never broadcast');

    // out-of-turn / illegal actions are rejected
    const actor = sa.toAct === sa.you ? A : B, other = actor === A ? B : A;
    assert.strictEqual((await post('act', { room: c.room, pid: other, a: 'fold' })).status, 400, 'not your turn');
    assert.strictEqual((await post('act', { room: c.room, pid: actor, a: 'check' })).status, 400, 'cannot check facing a bet');

    // chat
    await post('chat', { room: c.room, pid: A, text: 'hi <b>there</b>' }); await sleep(150);
    assert.strictEqual(b.chats.at(-1).text, 'hi <b>there</b>');

    // actor folds -> other wins the blinds -> leaderboard records it
    assert.strictEqual((await post('act', { room: c.room, pid: actor, a: 'fold' })).status, 200);
    await sleep(300);
    const lb = await fetch(`${base}/api/leaderboard`).then(r => r.json());
    assert.strictEqual(lb.rows.length, 2, 'both players on leaderboard');
    assert.strictEqual(lb.rows.reduce((s, r) => s + r.net, 0), 0, 'zero-sum');
    assert(lb.rows[0].net > 0 && lb.rows[0].hands === 1);
    a.close(); b.close();
    console.log('ok  server: join, privacy, turn rules, chat, hand result, leaderboard');
    process.exitCode = 0;
  } catch (e) { console.error(e); process.exitCode = 1; }
  srv.kill();
})();
