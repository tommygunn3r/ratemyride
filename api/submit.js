// ─── SUBMIT TO LEADERBOARD ────────────────────────────────────
// POST /api/submit
// Body: { result, images: [{data, mimeType}], beastMode }
// Stores the result in Vercel Blob and updates the manifest.

import { createHash } from 'crypto';

const RATE_LIMIT_HOURS = 24;

function badgeLabel(total) {
  if (total <= 2500) return 'Exceptional Specimen';
  if (total <= 5000) return 'Adequate';
  if (total <= 7500) return 'Concerning';
  return 'A Cry For Help';
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return fwd ? fwd.split(',')[0].trim() : (req.socket?.remoteAddress || 'unknown');
}

// Store a short hash of the IP rather than the raw address
function hashIp(ip) {
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

async function readManifest(list) {
  const empty = {
    regular:    { top10: [], bottom10: [] },
    beast:      { top10: [], bottom10: [] },
    recent_ips: []
  };
  const { blobs } = await list({ prefix: 'leaderboard/manifest.json' });
  if (blobs.length === 0) return empty;
  try {
    const res = await fetch(`${blobs[0].url}?t=${Date.now()}`);
    const m = await res.json();
    if (!m.recent_ips) m.recent_ips = [];
    return m;
  } catch {
    return empty;
  }
}

async function storeResult(result, images, beastMode, ipHash, manifest) {
  const { put, del } = await import('@vercel/blob');

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  // Upload each image
  const imageUrls = [];
  for (let i = 0; i < images.length; i++) {
    const buf = Buffer.from(images[i].data, 'base64');
    const { url } = await put(`images/${id}_${i}.jpg`, buf, {
      access: 'public',
      contentType: 'image/jpeg',
      addRandomSuffix: false
    });
    imageUrls.push(url);
  }

  // Upload result JSON
  const resultPayload = {
    ...result,
    id,
    beast: beastMode,
    timestamp: new Date().toISOString(),
    image_urls: imageUrls
  };
  const { url: resultUrl } = await put(`results/${id}.json`, JSON.stringify(resultPayload), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false
  });

  const board = beastMode ? manifest.beast : manifest.regular;
  const newEntry = {
    id,
    score: result.total_score,
    car_name: result.car_name,
    pull_quote: result.pull_quote || '',
    badge: badgeLabel(result.total_score),
    beast: beastMode,
    timestamp: new Date().toISOString(),
    image_urls: imageUrls,
    result_url: resultUrl
  };

  // Build a unified pool of all unique entries (no duplicates between lists)
  const pool = new Map();
  [...board.top10, ...board.bottom10].forEach(e => pool.set(e.id, e));
  pool.set(id, newEntry);

  // Split pool evenly: best half → top10, worst half → bottom10 (each capped at 10)
  // This guarantees no entry appears in both lists regardless of pool size
  const sorted = [...pool.values()].sort((a, b) => a.score - b.score);
  const total   = sorted.length;
  const topCount = Math.min(10, Math.ceil(total / 2));
  const botCount = Math.min(10, Math.floor(total / 2));

  board.top10    = sorted.slice(0, topCount);
  board.bottom10 = sorted.slice(total - botCount).reverse(); // sorted DESC (worst first)

  // Delete blobs for any entry no longer in either list (middle entries that fell off)
  const activeIds = new Set([
    ...board.top10.map(e => e.id),
    ...board.bottom10.map(e => e.id)
  ]);
  for (const e of sorted) {
    if (!activeIds.has(e.id)) {
      const toDelete = [...(e.image_urls || []), e.result_url].filter(Boolean);
      if (toDelete.length > 0) {
        try { await del(toDelete); } catch { /* non-fatal */ }
      }
    }
  }

  // Prune expired IP entries, then record this submission
  const cutoff = Date.now() - RATE_LIMIT_HOURS * 60 * 60 * 1000;
  manifest.recent_ips = (manifest.recent_ips || [])
    .filter(e => new Date(e.ts).getTime() > cutoff);
  manifest.recent_ips.push({ ip: ipHash, ts: new Date().toISOString(), id });

  // Write updated manifest
  await put('leaderboard/manifest.json', JSON.stringify(manifest), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false
  });

  const inTop10    = board.top10.some(e => e.id === id);
  const inBottom10 = board.bottom10.some(e => e.id === id);
  return { id, inTop10, inBottom10 };
}

// ─── HANDLER ──────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({ error: 'Leaderboard storage is not configured.' });
  }

  const { result, images, beastMode } = req.body;

  if (!result || !images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (result.valid !== true) {
    return res.status(400).json({ error: 'Only valid results can be submitted.' });
  }

  const { list } = await import('@vercel/blob');
  const ipHash   = hashIp(getClientIp(req));
  const manifest = await readManifest(list);

  // Rate limit — one submission per IP per RATE_LIMIT_HOURS
  const cutoff = Date.now() - RATE_LIMIT_HOURS * 60 * 60 * 1000;
  const recent = (manifest.recent_ips || []).filter(e => new Date(e.ts).getTime() > cutoff);
  if (recent.some(e => e.ip === ipHash)) {
    return res.status(429).json({
      error: `One submission per ${RATE_LIMIT_HOURS} hours. CARR-9000 has already rendered its verdict on you today. Come back tomorrow.`
    });
  }

  try {
    const stored = await storeResult(result, images, !!beastMode, ipHash, manifest);
    return res.status(200).json({ success: true, ...stored });
  } catch (err) {
    console.error('Submit error:', err);
    return res.status(500).json({ error: 'Submission failed. Please try again.' });
  }
}
