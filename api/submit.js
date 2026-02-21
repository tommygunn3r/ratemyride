// ─── SUBMIT TO LEADERBOARD ────────────────────────────────────
// POST /api/submit
// Body: { result, images: [{data, mimeType}], beastMode }
// Stores the result in Vercel Blob and updates the manifest.

function badgeLabel(total) {
  if (total <= 2500) return 'Exceptional Specimen';
  if (total <= 5000) return 'Adequate';
  if (total <= 7500) return 'Concerning';
  return 'A Cry For Help';
}

async function storeResult(result, images, beastMode) {
  const { put, list, del } = await import('@vercel/blob');

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

  // Read current manifest
  const { blobs } = await list({ prefix: 'leaderboard/manifest.json' });
  let manifest = {
    regular: { top10: [], bottom10: [] },
    beast:   { top10: [], bottom10: [] }
  };
  if (blobs.length > 0) {
    try {
      const res = await fetch(`${blobs[0].url}?t=${Date.now()}`);
      manifest = await res.json();
    } catch { /* start fresh */ }
  }

  const board = beastMode ? manifest.beast : manifest.regular;
  const entry = {
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

  // Top 10 — lowest scores (best cars)
  board.top10.push(entry);
  board.top10.sort((a, b) => a.score - b.score);
  const droppedFromTop = board.top10.length > 10 ? board.top10.splice(10) : [];

  // Bottom 10 — highest scores (worst cars)
  board.bottom10.push(entry);
  board.bottom10.sort((a, b) => b.score - a.score);
  const droppedFromBottom = board.bottom10.length > 10 ? board.bottom10.splice(10) : [];

  // Clean up blobs for entries knocked off both lists
  const activeIds = new Set([
    ...board.top10.map(e => e.id),
    ...board.bottom10.map(e => e.id)
  ]);
  for (const dropped of [...droppedFromTop, ...droppedFromBottom]) {
    if (!activeIds.has(dropped.id)) {
      const toDelete = [...(dropped.image_urls || []), dropped.result_url].filter(Boolean);
      if (toDelete.length > 0) {
        try { await del(toDelete); } catch { /* non-fatal */ }
      }
    }
  }

  // Write updated manifest
  await put('leaderboard/manifest.json', JSON.stringify(manifest), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false
  });

  // Return which section this entry landed in
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

  try {
    const stored = await storeResult(result, images, !!beastMode);
    return res.status(200).json({ success: true, ...stored });
  } catch (err) {
    console.error('Submit error:', err);
    return res.status(500).json({ error: 'Submission failed. Please try again.' });
  }
}
