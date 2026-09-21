const L = require('./_lib');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
    const me = L.whoAmI(req);
    if (!me) return res.status(401).json({ error: 'Log in first.' });
    const n = Number((req.body || {}).week) || L.currentWeek();
    const incoming = (req.body || {}).picks || {};
    const [gRaw, oldRaw, win] = await L.pipe([['GET', `week:${n}:games`], ['HGET', `week:${n}:picks`, me], ['GET', `week:${n}:window`]]);
    if (win !== 'open') return res.status(400).json({ error: 'Picks are not open for this week.' });
    const games = JSON.parse(gRaw || '[]'), old = JSON.parse(oldRaw || '{}');
    const now = Date.now(), merged = {};

    for (const g of games) {
      const locked = Date.parse(g.kickoff) <= now;
      const p = locked ? old[g.id] : incoming[g.id]; // started games can't change
      if (!p || !['home', 'away', 'over', 'under'].includes(p.pick)) continue;
      if ((p.pick === 'home' || p.pick === 'away') && g.spread == null) continue;
      if ((p.pick === 'over' || p.pick === 'under') && g.total == null) continue;
      merged[g.id] = { pick: p.pick, mult: [1, 2, 3].includes(p.mult) ? p.mult : 1 };
    }

    const all = Object.values(merged);
    if (all.filter(p => p.mult === 2).length > 1 || all.filter(p => p.mult === 3).length > 1)
      return res.status(400).json({ error: 'Only one 2x and one 3x per week. One may already be locked on a started game.' });

    await L.redis('HSET', `week:${n}:picks`, me, JSON.stringify(merged));
    res.json({ ok: true, picks: merged });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
