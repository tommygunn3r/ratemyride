// ─── LEADERBOARD ENDPOINT ─────────────────────────────────────
// GET /api/leaderboard
// Returns the leaderboard manifest from Vercel Blob.
// Keeps BLOB_READ_WRITE_TOKEN server-side.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    // No blob configured — return empty manifest so the UI degrades gracefully
    return res.status(200).json({
      regular: { top10: [], bottom10: [] },
      beast:   { top10: [], bottom10: [] }
    });
  }

  let list;
  try {
    ({ list } = await import('@vercel/blob'));
  } catch {
    return res.status(500).json({ error: 'Blob storage unavailable.' });
  }

  try {
    const { blobs } = await list({ prefix: 'leaderboard/manifest.json' });

    if (blobs.length === 0) {
      return res.status(200).json({
        regular: { top10: [], bottom10: [] },
        beast:   { top10: [], bottom10: [] }
      });
    }

    // Fetch manifest from blob (bust cache with timestamp)
    const manifestRes = await fetch(`${blobs[0].url}?t=${Date.now()}`);
    if (!manifestRes.ok) {
      return res.status(502).json({ error: 'Could not fetch leaderboard manifest.' });
    }

    const manifest = await manifestRes.json();
    return res.status(200).json(manifest);
  } catch (err) {
    console.error('Leaderboard fetch error:', err);
    return res.status(500).json({ error: 'Failed to load leaderboard.' });
  }
}
