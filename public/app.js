'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};
function randId() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''); }

let pid = store.get('poker.pid');
if (!pid) { pid = randId(); store.set('poker.pid', pid); }
let room = null, es = null, S = null, localDeadline = 0, raiseVal = 0, raiseKey = '';

// ---- helpers ----------------------------------------------------------------
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
async function api(cmd, body = {}) {
  try {
    const r = await fetch('/api/' + cmd, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room, pid, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { if (j.err) toast(j.err); if (r.status === 404) toLobby('That table no longer exists.'); }
    return j;
  } catch (e) { toast('Connection problem — retrying…'); return { err: 'network' }; }
}

// ---- lobby ------------------------------------------------------------------
$('#name').value = store.get('poker.name') || '';
const hashCode = (location.hash || '').replace('#', '').toUpperCase().slice(0, 4);
if (hashCode) $('#code').value = hashCode;

function lobbyMsg(m) { $('#lobbyMsg').textContent = m || ''; }
function getName() {
  const n = $('#name').value.trim();
  if (!n) { lobbyMsg('Enter your name first.'); $('#name').focus(); return null; }
  store.set('poker.name', n);
  return n;
}
async function enter(body) {
  const name = getName(); if (!name) return;
  lobbyMsg('');
  const j = await fetch('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid, name, ...body }) })
    .then(r => r.json()).catch(() => ({ err: 'Could not reach the server.' }));
  if (j.err) return lobbyMsg(j.err);
  openTable(j.room);
}
$('#createBtn').onclick = () => enter({ create: true, chips: $('#cfgChips').value, sb: $('#cfgSb').value });
$('#joinBtn').onclick = () => { const c = $('#code').value.trim().toUpperCase(); if (c.length !== 4) return lobbyMsg('Enter the 4-letter table code.'); enter({ room: c }); };
$('#code').addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });
$('#name').addEventListener('keydown', e => { if (e.key === 'Enter') (($('#code').value.length === 4) ? $('#joinBtn') : $('#createBtn')).click(); });

function toLobby(msg) {
  if (es) { es.close(); es = null; }
  room = null; S = null; store.del('poker.room');
  history.replaceState(null, '', location.pathname);
  $('#game').hidden = true; $('#lobby').hidden = false;
  lobbyMsg(msg);
}
$('#leaveBtn').onclick = () => { if (confirm('Leave the table? Your seat and chips stay reserved if you come back with the same browser.')) toLobby(''); };
$('#copyBtn').onclick = async () => {
  const link = `${location.origin}/#${room}`;
  try { await navigator.clipboard.writeText(link); toast('Invite link copied'); } catch (e) { prompt('Copy this link:', link); }
};

// ---- leaderboard ------------------------------------------------------------
async function showLeaderboard() {
  const j = await fetch('/api/leaderboard').then(r => r.json()).catch(() => ({ rows: [] }));
  $('#lbBody').innerHTML = j.rows.length
    ? `<table><thead><tr><th>#</th><th>Player</th><th>Net</th><th>Hands</th><th>Win %</th><th>Best win</th></tr></thead><tbody>${
      j.rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td class="${r.net >= 0 ? 'pos' : 'neg'}">${r.net > 0 ? '+' : ''}${r.net}</td><td>${r.hands}</td><td>${r.winRate}</td><td>${r.biggestWin}</td></tr>`).join('')
    }</tbody></table>`
    : '<p class="status">No hands played yet.</p>';
  $('#lbDialog').showModal();
}
$('#lbBtn').onclick = showLeaderboard;
$('#lbBtn2').onclick = showLeaderboard;

// ---- connection -------------------------------------------------------------
function openTable(code) {
  room = code; store.set('poker.room', code);
  history.replaceState(null, '', '#' + code);
  $('#lobby').hidden = true; $('#game').hidden = false;
  $('#chat').innerHTML = '';
  if (es) es.close();
  es = new EventSource(`/api/events?room=${code}&pid=${pid}`);
  es.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'state') { S = m; localDeadline = Date.now() + m.timeLeft; render(); }
    else if (m.t === 'chats') { $('#chat').innerHTML = ''; m.list.forEach(addChat); }
    else if (m.t === 'chat') addChat(m);
  };
  es.onerror = () => { if (es && es.readyState === EventSource.CLOSED) toLobby('Table not found — the server may have restarted.'); };
}
function addChat(m) {
  const box = $('#chat'); const d = document.createElement('div');
  d.innerHTML = `<b>${esc(m.name)}</b> ${esc(m.text)}`;
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.appendChild(d); if (stick) box.scrollTop = box.scrollHeight;
}
$('#chatForm').onsubmit = e => { e.preventDefault(); const i = $('#chatInput'); const text = i.value.trim(); if (text) api('chat', { text }); i.value = ''; };

// ---- rendering --------------------------------------------------------------
const SU = '♠♥♦♣', RK = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
function cardEl(c, cls = '') {
  if (c < 0) return `<div class="card back ${cls}"></div>`;
  const s = Math.floor(c / 13);
  return `<div class="card ${s === 1 || s === 2 ? 'red' : ''} ${cls}"><b>${RK[c % 13]}</b><span>${SU[s]}</span></div>`;
}

function render() {
  if (!S) return;
  $('#roomcode').textContent = S.room;
  $('#blinds').textContent = `Blinds ${S.sb} / ${S.bb}`;
  const me = S.players.find(p => p.id === S.you);
  renderTable(me); renderActions(me); renderLog();
}

function renderTable(me) {
  const n = S.players.length;
  const myIdx = Math.max(0, S.players.findIndex(p => p.id === S.you));
  const active = ['preflop', 'flop', 'turn', 'river'].includes(S.phase);
  let h = '';
  const board = [];
  for (let i = 0; i < 5; i++) board.push(i < S.board.length ? cardEl(S.board[i]) : '<div class="card empty"></div>');
  h += `<div class="center"><div class="board">${board.join('')}</div>`;
  h += `<div class="pot">Pot ${S.pot}</div>`;
  if (S.result) h += `<div class="result">${S.result.map(l => `<div>${esc(l)}</div>`).join('')}</div>`;
  h += '</div>';

  S.players.forEach((p, i) => {
    const a = Math.PI / 2 + (i - myIdx) * 2 * Math.PI / n;
    const x = 50 + 43 * Math.cos(a), y = 50 + 41 * Math.sin(a);
    const isMe = p.id === S.you;
    const out = !p.inHand && S.phase !== 'waiting' || p.sittingOut || !p.connected;
    let label = '';
    if (S.phase === 'showdown' && p.win > 0) label = `+${p.win}${p.handName ? ' · ' + p.handName : ''}`;
    else if (S.phase === 'showdown' && p.handName) label = p.handName;
    else if (p.lastAction) label = p.lastAction;
    else if (!p.connected) label = 'Disconnected';
    else if (p.sittingOut) label = 'Sitting out';
    else if (p.chips === 0 && !(p.inHand && active)) label = 'Busted';
    else if (!p.inHand && active) label = 'Next hand';
    const cls = ['seat', isMe ? 'me' : '', p.id === S.toAct ? 'turn' : '', p.folded ? 'folded' : '', out && !p.lastAction ? 'out' : '', S.phase === 'showdown' && p.win > 0 ? 'winner' : ''].join(' ');
    const cardCls = isMe ? 'me' : 'sm';
    h += `<div class="${cls}" style="left:${x}%;top:${y}%">
      <div class="hole">${p.cards.map(c => cardEl(c, cardCls)).join('')}</div>
      <div class="plate">${p.id === S.toAct ? '<div class="clock"><i id="clock"></i></div>' : ''}
        <div class="nm">${esc(p.name)}${isMe ? ' (you)' : ''}${p.id === S.button ? '<i class="btn">D</i>' : ''}</div>
        <div class="stack">${p.chips}</div></div>
      <div class="badge ${!label ? 'none' : p.win > 0 && S.phase === 'showdown' ? 'win' : ''}">${esc(label) || '&nbsp;'}</div></div>`;
    if (p.bet > 0) {
      const bx = x + (50 - x) * 0.46, by = y + (46 - y) * 0.46;
      h += `<div class="bet" style="left:${bx}%;top:${by}%">${p.bet}</div>`;
    }
  });
  $('#table').innerHTML = h;
}

function renderActions(me) {
  const el = $('#actions');
  if (!me) { el.innerHTML = '<div class="status">Connecting…</div>'; return; }
  const active = ['preflop', 'flop', 'turn', 'river'].includes(S.phase);
  const myTurn = active && S.toAct === me.id;
  let h = '';

  if (myTurn) {
    const toCall = S.currentBet - me.bet;
    const maxTo = me.bet + me.chips;
    const others = S.players.filter(p => p.id !== me.id && p.inHand && !p.folded && !p.allIn).length;
    const canRaise = maxTo > S.currentBet && others > 0;
    const minTo = Math.min(S.currentBet + S.minRaise, maxTo);
    const key = `${S.handNo}-${S.phase}-${S.currentBet}`;
    if (key !== raiseKey) { raiseKey = key; raiseVal = minTo; }
    raiseVal = Math.min(maxTo, Math.max(minTo, raiseVal));
    h += '<div class="row">';
    h += '<button class="b-fold" id="bFold">Fold</button>';
    h += toCall > 0
      ? `<button class="b-call" id="bCall">${me.chips <= toCall ? 'Call all-in ' + me.chips : 'Call ' + toCall}</button>`
      : '<button class="b-call" id="bCheck">Check</button>';
    if (canRaise) h += `<button class="b-raise" id="bRaise"></button>`;
    h += '</div>';
    if (canRaise) {
      h += `<div class="raisebox">
        <button class="sm" data-q="min">Min</button><button class="sm" data-q="0.5">½ pot</button>
        <button class="sm" data-q="0.75">¾ pot</button><button class="sm" data-q="1">Pot</button><button class="sm" data-q="max">All-in</button>
        <input type="range" id="rRange" min="${minTo}" max="${maxTo}" step="1" value="${raiseVal}" aria-label="Raise amount">
        <input type="number" id="rNum" min="${minTo}" max="${maxTo}" value="${raiseVal}" aria-label="Raise to"></div>`;
    }
    el.innerHTML = h;
    const setRaise = v => {
      raiseVal = Math.round(Math.min(maxTo, Math.max(minTo, Number(v) || minTo)));
      if (canRaise) {
        $('#rRange').value = raiseVal; $('#rNum').value = raiseVal;
        $('#bRaise').textContent = raiseVal >= maxTo ? `All-in ${maxTo}` : `${S.currentBet > 0 ? 'Raise to' : 'Bet'} ${raiseVal}`;
      }
    };
    $('#bFold').onclick = () => api('act', { a: 'fold' });
    if ($('#bCall')) $('#bCall').onclick = () => api('act', { a: 'call' });
    if ($('#bCheck')) $('#bCheck').onclick = () => api('act', { a: 'check' });
    if (canRaise) {
      $('#bRaise').onclick = () => api('act', { a: 'raise', amt: raiseVal });
      $('#rRange').oninput = e => setRaise(e.target.value);
      $('#rNum').onchange = e => setRaise(e.target.value);
      el.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
        const q = b.dataset.q;
        if (q === 'min') return setRaise(minTo);
        if (q === 'max') return setRaise(maxTo);
        setRaise(S.currentBet + (S.pot + toCall) * Number(q));
      });
      setRaise(raiseVal);
    }
    return;
  }

  if (S.phase === 'waiting') {
    const enough = S.players.filter(p => p.chips > 0 && p.connected).length >= 2;
    if (!S.started) {
      if (S.host === me.id) {
        h += `<div class="status">${enough ? 'Everyone here? Deal the first hand.' : 'Share the invite link — you need at least 2 players.'}</div>`;
        h += `<div class="row"><button class="primary" id="bStart" ${enough ? '' : 'disabled'}>Start game</button></div>`;
      } else h += '<div class="status">Waiting for the host to start the game…</div>';
    } else h += '<div class="status">Waiting for more players to sit in…</div>';
  } else if (S.phase === 'showdown') {
    h += '<div class="status">Next hand starts in a moment…</div>';
  } else if (!me.inHand) {
    h += '<div class="status">You’ll be dealt in next hand.</div>';
  } else if (me.folded) {
    h += '<div class="status">You folded. Watching this hand.</div>';
  } else if (S.toAct) {
    const t = S.players.find(p => p.id === S.toAct);
    h += `<div class="status">Waiting for <b>${esc(t ? t.name : '…')}</b>…</div>`;
  } else h += '<div class="status">Dealing the board…</div>';

  const row = [];
  if (me.chips === 0 && !(me.inHand && !me.folded && active)) row.push('<button class="primary" id="bRebuy">Rebuy</button>');
  row.push(`<button class="ghost sm" id="bSit">${me.sittingOut ? 'I’m back — deal me in' : 'Sit out'}</button>`);
  h += `<div class="row">${row.join('')}</div>`;
  el.innerHTML = h;
  if ($('#bStart')) $('#bStart').onclick = () => api('start');
  if ($('#bRebuy')) $('#bRebuy').onclick = () => api('rebuy');
  if ($('#bSit')) $('#bSit').onclick = () => api('sitout');
}

function renderLog() {
  const box = $('#log');
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.innerHTML = S.log.map(l => `<div class="${l.startsWith('—') ? 'h' : / wins | split /.test(l) ? 'w' : ''}">${esc(l)}</div>`).join('');
  if (stick) box.scrollTop = box.scrollHeight;
}

// turn countdown
setInterval(() => {
  const c = $('#clock');
  if (!c || !S) return;
  const frac = Math.max(0, Math.min(1, (localDeadline - Date.now()) / S.turnMs));
  c.style.width = (frac * 100) + '%';
  c.classList.toggle('low', frac < 0.25);
}, 250);

// keyboard shortcuts: F fold, C check/call (when not typing)
document.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA/.test(document.activeElement.tagName) || e.ctrlKey || e.metaKey) return;
  if (e.key === 'f') $('#bFold') && $('#bFold').click();
  if (e.key === 'c') ($('#bCall') || $('#bCheck') || { click() {} }).click();
});

// auto-reconnect to the last table (same browser)
(async function boot() {
  const last = hashCode || store.get('poker.room');
  if (last && store.get('poker.name')) {
    const j = await fetch('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid, name: store.get('poker.name'), room: last }) })
      .then(r => r.json()).catch(() => ({}));
    if (j.room) return openTable(j.room);
    store.del('poker.room');
  }
})();
