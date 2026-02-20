const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 5555;
const DIR = __dirname;
const BACKEND = 'http://192.168.1.221:8000';

const options = {
  key: fs.readFileSync(path.join(DIR, 'key.pem')),
  cert: fs.readFileSync(path.join(DIR, 'cert.pem')),
};

// Proxy paths that should be forwarded to Django backend
const PROXY_PREFIXES = ['/deployment/', '/chatbot/', '/api/'];

function proxyRequest(req, res) {
  const target = url.parse(BACKEND);
  const proxyOpts = {
    hostname: target.hostname,
    port: target.port || 80,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: target.host },
  };

  const proxyReq = http.request(proxyOpts, (proxyRes) => {
    // Add CORS headers so browser accepts the response
    const headers = {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502);
    res.end('Proxy error: ' + err.message);
  });

  req.pipe(proxyReq);
}

https.createServer(options, (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // Proxy API requests to Django
  if (PROXY_PREFIXES.some(p => req.url.startsWith(p))) {
    proxyRequest(req, res);
    return;
  }

  // Serve static files
  const filePath = path.join(DIR, req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Content-Type': filePath.endsWith('.html') ? 'text/html' : 'application/octet-stream'
    });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => console.log(`Serving on https://192.168.1.221:${PORT}/`));
