'use strict';

const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

for (const file of files) {
  require(path.join(__dirname, file));
}
