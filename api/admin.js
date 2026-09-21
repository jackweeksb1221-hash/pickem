// Admin panel actions. This is the ONLY place the site calls the Odds API.
// Weekly flow: Refresh lines -> Lock lines (permanent) -> Open picks -> Close picks -> Refresh scores
const L = require('./_lib');

module.exports = async (req, res) => {
  try {
    const { password, action, week, from, to, amount, dweek, id, player, handle } = req.body || {};
    if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD)
      return res.status(401).json({ error: 'Wrong admin password.' });
    const n = Number(week) || L.currentWeek();
    const now = new Date().toISOString();
    const [gRaw0, locked0] = await L.pipe([['GET', `week:${n}:games`], ['GET', `week:${n}:locked`]]);
    const gameCount = gRaw0 ? JSON.parse(gRaw0).length : 0;

    if (action === 'lines') {
      if (locked0) return res.status(400).json({ error: `Week ${n} lines are locked and can't change.` });
      const games = await L.fetchLines(n);
      await L.pipe([['SET', `week:${n}:games`, JSON.stringify(games)], ['SET', `week:${n}:linesAt`, now]]);
    } else if (action === 'lock') {
      if (!gameCount) return res.status(400).json({ error: 'Refresh lines first. There are no games to lock.' });
      await L.redis('SET', `week:${n}:locked`, now, 'NX');
    } else if (action === 'open') {
      if (!locked0) return res.status(400).json({ error: 'Lock the lines before opening picks.' });
      await L.redis('SET', `week:${n}:window`, 'open');
    } else if (action === 'close') {
      await L.redis('SET', `week:${n}:window`, 'closed');
    } else if (action === 'scores') {
      await L.gradeWeeks([n]);
      await L.redis('SET', `week:${n}:scoresAt`, now);
    } else if (action === 'debtAdd') {
      // Money board: who owes who
      const amt = Math.round(Number(amount) * 100) / 100;
      if (!from || !to || from === to || !(amt > 0))
        return res.status(400).json({ error: 'Pick two different players and an amount.' });
      const list = JSON.parse((await L.redis('GET', 'debts')) || '[]');
      list.push({ id: L.crypto.randomBytes(4).toString('hex'), week: Number(dweek) || n, from, to, amount: amt, paid: false });
      await L.redis('SET', 'debts', JSON.stringify(list));
    } else if (action === 'debtPaid' || action === 'debtDelete') {
      let list = JSON.parse((await L.redis('GET', 'debts')) || '[]');
      if (action === 'debtDelete') list = list.filter(d => d.id !== id);
      else list = list.map(d => d.id === id ? { ...d, paid: !d.paid, paidAt: d.paid ? null : now } : d);
      await L.redis('SET', 'debts', JSON.stringify(list));
    } else if (action === 'venmo') {
      // Save (or clear) a player's Venmo handle
      const h = String(handle || '').trim().replace(/^@/, '');
      if (!player) return res.status(400).json({ error: 'Pick a player.' });
      if (h && !/^[A-Za-z0-9_-]{2,30}$/.test(h)) return res.status(400).json({ error: 'Venmo handles use only letters, numbers, - and _.' });
      if (h) await L.redis('HSET', 'venmo', player, JSON.stringify(h));
      else await L.redis('HDEL', 'venmo', player);
    } else if (action !== 'status') {
      return res.status(400).json({ error: 'Unknown action.' });
    }

    // Status for the panel (no API call)
    const [gRaw, rRaw, linesAt, scoresAt, quota, locked, win] = await L.pipe([
      ['GET', `week:${n}:games`], ['GET', `week:${n}:results`],
      ['GET', `week:${n}:linesAt`], ['GET', `week:${n}:scoresAt`], ['GET', 'quota'],
      ['GET', `week:${n}:locked`], ['GET', `week:${n}:window`],
    ]);
    res.json({
      week: n,
      games: gRaw ? JSON.parse(gRaw).length : 0,
      finals: rRaw ? Object.keys(JSON.parse(rRaw)).length : 0,
      linesAt, scoresAt, locked, window: win || 'notopen',
      quota: quota ? JSON.parse(quota) : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
