// api/gowa.js — Vercel serverless proxy for GoWA v7.8
// All requests from the frontend hit this endpoint; it forwards to the GoWA server.
// This avoids CORS issues and keeps the server URL secret-side.

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const GOWA_BASE = process.env.GOWA_URL || 'http://localhost:3000';
  const GOWA_AUTH = process.env.GOWA_AUTH || ''; // base64 user:pass, leave blank if none

  const { path, ...queryParams } = req.query;
  if (!path) return res.status(400).json({ error: 'Missing path param' });

  const pathStr = Array.isArray(path) ? path.join('/') : path;

  // Build query string from remaining params
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(queryParams)) {
    if (v !== undefined && v !== '') qs.append(k, v);
  }
  const qsStr = qs.toString();
  const targetUrl = `${GOWA_BASE}/${pathStr}${qsStr ? '?' + qsStr : ''}`;

  const headers = { 'Content-Type': 'application/json' };
  if (GOWA_AUTH) headers['Authorization'] = `Basic ${GOWA_AUTH}`;

  try {
    const fetchOpts = {
      method: req.method,
      headers,
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      fetchOpts.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(targetUrl, fetchOpts);
    const contentType = upstream.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const data = await upstream.json();
      return res.status(upstream.status).json(data);
    } else {
      // For QR image or binary responses
      const buf = await upstream.arrayBuffer();
      const ct = contentType || 'application/octet-stream';
      res.setHeader('Content-Type', ct);
      return res.status(upstream.status).send(Buffer.from(buf));
    }
  } catch (err) {
    console.error('GoWA proxy error:', err);
    return res.status(502).json({ error: 'GoWA server unreachable', detail: err.message });
  }
}
