// Serves dist/index.html on HOST:PORT, which the sandbox sets.
const { readFileSync } = require('node:fs');
const http = require('node:http');
const page = readFileSync('dist/index.html');
http
  .createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page))
  .listen(Number(process.env.PORT), process.env.HOST);
