// Weekly automation: refresh this week's lines from the Odds API and lock every
// game, so the board and the Odds column populate on their own once the week starts.
// Called by Vercel Cron (see vercel.json) with Authorization: Bearer $CRON_SECRET.
// The admin panel stays as the manual override; locked lines are never changed here.
const L = require('./_lib');

module.exports = async (req, res) => {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`)
      return res.status(401).json({ error: 'Unauthorized' });

    const n = L.currentWeek();
    const now = new Date().toISOString();
    const t = Date.now();

    // Refresh lines for games that aren't locked yet (locked or started games keep their line)
    let fresh = [];
    try {
      fresh = await L.fetchLines(n);
    } catch (e) {
      return res.status(502).json({ error: 'Odds API: ' + e.message });
    }
    const gRaw0 = await L.redis('GET', `week:${n}:games`);
    const old = gRaw0 ? JSON.parse(gRaw0) : [];
    const byId = Object.fromEntries(old.map(g => [g.id, g]));
    for (const g of fresh) {
      const o = byId[g.id];
      if (o && (o.lineLocked || Date.parse(o.kickoff) <= t)) continue;
      byId[g.id] = o ? { ...g, lineLocked: false } : g;
    }

    // Lock every unlocked game so the week's board is complete from the start
    let lockedNow = 0;
    const games = Object.values(byId)
      .sort((a, b) => a.kickoff.localeCompare(b.kickoff))
      .map(g => {
        if (!g.lineLocked) { lockedNow++; return { ...g, lineLocked: true, lockedAt: g.lockedAt || now }; }
        return g;
      });

    await L.pipe([
      ['SET', `week:${n}:games`, JSON.stringify(games)],
      ['SET', `week:${n}:linesAt`, now],
      ['SET', `week:${n}:locked`, now],
    ]);
    res.json({ week: n, games: games.length, locked: lockedNow, at: now });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
