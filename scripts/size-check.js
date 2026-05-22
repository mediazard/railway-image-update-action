#!/usr/bin/env node
/* eslint-disable */
// Bundle size budget gate. Fails CI when dist/index.js exceeds the budget.
const fs = require('fs');
const path = require('path');

const BUDGET_BYTES = 2_500_000; // 2.5 MB — covers graphql-request + zod + p-retry + @actions/* stack
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
