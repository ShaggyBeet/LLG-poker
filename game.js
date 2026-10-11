'use strict';
// Texas Hold'em engine. Cards are ints 0..51: rank = id % 13 + 2 (2..14), suit = floor(id / 13) (♠ ♥ ♦ ♣).
const crypto = require('crypto');

const TURN_MS = 45000;
const NEXT_HAND_MS = 7000;
const RUNOUT_MS = 1400;
const MAX_SEATS = 9;
const HAND_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

function shuffledDeck() {
  const d = [...Array(52).keys()];
  for (let i = 51; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ---- hand evaluation -------------------------------------------------------
function eval5(c) {
  const ranks = c.map(x => x % 13 + 2).sort((a, b) => b - a);
  const suit = Math.floor(c[0] / 13);
  const flush = c.every(x => Math.floor(x / 13) === suit);
  const cnt = {};
  ranks.forEach(r => { cnt[r] = (cnt[r] || 0) + 1; });
  const groups = Object.keys(cnt).map(r => [+r, cnt[r]]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  let straightHigh = 0;
  if (groups.length === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks[0] === 14 && ranks[1] === 5) straightHigh = 5; // wheel
  }
  const g = groups.map(x => x[0]);
  if (straightHigh && flush) return [8, straightHigh];
  if (groups[0][1] === 4) return [7, ...g];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, ...g];
  if (flush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][1] === 3) return [3, ...g];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, ...g];
  if (groups[0][1] === 2) return [1, ...g];
  return [0, ...ranks];
}

function combos(arr, k, start = 0, cur = [], out = []) {
  if (cur.length === k) { out.push(cur.slice()); return out; }
  for (let i = start; i <= arr.length - (k - cur.length); i++) {
    cur.push(arr[i]);
    combos(arr, k, i + 1, cur, out);
    cur.pop();
  }
  return out;
}

function cmpScore(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

function bestHand(cards) {
  let best = null;
  for (const c of combos(cards, 5)) {
    const s = eval5(c);
    if (!best || cmpScore(s, best) > 0) best = s;
  }
  return best;
}

function handName(score) {
  return score[0] === 8 && score[1] === 14 ? 'Royal flush' : HAND_NAMES[score[0]];
}

// ---- table -----------------------------------------------------------------
class Table {
  constructor(code, cfg) {
    this.code = code;
    this.sb = cfg.sb;
    this.bb = cfg.bb;
    this.startChips = cfg.chips;
    this.onHand = cfg.onHand || null;
    this.seats = [];
    this.clients = new Map(); // pid -> SSE response
    this.hostPid = null;
    this.started = false;
    this.phase = 'waiting'; // waiting | preflop | flop | turn | river | showdown
    this.board = [];
    this.deck = [];
    this.button = -1;
    this.toAct = -1;
    this.currentBet = 0;
    this.minRaise = cfg.bb;
    this.deadline = 0;
    this.handNo = 0;
    this.result = null;
    this.log = [];
    this.chat = [];
    this.turnTimer = null;
    this.nextTimer = null;
    this.startPending = false;
    this.lastActive = Date.now();
  }

  // -- helpers --
  find(pid) { return this.seats.find(p => p.pid === pid); }
  say(msg) { this.log.push(msg); if (this.log.length > 100) this.log.shift(); }
  next(from, pred) {
    const n = this.seats.length;
    for (let i = 1; i <= n; i++) {
      const idx = ((from + i) % n + n) % n;
      if (pred(this.seats[idx])) return idx;
    }
    return -1;
  }
  needsAct(p) { return p.inHand && !p.folded && !p.allIn && (!p.acted || p.bet < this.currentBet); }
  potTotal() { return this.seats.reduce((s, p) => s + p.total, 0); }
  inActiveHand() { return ['preflop', 'flop', 'turn', 'river'].includes(this.phase); }
  hostId() {
    const h = this.find(this.hostPid);
    if (h && h.connected) return h.id;
    const c = this.seats.find(p => p.connected);
    return c ? c.id : (h ? h.id : null);
  }
  dist(p) { const n = this.seats.length; return ((this.seats.indexOf(p) - this.button) % n + n) % n; }

  // -- membership --
  join(pid, name) {
    this.lastActive = Date.now();
    const existing = this.find(pid);
    if (existing) return null;
    if (this.seats.length >= MAX_SEATS) return 'Table is full';
    const p = {
      pid, id: crypto.randomBytes(4).toString('hex'), name,
      chips: this.startChips, hole: [], bet: 0, total: 0,
      folded: false, allIn: false, acted: false, inHand: false,
      connected: false, sittingOut: false, lastAction: '', win: 0, handName: '', show: false, rebuys: 0,
    };
    this.seats.push(p);
    if (!this.hostPid) this.hostPid = pid;
    this.say(`${name} joined the table`);
    return null;
  }

  attach(pid, res) {
    const p = this.find(pid);
    if (!p) return;
    const old = this.clients.get(pid);
    if (old && old !== res) { try { old.end(); } catch (e) { /* ignore */ } }
    this.clients.set(pid, res);
    p.connected = true;
    p.sittingOut = false;
    this.lastActive = Date.now();
    this.send(pid, { t: 'chats', list: this.chat });
    this.broadcast();
    this.maybeStart();
  }

  detach(pid, res) {
    if (this.clients.get(pid) !== res) return;
    this.clients.delete(pid);
    const p = this.find(pid);
    if (!p) return;
    p.connected = false;
    this.lastActive = Date.now();
    if (this.inActiveHand() && this.seats[this.toAct] === p) this.setTurn(); // shortens the timer
    this.broadcast();
  }

  // -- commands --
  handle(cmd, b) {
    this.lastActive = Date.now();
    const pid = b.pid;
    switch (cmd) {
      case 'start': return this.start(pid);
      case 'act': return this.act(pid, b.a, b.amt);
      case 'chat': return this.sendChat(pid, b.text);
      case 'rebuy': return this.rebuy(pid);
      case 'sitout': return this.toggleSitOut(pid);
      default: return 'Unknown command';
    }
  }

  start(pid) {
    if (pid !== this.hostPid && this.find(pid).id !== this.hostId()) return 'Only the host can start';
    if (this.started) return 'Already started';
    const elig = this.seats.filter(p => p.chips > 0 && p.connected && !p.sittingOut);
    if (elig.length < 2) return 'Need at least 2 players';
    this.started = true;
    this.startHand();
    return null;
  }

  sendChat(pid, text) {
    const p = this.find(pid);
    text = String(text || '').trim().slice(0, 200);
    if (!text) return null;
    const m = { t: 'chat', name: p.name, text };
    this.chat.push(m);
    if (this.chat.length > 50) this.chat.shift();
    for (const q of this.seats) this.send(q.pid, m);
    return null;
  }

  rebuy(pid) {
    const p = this.find(pid);
    if (p.chips > 0) return 'You still have chips';
    if (p.inHand && !p.folded && (this.inActiveHand())) return 'Wait for the hand to finish';
    p.chips = this.startChips;
    p.rebuys++;
    p.sittingOut = false;
    this.say(`${p.name} rebought for ${this.startChips}`);
    this.broadcast();
    this.maybeStart();
    return null;
  }

  toggleSitOut(pid) {
    const p = this.find(pid);
    p.sittingOut = !p.sittingOut;
    this.broadcast();
    if (!p.sittingOut) this.maybeStart();
    return null;
  }

  maybeStart() {
    if (!this.started || this.phase !== 'waiting' || this.startPending) return;
    const elig = this.seats.filter(p => p.chips > 0 && p.connected && !p.sittingOut);
    if (elig.length < 2) return;
    this.startPending = true;
    this.nextTimer = setTimeout(() => { this.startPending = false; this.startHand(); }, 1500);
  }

  // -- hand flow --
  commit(p, c) {
    p.chips -= c; p.bet += c; p.total += c;
    if (p.chips === 0) p.allIn = true;
  }

  post(p, amt, label) {
    const c = Math.min(amt, p.chips);
    this.commit(p, c);
    p.lastAction = `${label} ${c}`;
    this.say(`${p.name} posts ${label.toLowerCase() === 'sb' ? 'small' : 'big'} blind ${c}`);
  }

  startHand() {
    clearTimeout(this.nextTimer); clearTimeout(this.turnTimer);
    this.startPending = false;
    const elig = this.seats.filter(p => p.chips > 0 && p.connected && !p.sittingOut);
    for (const p of this.seats) {
      Object.assign(p, { hole: [], bet: 0, total: 0, folded: false, allIn: false, acted: false, inHand: false, lastAction: '', win: 0, handName: '', show: false });
    }
    this.board = []; this.result = null; this.toAct = -1; this.currentBet = 0; this.deadline = 0;
    if (elig.length < 2) { this.phase = 'waiting'; this.broadcast(); return false; }
    elig.forEach(p => { p.inHand = true; p.startStack = p.chips; });
    this.handNo++;
    this.deck = shuffledDeck();
    const isIn = p => p.inHand;
    this.button = this.next(this.button, isIn);
    const heads = elig.length === 2;
    const sbI = heads ? this.button : this.next(this.button, isIn);
    const bbI = this.next(sbI, isIn);
    this.say(`— Hand #${this.handNo} —`);
    this.post(this.seats[sbI], this.sb, 'SB');
    this.post(this.seats[bbI], this.bb, 'BB');
    for (let r = 0; r < 2; r++) for (const p of elig) p.hole.push(this.deck.pop());
    this.currentBet = this.bb;
    this.minRaise = this.bb;
    this.phase = 'preflop';
    this.toAct = this.next(bbI, p => this.needsAct(p));
    if (this.toAct === -1) { this.endRound(); return true; }
    this.setTurn();
    this.broadcast();
    return true;
  }

  setTurn() {
    clearTimeout(this.turnTimer);
    const p = this.seats[this.toAct];
    if (!p) return;
    const ms = p.connected ? TURN_MS : 3000;
    this.deadline = Date.now() + ms;
    this.turnTimer = setTimeout(() => {
      const q = this.seats[this.toAct];
      if (!q || !this.inActiveHand()) return;
      if (q.connected) { q.sittingOut = true; this.say(`${q.name} timed out`); }
      this.act(q.pid, this.currentBet - q.bet > 0 ? 'fold' : 'check');
    }, ms);
  }

  act(pid, a, amt) {
    if (!this.inActiveHand()) return 'No hand in progress';
    const p = this.seats[this.toAct];
    if (!p || p.pid !== pid) return 'Not your turn';
    const toCall = this.currentBet - p.bet;
    if (a === 'raise' && p.bet + p.chips <= this.currentBet) a = 'call'; // can only call (all-in)
    if (a === 'fold') {
      p.folded = true; p.lastAction = 'Fold'; this.say(`${p.name} folds`);
    } else if (a === 'check') {
      if (toCall > 0) return 'You cannot check — call or fold';
      p.lastAction = 'Check'; this.say(`${p.name} checks`);
    } else if (a === 'call') {
      if (toCall <= 0) return 'Nothing to call';
      const c = Math.min(toCall, p.chips);
      this.commit(p, c);
      p.lastAction = p.allIn ? `All-in ${p.bet}` : `Call ${c}`;
      this.say(`${p.name} ${p.allIn ? 'is all-in for' : 'calls'} ${c}`);
    } else if (a === 'raise') {
      amt = Math.floor(Number(amt));
      if (!Number.isFinite(amt)) return 'Bad amount';
      const max = p.bet + p.chips;
      amt = Math.min(amt, max);
      const minTo = this.currentBet + this.minRaise;
      if (amt < minTo && amt < max) return `Minimum raise is to ${minTo}`;
      const wasBet = this.currentBet > 0;
      this.commit(p, amt - p.bet);
      const size = p.bet - this.currentBet;
      if (size >= this.minRaise) {
        this.minRaise = size;
        for (const q of this.seats) if (q !== p) q.acted = false;
      }
      this.currentBet = p.bet;
      p.lastAction = p.allIn ? `All-in ${p.bet}` : `${wasBet ? 'Raise to' : 'Bet'} ${p.bet}`;
      this.say(`${p.name} ${p.allIn ? 'is all-in for' : wasBet ? 'raises to' : 'bets'} ${p.bet}`);
    } else {
      return 'Unknown action';
    }
    p.acted = true;
    this.afterAction();
    return null;
  }

  afterAction() {
    clearTimeout(this.turnTimer);
    const live = this.seats.filter(p => p.inHand && !p.folded);
    if (live.length === 1) return this.awardUncontested(live[0]);
    const nxt = this.next(this.toAct, p => this.needsAct(p));
    if (nxt !== -1) { this.toAct = nxt; this.setTurn(); this.broadcast(); return; }
    this.endRound();
  }

  endRound() {
    clearTimeout(this.turnTimer);
    for (const p of this.seats) {
      p.bet = 0; p.acted = false;
      if (!p.allIn && !p.folded) p.lastAction = '';
    }
    this.currentBet = 0; this.minRaise = this.bb;
    const order = ['preflop', 'flop', 'turn', 'river'];
    const i = order.indexOf(this.phase);
    if (i === 3) return this.doShowdown();
    this.phase = order[i + 1];
    const k = i === 0 ? 3 : 1;
    for (let j = 0; j < k; j++) this.board.push(this.deck.pop());
    const canAct = this.seats.filter(p => p.inHand && !p.folded && !p.allIn);
    if (canAct.length < 2) { // nobody left to bet against: run the board out
      this.toAct = -1; this.deadline = 0;
      this.broadcast();
      this.nextTimer = setTimeout(() => this.endRound(), RUNOUT_MS);
      return;
    }
    this.toAct = this.next(this.button, p => this.needsAct(p));
    this.setTurn();
    this.broadcast();
  }

  awardUncontested(p) {
    this.phase = 'showdown'; this.toAct = -1; this.deadline = 0;
    const pot = this.potTotal();
    p.chips += pot; p.win = pot;
    this.result = [`${p.name} wins ${pot}`];
    this.say(this.result[0]);
    this.finishHand();
    this.scheduleNext();
    this.broadcast();
  }

  doShowdown() {
    this.phase = 'showdown'; this.toAct = -1; this.deadline = 0;
    const contrib = this.seats.filter(p => p.inHand);
    const live = contrib.filter(p => !p.folded);
    for (const p of live) {
      p.score = bestHand(p.hole.concat(this.board));
      p.handName = handName(p.score);
      p.show = true;
    }
    // main + side pots built from each player's total contribution
    const levels = [...new Set(live.map(p => p.total))].sort((a, b) => a - b);
    let prev = 0;
    const pots = [];
    for (const L of levels) {
      let amt = 0;
      for (const p of contrib) amt += Math.min(p.total, L) - Math.min(p.total, prev);
      pots.push({ amt, elig: live.filter(p => p.total >= L) });
      prev = L;
    }
    const lines = [];
    pots.forEach((pot, idx) => {
      if (pot.amt <= 0) return;
      let winners = pot.elig;
      if (winners.length > 1) {
        let best = null;
        for (const p of winners) if (!best || cmpScore(p.score, best) > 0) best = p.score;
        winners = winners.filter(p => cmpScore(p.score, best) === 0);
      }
      winners.sort((a, b) => this.dist(a) - this.dist(b));
      const share = Math.floor(pot.amt / winners.length);
      const rem = pot.amt - share * winners.length;
      winners.forEach((w, k) => { const g = share + (k < rem ? 1 : 0); w.chips += g; w.win += g; });
      const label = pots.length > 1 ? (pot.elig.length === 1 ? ' (uncalled)' : idx === 0 ? ' (main pot)' : ' (side pot)') : '';
      const how = pot.elig.length > 1 ? ` with ${winners[0].handName}` : '';
      lines.push(`${winners.map(w => w.name).join(' & ')} ${winners.length > 1 ? 'split' : 'wins'} ${pot.amt}${label}${how}`);
    });
    this.result = lines;
    lines.forEach(l => this.say(l));
    this.finishHand();
    this.scheduleNext();
    this.broadcast();
  }

  finishHand() {
    if (!this.onHand) return;
    try {
      this.onHand({ players: this.seats.filter(p => p.inHand).map(p => ({ name: p.name, delta: p.chips - p.startStack })) });
    } catch (e) { console.error('stats error', e.message); }
  }

  scheduleNext() {
    clearTimeout(this.nextTimer);
    this.nextTimer = setTimeout(() => this.startHand(), NEXT_HAND_MS);
  }

  // -- output --
  send(pid, obj) {
    const res = this.clients.get(pid);
    if (!res) return;
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) { /* closed */ }
  }

  view(pid) {
    const me = this.find(pid);
    const toActP = this.seats[this.toAct];
    return {
      t: 'state', room: this.code, sb: this.sb, bb: this.bb, turnMs: TURN_MS,
      phase: this.phase, board: this.board, pot: this.potTotal(),
      currentBet: this.currentBet, minRaise: this.minRaise,
      toAct: toActP ? toActP.id : null,
      button: this.button >= 0 && this.seats[this.button] ? this.seats[this.button].id : null,
      timeLeft: this.deadline ? Math.max(0, this.deadline - Date.now()) : 0,
      host: this.hostId(), started: this.started, you: me ? me.id : null, handNo: this.handNo,
      players: this.seats.map(p => {
        const mine = p === me;
        let cards = [];
        if (p.hole.length) {
          if (mine || p.show) cards = p.hole;
          else if (!p.folded) cards = [-1, -1];
        }
        return {
          id: p.id, name: p.name, chips: p.chips, bet: p.bet, folded: p.folded, allIn: p.allIn,
          connected: p.connected, sittingOut: p.sittingOut, inHand: p.inHand,
          lastAction: p.lastAction, win: p.win, handName: p.show ? p.handName : '', cards,
        };
      }),
      result: this.result, log: this.log.slice(-40),
    };
  }

  broadcast() {
    for (const p of this.seats) this.send(p.pid, this.view(p.pid));
  }
}

module.exports = { Table, MAX_SEATS, bestHand, cmpScore, handName, eval5, TURN_MS };
