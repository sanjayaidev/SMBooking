// api/scheduler.js — Vercel KV-backed scheduler for bulk campaigns & trigger rules
// Uses Vercel KV (or falls back to in-memory for dev).
// Frontend calls this to CRUD campaigns and trigger rules.

let _mem = {}; // fallback in-memory store for local dev

async function kvGet(key) {
  if (process.env.KV_REST_API_URL) {
    const r = await fetch(`${process.env.KV_REST_API_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
    });
    const j = await r.json();
    return j.result ? JSON.parse(j.result) : null;
  }
  return _mem[key] ?? null;
}

async function kvSet(key, val) {
  const str = JSON.stringify(val);
  if (process.env.KV_REST_API_URL) {
    await fetch(`${process.env.KV_REST_API_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: str }),
    });
  } else {
    _mem[key] = val;
  }
}

async function kvDel(key) {
  if (process.env.KV_REST_API_URL) {
    await fetch(`${process.env.KV_REST_API_URL}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
    });
  } else {
    delete _mem[key];
  }
}

// ── campaign helpers ──────────────────────────────────────────────
async function getCampaigns() { return (await kvGet('campaigns')) || []; }
async function saveCampaigns(list) { await kvSet('campaigns', list); }

// ── trigger rule helpers ──────────────────────────────────────────
async function getTriggers() { return (await kvGet('triggers')) || []; }
async function saveTriggers(list) { await kvSet('triggers', list); }

// ── scheduled campaign runner (called by cron or frontend poll) ───
async function runDueCampaigns(gowaBase, gowaAuth) {
  const now = Date.now();
  const campaigns = await getCampaigns();
  const headers = { 'Content-Type': 'application/json' };
  if (gowaAuth) headers['Authorization'] = `Basic ${gowaAuth}`;

  let dirty = false;
  const results = [];

  for (const camp of campaigns) {
    if (camp.status !== 'scheduled') continue;
    if (camp.sendAt && new Date(camp.sendAt).getTime() > now) continue;

    // Mark as running
    camp.status = 'running';
    camp.startedAt = new Date().toISOString();
    dirty = true;

    let sent = 0, failed = 0, skipped = 0;

    for (const contact of camp.contacts || []) {
      if (contact.status && contact.status !== 'pending') continue;

      let msg = camp.template || '';
      if (contact.message && camp.msgSource === 'sheet') msg = contact.message;
      msg = msg.replace(/\{name\}/gi, contact.name || contact.phone);

      try {
        const r = await fetch(`${gowaBase}/send/message`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ phone: contact.phone, message: msg }),
        });
        const j = await r.json();
        if (j.code === 200 || j.status === 'success' || r.ok) {
          contact.status = 'sent';
          sent++;
        } else {
          contact.status = 'failed';
          failed++;
        }
      } catch {
        contact.status = 'failed';
        failed++;
      }

      // Randomised gap 10-30s for scheduled campaigns (less aggressive than live)
      const gap = 10000 + Math.random() * 20000;
      await new Promise(r => setTimeout(r, gap));
    }

    camp.status = 'done';
    camp.finishedAt = new Date().toISOString();
    camp.stats = { sent, failed, skipped };
    results.push({ id: camp.id, sent, failed, skipped });
  }

  if (dirty) await saveCampaigns(campaigns);
  return results;
}

// ── webhook trigger matcher ────────────────────────────────────────
async function handleIncomingWebhook(payload, gowaBase, gowaAuth) {
  const triggers = await getTriggers();
  const active = triggers.filter(t => t.enabled);
  if (!active.length) return [];

  const headers = { 'Content-Type': 'application/json' };
  if (gowaAuth) headers['Authorization'] = `Basic ${gowaAuth}`;

  const event = payload?.event || '';
  const msgText = (payload?.payload?.text?.body || payload?.payload?.message || '').toLowerCase().trim();
  const senderPhone = (payload?.payload?.info?.remote_jid || payload?.payload?.from || '')
    .replace('@s.whatsapp.net', '').replace(/\D/g, '');

  const fired = [];

  for (const t of active) {
    let matches = false;

    if (t.triggerType === 'keyword') {
      if (!msgText) continue;
      const keywords = (t.keywords || '').toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
      const matchMode = t.matchMode || 'contains';
      matches = keywords.some(kw => {
        if (matchMode === 'exact') return msgText === kw;
        if (matchMode === 'starts') return msgText.startsWith(kw);
        return msgText.includes(kw);
      });
    } else if (t.triggerType === 'webhook') {
      // External webhook — matches if event type matches
      const allowedEvents = (t.webhookEvents || 'message').split(',').map(e => e.trim());
      matches = allowedEvents.some(e => event.startsWith(e));
    }

    if (!matches) continue;

    const replyTo = t.replyPhone || senderPhone;
    if (!replyTo) continue;

    let msg = t.replyMessage || '';
    msg = msg.replace(/\{name\}/gi, payload?.payload?.push_name || replyTo);
    msg = msg.replace(/\{phone\}/gi, replyTo);

    try {
      const r = await fetch(`${gowaBase}/send/message`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ phone: replyTo, message: msg }),
      });
      const j = await r.json();
      fired.push({ triggerId: t.id, to: replyTo, ok: r.ok, resp: j });

      // Mark last fired
      t.lastFiredAt = new Date().toISOString();
      t.fireCount = (t.fireCount || 0) + 1;
    } catch (e) {
      fired.push({ triggerId: t.id, to: replyTo, ok: false, error: e.message });
    }
  }

  if (fired.length) await saveTriggers(triggers);
  return fired;
}

// ── main handler ──────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const GOWA_BASE = process.env.GOWA_URL || 'http://localhost:3000';
  const GOWA_AUTH = process.env.GOWA_AUTH || '';

  const { action } = req.query;
  const body = req.body || {};

  try {
    // ── Campaign CRUD ─────────────────────────────────────────────
    if (action === 'listCampaigns') {
      return res.json({ success: true, campaigns: await getCampaigns() });
    }

    if (action === 'saveCampaign') {
      const camps = await getCampaigns();
      const idx = camps.findIndex(c => c.id === body.id);
      if (idx >= 0) camps[idx] = { ...camps[idx], ...body };
      else camps.push({ id: body.id || `camp_${Date.now()}`, createdAt: new Date().toISOString(), ...body });
      await saveCampaigns(camps);
      return res.json({ success: true });
    }

    if (action === 'deleteCampaign') {
      const camps = (await getCampaigns()).filter(c => c.id !== body.id);
      await saveCampaigns(camps);
      return res.json({ success: true });
    }

    if (action === 'runCampaign') {
      // Immediately run a specific campaign (override sendAt)
      const camps = await getCampaigns();
      const camp = camps.find(c => c.id === body.id);
      if (!camp) return res.status(404).json({ success: false, error: 'Campaign not found' });
      camp.status = 'scheduled';
      camp.sendAt = null;
      await saveCampaigns(camps);
      const results = await runDueCampaigns(GOWA_BASE, GOWA_AUTH);
      return res.json({ success: true, results });
    }

    if (action === 'runDue') {
      const results = await runDueCampaigns(GOWA_BASE, GOWA_AUTH);
      return res.json({ success: true, results });
    }

    // ── Trigger CRUD ──────────────────────────────────────────────
    if (action === 'listTriggers') {
      return res.json({ success: true, triggers: await getTriggers() });
    }

    if (action === 'saveTrigger') {
      const triggers = await getTriggers();
      const idx = triggers.findIndex(t => t.id === body.id);
      if (idx >= 0) triggers[idx] = { ...triggers[idx], ...body };
      else triggers.push({ id: body.id || `trig_${Date.now()}`, createdAt: new Date().toISOString(), fireCount: 0, ...body });
      await saveTriggers(triggers);
      return res.json({ success: true });
    }

    if (action === 'deleteTrigger') {
      const triggers = (await getTriggers()).filter(t => t.id !== body.id);
      await saveTriggers(triggers);
      return res.json({ success: true });
    }

    if (action === 'toggleTrigger') {
      const triggers = await getTriggers();
      const t = triggers.find(t => t.id === body.id);
      if (t) t.enabled = body.enabled ?? !t.enabled;
      await saveTriggers(triggers);
      return res.json({ success: true });
    }

    // ── Webhook receiver (GoWA calls this URL) ────────────────────
    if (action === 'webhook') {
      const fired = await handleIncomingWebhook(body, GOWA_BASE, GOWA_AUTH);
      return res.json({ success: true, fired });
    }

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('Scheduler error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
