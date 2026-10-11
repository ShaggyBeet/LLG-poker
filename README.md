# Friends Poker

No-limit Texas Hold'em for you and your friends. Play-money chips, no accounts, **no dependencies** — just Node 18+.

## Run it

    node server.js        # http://localhost:3000  (PORT env var to change)
    npm test              # ~10 s: evaluator vs all 2,598,960 hands, 8,000-hand bot sim, end-to-end server test

Open the page, enter a name, **Create table**, send friends the invite link (or the 4-letter code).
The host presses **Start game**; hands then deal automatically.

## Play with friends online

The server must be reachable from the internet:

- **Quick, from your own computer:** run `node server.js`, then expose it with a tunnel such as
  `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`, and share the URL it prints.
- **Always-on:** deploy this folder to any Node host (Render, Railway, Fly.io, a VPS). Start command: `node server.js`.
  Reads `PORT` from the environment. Run **one instance** only — tables live in memory.
  To keep the leaderboard across restarts, store `data/stats.json` on a persistent disk (or set `STATS_FILE`).

## Features

- Server-authoritative dealing: opponents' hole cards are never sent to your browser until showdown.
- Blinds (heads-up button posts SB), min-raise rules, all-ins, side pots, split pots.
- 45 s turn timer (auto check/fold, then sit out until you click "I'm back").
- Refresh or lose signal and you keep your seat and chips (identity = random id in localStorage).
- Rebuy when busted, sit out, chat, hand log, keyboard shortcuts (F = fold, C = check/call).
- All-time leaderboard (net chips per player name, saved in `data/stats.json`).

## Limits

Up to 9 players per table; tables are deleted after 2 hours empty; a server restart clears live tables (the leaderboard persists).
Play money only — no accounts, auditing or anti-collusion tools, so don't use it for real stakes.

## Layout

    server.js   HTTP + server-sent events + static files + leaderboard endpoint
    game.js     poker engine (hand evaluation, betting, pots)
    stats.js    persistent leaderboard
    public/     index.html, style.css, app.js
    test/       engine.test.js, sim.js, server.test.js   (test/legacy = older tests for a previous engine API, not run)
