#!/usr/bin/env node
/* eslint-disable */
// Bundle size budget gate. Fails CI when dist/index.js exceeds the budget.
const fs = require('fs');
const path = require('path');

// Measured 3,139,903 B (ncc 0.45, zod 4) plus about 10% headroom. zod 4 classic adds about 1 MB:
// the build is CommonJS, so ncc bundles the whole package and nothing is tree-shaken.
const BUDGET_BYTES = 3_450_000;
const distPath = path.join(__dirname, '..', 'dist', 'index.js');

let size;
try {
  size = fs.statSync(distPath).size;
} catch (err) {
  console.error('dist/index.js does not exist; run `npm run bundle` first.');
  process.exit(1);
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';

if (size > BUDGET_BYTES) {
  console.error(`bundle is ${kb(size)}, exceeds ${kb(BUDGET_BYTES)} budget`);
  process.exit(1);
}
console.log(`bundle ${kb(size)} (under ${kb(BUDGET_BYTES)} budget)`);
