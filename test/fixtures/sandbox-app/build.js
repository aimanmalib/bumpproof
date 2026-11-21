// Writes dist/index.html. The sandbox test breaks this file on purpose to get a failed build.
const { mkdirSync, writeFileSync } = require('node:fs');
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', '<!doctype html><title>fixture</title><p>ok</p>\n');
