'use strict';
// 1) Exhaustive check: category counts over all 2,598,960 five-card hands must match the known values.
const assert = require('assert');
const { eval5 } = require('../game');
const expected = [1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40];
const counts = new Array(9).fill(0);
for (let a = 0; a < 48; a++)
  for (let b = a + 1; b < 49; b++)
    for (let c = b + 1; c < 50; c++)
      for (let d = c + 1; d < 51; d++)
        for (let e = d + 1; e < 52; e++) counts[eval5([a, b, c, d, e])[0]]++;
assert.deepStrictEqual(counts, expected, 'category frequencies');
console.log('ok  evaluator matches all 2,598,960 five-card hands');
// 2) spot checks, betting rules, side pots (via random simulation) and hidden cards
require('./sim.js');
