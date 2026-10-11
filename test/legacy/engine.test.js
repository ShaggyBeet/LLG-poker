'use strict';
const assert = require('assert');
const { Table, eval5, bestHand, describeHand } = require('../game');

const card = (s) => '23456789TJQKA'.indexOf(s[0]) * 4 + 'shdc'.indexOf(s[1]);
const hand = (s) => s.split(/\s+/).filter(Boolean).map(card);

// ---- 1. exhaustive 5-card category frequencies (known values) ----------------
{
  const expected = [1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40];
  const counts = new Array(9).fill(0);
  for (let a = 0; a < 48; a++)
    for (let b = a + 1; b < 49; b++)
      for (let c = b + 1; c < 50; c++)
        for (let d = c + 1; d < 51; d++)
          for (let e = d + 1; e < 52; e++) counts[eval5([a, b, c, d, e]).cat]++;
  assert.deepStrictEqual(counts, expected, 'category frequencies');
  console.log('ok  evaluator matches all 2,598,960 five-card hands');
}

// ---- 2. specific comparisons --------------------------------------------------
{
  const s = (str) => bestHand(hand(str)).score;
  assert(s('Ah Kh Qh Jh Th 2c 3d') > s('9h 9d 9c 9s Ah 2c 3d'), 'royal > quads');
  assert(s('5h 4d 3c 2s Ah Kc Kd') > s('Kh Kd Qc 2s 7h 4c 3d'), 'wheel straight > pair');
  assert.strictEqual(bestHand(hand('5h 4d 3c 2s Ah Kc Kd')).tb[0], 5, 'wheel is five-high');
  assert(s('Ah Ad Ac Kh Kd 2c 3d') > s('Kh Kd Kc Ah Ad 2c 3d'), 'aces full > kings full');
  assert(s('Ah Kd 9c 7s 5h 3c 2d') < s('2h 2d 3c 4s 7h 9c Jd'), 'high card < pair');
  assert.strictEqual(s('Ah Kd Qc Js 9h 3c 2d'), s('Ac Kh Qd Jh 9s 4c 2h'), 'ties are ties');
  assert.strictEqual(describeHand(bestHand(hand('Ah Kh Qh Jh Th 2c 3d'))), 'Royal Flush');
  console.log('ok  evaluator ordering');
}

// ---- 3. scripted scenarios ----------------------------------------------------
function rigged(n, deckTop) {
  // deck pops from the end, so build a table and override shuffle
  const t = new Table({ bb: 20, sb: 10, startStack: 1000 });
  for (let i = 0; i < n; i++) t.addPlayer('p' + i, 'P' + i);
  t.shuffle = function () {
    const rest = Array.from({ length: 52 }, (_, i) => i).filter((c) => !deckTop.includes(c));
    this.deck = rest.concat(deckTop.slice().reverse());
  };
  return t;
}

{
  // Side pots: P0 (AA, 300 chips), P1 (KK, 700), P2 (QQ, 1000) all-in preflop.
  // Button starts at seat 0, so dealing goes seat1, seat2, seat0 for each of the two rounds.
  const t = rigged(3, hand('Kh Qh Ah  Kd Qd Ad  2c 7d 9s 3h 4c'));
  t.seats[0].chips = 300; t.seats[1].chips = 700; t.seats[2].chips = 1000;
  assert(t.startHand());
  while (t.actor >= 0) assert(t.act(t.seats[t.actor].id, 'allin').ok);
  while (t.runout) t.stepRunout();
  assert.strictEqual(t.phase, 'showdown');
  const chips = t.seats.filter(Boolean).map((p) => p.chips);
  assert.deepStrictEqual(chips, [900, 800, 300], 'AA wins main (900), KK wins side (800), QQ gets 300 back');
  const r = t.result;
  assert.strictEqual(r.pots.length, 3);
  assert(r.pots[2].returned, 'uncalled excess is flagged as returned');
  console.log('ok  side pots: ' + r.pots.map((p) => `${p.amount}->${p.winners.map((w) => w.name).join('/')}${p.returned ? ' (returned)' : ''}`).join(', '));
}

{
  // Split pot: both players play the board.
  const t = rigged(2, hand('2c 3d 2h 3c  Ah Kh Qh Jh Th'));
  assert(t.startHand());
  let g = 0;
  while (t.isActive() && g++ < 50) {
    if (t.runout) { t.stepRunout(); continue; }
    const p = t.seats[t.actor];
    assert(t.act(p.id, t.legalFor(p).canCheck ? 'check' : 'call').ok);
  }
  assert.strictEqual(t.phase, 'showdown');
  assert.deepStrictEqual(t.seats.filter(Boolean).map((p) => p.chips), [1000, 1000]);
  assert.strictEqual(t.result.pots[0].winners.length, 2);
  console.log('ok  split pot when the board plays');
}

{
  // Fold to the big blind
  const t = new Table({ bb: 20, sb: 10 });
  t.addPlayer('a', 'A'); t.addPlayer('b', 'B'); t.addPlayer('c', 'C');
  assert(t.startHand());
  while (t.actor >= 0) assert(t.act(t.seats[t.actor].id, 'fold').ok);
  assert.strictEqual(t.phase, 'showdown');
  assert.strictEqual(t.seats.reduce((s, p) => s + (p ? p.chips : 0), 0), 3000);
  assert.strictEqual(t.result.contested, false);
  console.log('ok  everyone folds to the big blind');
}

{
  // Min-raise & illegal actions
  const t = new Table({ bb: 20, sb: 10 });
  t.addPlayer('a', 'A'); t.addPlayer('b', 'B'); t.addPlayer('c', 'C');
  t.startHand();
  const first = t.seats[t.actor];
  assert(!t.act('nobody', 'fold').ok, 'wrong player rejected');
  assert(!t.act(first.id, 'check').ok, 'cannot check facing the big blind');
  assert(!t.act(first.id, 'raise', 30).ok, 'raise below minimum rejected');
  assert(t.act(first.id, 'raise', 40).ok, 'min raise to 40 accepted');
  assert.strictEqual(t.currentBet, 40);
  console.log('ok  raise validation');
}

{
  // Short all-in does not reopen betting
  const t = new Table({ bb: 20, sb: 10 });
  for (const n of ['a', 'b', 'c']) t.addPlayer(n, n.toUpperCase());
  t.seats[2].chips = 130; // c is short
  t.startHand();
  // order: button=0 (a), sb=b, bb=c, first to act = a
  assert.strictEqual(t.actor, 0);
  assert(t.act('a', 'raise', 100).ok);       // a raises to 100
  assert(t.act('b', 'call').ok);             // b calls
  assert(t.act('c', 'allin').ok);            // c all-in for 130 total (only +30, short raise)
  assert.strictEqual(t.actor, 0);
  assert(!t.act('a', 'raise', 300).ok, 'a cannot re-raise after short all-in');
  assert(t.act('a', 'call').ok);
  assert(t.act('b', 'call').ok);
  assert.notStrictEqual(t.phase, 'preflop');
  console.log('ok  short all-in does not reopen betting');
}

// ---- 4. bot simulation: conservation, termination, no stuck states ------------
{
  let seed = 12345;
  const rng = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  let hands = 0, showdowns = 0, sidePots = 0, rebuys = 0;

  for (let game = 0; game < 400; game++) {
    const n = 2 + Math.floor(rng() * 8);
    const t = new Table({ bb: 20, sb: 10, startStack: 200 + Math.floor(rng() * 1000), rng });
    for (let i = 0; i < n; i++) t.addPlayer('p' + i, 'P' + i);
    // randomise stacks to provoke side pots
    for (const p of t.seats) if (p) p.chips = 20 + Math.floor(rng() * 1500);
    let total = t.seats.reduce((s, p) => s + (p ? p.chips : 0), 0);

    for (let h = 0; h < 40; h++) {
      if (!t.startHand()) {
        // rebuy anyone broke
        let any = false;
        for (const p of t.seats) if (p && p.chips === 0) { t.rebuy(p.id); total += t.startStack; rebuys++; any = true; }
        if (!any) break;
        continue;
      }
      hands++;
      let guard = 0;
      while (t.isActive()) {
        assert(++guard < 500, 'stuck hand');
        if (t.runout) { t.stepRunout(); continue; }
        assert(t.actor >= 0, 'active phase must have an actor or runout');
        const p = t.seats[t.actor];
        const lg = t.legalFor(p);
        const roll = rng();
        let res;
        if (roll < 0.15) res = t.act(p.id, 'fold');
        else if (roll < 0.55) res = lg.canCheck ? t.act(p.id, 'check') : t.act(p.id, 'call');
        else if (roll < 0.9 && lg.canRaise) {
          const to = Math.floor(lg.minRaiseTo + rng() * (lg.maxRaiseTo - lg.minRaiseTo));
          res = t.act(p.id, 'raise', to);
        } else if (lg.canRaise) res = t.act(p.id, 'allin');
        else res = t.act(p.id, 'call');
        assert(res.ok, 'legal action rejected: ' + JSON.stringify(res));
        // invariants during the hand
        for (const q of t.seats) if (q) { assert(q.chips >= 0 && Number.isInteger(q.chips), 'chips sane'); }
        const inPots = t.seats.reduce((s, q) => s + (q ? q.totalBet : 0), 0);
        const stacks = t.seats.reduce((s, q) => s + (q ? q.chips : 0), 0);
        if (t.isActive()) assert.strictEqual(inPots + stacks, total, 'conservation mid-hand');
        else assert.strictEqual(stacks, total, 'conservation at hand end');
      }
      assert.strictEqual(t.phase, 'showdown');
      const stacks = t.seats.reduce((s, q) => s + (q ? q.chips : 0), 0);
      assert.strictEqual(stacks, total, 'conservation after hand');
      const delta = t.result.players.reduce((s, q) => s + q.delta, 0);
      assert.strictEqual(delta, 0, 'deltas sum to zero');
      const potSum = t.result.pots.reduce((s, q) => s + q.amount, 0);
      const won = t.result.players.reduce((s, q) => s + q.won, 0);
      assert.strictEqual(potSum, won, 'all pot chips paid out');
      if (t.result.contested) showdowns++;
      if (t.result.pots.length > 1) sidePots++;
    }
  }
  console.log(`ok  simulated ${hands} hands (${showdowns} showdowns, ${sidePots} with side pots, ${rebuys} rebuys): chips always conserved`);
}

// ---- 5. view hides hole cards ---------------------------------------------------
{
  const t = new Table({});
  t.addPlayer('a', 'A'); t.addPlayer('b', 'B');
  t.startHand();
  const v = t.viewFor('a');
  const mine = v.seats.find((s) => s && s.isYou);
  const other = v.seats.find((s) => s && !s.isYou);
  assert(mine.cards.every((c) => c !== '??'));
  assert.deepStrictEqual(other.cards, ['??', '??']);
  const spectator = t.viewFor('nobody');
  assert(spectator.seats.filter(Boolean).every((s) => s.cards.every((c) => c === '??')));
  console.log('ok  hole cards are hidden from other players and spectators');
}

console.log('\nAll engine tests passed.');
