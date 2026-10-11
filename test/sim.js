'use strict';
const assert = require('assert');
const { Table, bestHand, cmpScore } = require('../game');

// --- hand evaluator spot checks (cards: rank-2 + 13*suit; s=0 h=1 d=2 c=3)
const C = (r, s) => ({ '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7, T: 8, J: 9, Q: 10, K: 11, A: 12 }[r]) + 13 * 'shdc'.indexOf(s);
const H = str => str.split(' ').map(x => C(x[0], x[1]));
const better = (a, b) => cmpScore(bestHand(H(a)), bestHand(H(b))) > 0;
assert(better('As Ks Qs Js Ts 2c 3d', 'Ah Ad Ac As Kd 2c 3d'), 'royal > quads');
assert(better('Ah Ad Ac Ks Kd 2c 3d', 'Ah Kh Qh Jh 9h 2c 3d'), 'full house > flush');
assert(better('9s 8d 7c 6h 5s 2c 3d', 'As 5d 4c 3h 2s Kc Qd'), '9-high straight > wheel');
assert(bestHand(H('As 5d 4c 3h 2s Kc Qd'))[0] === 4 && bestHand(H('As 5d 4c 3h 2s Kc Qd'))[1] === 5, 'wheel');
assert(better('Ah Kd 9c 7h 3s 2c 4d', 'Qh Kd 9c 7h 3s 2c 4d'), 'high card kicker');
assert(better('Ah Ad Kc 7h 3s 2c 4d', 'Ah Ac Qc 7h 3s 2c 9d'), 'pair kicker');
assert.strictEqual(cmpScore(bestHand(H('Ah Kd Qc Jh 9s 2c 3d')), bestHand(H('As Kh Qd Jc 9d 4c 5d'))), 0, 'tie');

// --- full-table simulation with random bots
const fakeRes = () => ({ write() {}, end() {} });
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
let hands = 0, showdowns = 0;
for (let game = 0; game < 200; game++) {
  const n = 2 + Math.floor(rnd() * 7);
  const t = new Table('TEST', { chips: 500, sb: 5, bb: 10 });
  for (let i = 0; i < n; i++) { const pid = 'p'.repeat(16) + i; t.join(pid, 'P' + i); t.attach(pid, fakeRes()); }
  t.nextTimer && clearTimeout(t.nextTimer); t.startPending = false;
  assert.strictEqual(t.start(t.hostPid), null);
  let total = n * 500;
  for (let step = 0; step < 3000; step++) {
    clearTimeout(t.turnTimer); clearTimeout(t.nextTimer);
    const sum = t.seats.reduce((s, p) => s + p.chips + (t.phase === 'showdown' ? 0 : p.total), 0);
    assert.strictEqual(sum, total, `chips conserved (game ${game} step ${step})`);
    if (t.phase === 'showdown') {
      hands++; if (t.board.length === 5) showdowns++;
      // rebuy busted players to keep the game going, then deal
      for (const p of t.seats) if (p.chips === 0) { p.chips = 500; total += 500; }
      if (!t.startHand()) break;
      if (hands > 40 * (game + 1)) break;
      continue;
    }
    if (t.phase === 'waiting') break;
    if (t.toAct === -1) { t.endRound(); continue; }
    const p = t.seats[t.toAct];
    const toCall = t.currentBet - p.bet;
    const r = rnd();
    let err;
    if (r < 0.15 && toCall > 0) err = t.act(p.pid, 'fold');
    else if (r < 0.55) err = toCall > 0 ? t.act(p.pid, 'call') : t.act(p.pid, 'check');
    else if (r < 0.62) err = t.act(p.pid, 'raise', p.bet + p.chips); // shove
    else {
      const to = t.currentBet + t.minRaise + Math.floor(rnd() * 60);
      err = t.act(p.pid, 'raise', to);
    }
    if (err) { // fall back to a legal move
      err = toCall > 0 ? t.act(p.pid, 'call') : t.act(p.pid, 'check');
      assert.strictEqual(err, null, 'fallback legal');
    }
  }
}
// illegal moves are rejected
const t = new Table('X', { chips: 100, sb: 1, bb: 2 });
['a'.repeat(16), 'b'.repeat(16)].forEach(pid => { t.join(pid, pid[0]); t.attach(pid, fakeRes()); });
clearTimeout(t.nextTimer); t.startPending = false; t.start(t.hostPid);
const cur = t.seats[t.toAct], other = t.seats.find(p => p !== cur);
assert(t.act(other.pid, 'fold'), 'out-of-turn rejected');
assert(t.act(cur.pid, 'check'), 'cannot check facing blind');
assert(t.act(cur.pid, 'raise', 3), 'min raise enforced');
// hidden cards
const v = t.view(cur.pid);
assert.deepStrictEqual(v.players.find(p => p.id === other.id).cards, [-1, -1], 'opponent cards hidden');
assert(!JSON.stringify(v).includes(other.pid), 'no secret ids leaked');
clearTimeout(t.turnTimer);
console.log(`OK — ${hands} hands simulated, ${showdowns} reached showdown`);
process.exit(0);
