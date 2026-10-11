'use strict';
const fs = require('fs');
const path = require('path');

/** Persistent all-time leaderboard, keyed by lower-cased player name. */
class Stats {
  constructor(file) {
    this.file = file;
    this.data = {};
    this.timer = null;
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (fs.existsSync(file)) this.data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
      } catch (e) {
        console.error('Could not read stats file, starting fresh:', e.message);
        this.data = {};
      }
    }
  }

  /** Record the outcome of one finished hand. `players` comes from table.result.players. */
  recordHand(result) {
    for (const p of result.players) {
      const key = p.name.trim().toLowerCase();
      const s = (this.data[key] ||= { name: p.name, net: 0, hands: 0, wins: 0, biggestWin: 0, biggestLoss: 0 });
      s.name = p.name;
      s.hands += 1;
      s.net += p.delta;
      if (p.delta > 0) { s.wins += 1; s.biggestWin = Math.max(s.biggestWin, p.delta); }
      if (p.delta < 0) s.biggestLoss = Math.max(s.biggestLoss, -p.delta);
    }
    this.scheduleSave();
  }

  rows() {
    return Object.values(this.data)
      .map((s) => ({ ...s, winRate: s.hands ? Math.round((s.wins / s.hands) * 100) : 0 }))
      .sort((a, b) => b.net - a.net || b.hands - a.hands)
      .slice(0, 50);
  }

  scheduleSave() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, 1000);
    this.timer.unref?.();
  }

  saveNow() {
    if (!this.file) return;
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Could not save stats:', e.message);
    }
  }
}

module.exports = { Stats };
