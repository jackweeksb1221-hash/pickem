// Admin panel actions. This is the ONLY place the site calls the Odds API.
// Weekly flow: Refresh lines -> Lock games -> Open picks -> Close picks -> Refresh scores
const L = require('./_lib');

module.exports = async (req, res) => {
  try {
    const { password, action, week, from, to, amount, dweek, id, player, handle, pin, ids, entries } = req.body || {};
    if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD)
      return res.status(401).json({ error: 'Wrong admin password.' });
    const n = Number(week) || L.currentWeek();
    const now = new Date().toISOString();
    const [gRaw0, locked0] = await L.pipe([['GET', `week:${n}:games`], ['GET', `week:${n}:locked`]]);
    const gameCount = gRaw0 ? JSON.parse(gRaw0).length : 0;

    if (action === 'lines') {
      // Refresh lines for games that are NOT locked yet. Locked games keep the line they were locked at.
      const fresh = await L.fetchLines(n);
      const old = gRaw0 ? JSON.parse(gRaw0) : [];
      const byId = Object.fromEntries(old.map(g => [g.id, g]));
      for (const g of fresh) {
        const o = byId[g.id];
        if (o && (o.lineLocked || Date.parse(o.kickoff) <= Date.now())) continue; // locked or already started
        byId[g.id] = o ? { ...g, lineLocked: false } : g;
      }
      const games = Object.values(byId).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
      await L.pipe([['SET', `week:${n}:games`, JSON.stringify(games)], ['SET', `week:${n}:linesAt`, now]]);
    } else if (action === 'lock' || action === 'lockGames') {
      // Lock the lines for specific games (or all of them). Locking is permanent for the week.
      if (!gameCount) return res.status(400).json({ error: 'Refresh lines first. There are no games to lock.' });
      const games = JSON.parse(gRaw0).map(g =>
        (action === 'lock' || (Array.isArray(ids) && ids.includes(g.id))) ? { ...g, lineLocked: true, lockedAt: g.lockedAt || now } : g);
      if (!games.some(g => g.lineLocked)) return res.status(400).json({ error: 'No games selected to lock.' });
      await L.pipe([['SET', `week:${n}:games`, JSON.stringify(games)], ['SET', `week:${n}:locked`, now]]);
    } else if (action === 'manual') {
      // Hand-entered results for a week played before the site existed
      const out = {};
      for (const [k, v] of Object.entries(entries || {})) {
        const pts = Number(v.points) || 0, c = Number(v.correct) || 0, w = Number(v.wrong) || 0;
        if (pts || c || w) out[k] = { points: pts, correct: c, wrong: w };
      }
      if (Object.keys(out).length) await L.redis('SET', `week:${n}:manual`, JSON.stringify(out));
      else await L.redis('DEL', `week:${n}:manual`);
    } else if (action === 'open') {
      if (!(gRaw0 && JSON.parse(gRaw0).some(g => g.lineLocked)) && !locked0)
        return res.status(400).json({ error: 'Lock at least one game before opening picks.' });
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
    } else if (action === 'reset') {
      // Wipe this week: lines, lock, pick window, everyone's picks and scores (money board is untouched)
      await L.redis('DEL', ...['games', 'locked', 'window', 'picks', 'results', 'linesAt', 'scoresAt', 'manual'].map(x => `week:${n}:${x}`));
    } else if (action === 'pin') {
      // Set a new PIN for a player
      const raw = await L.redis('HGET', 'players', player || '');
      if (!raw) return res.status(400).json({ error: 'Player not found.' });
      if (!/^\d{4,8}$/.test(String(pin || ''))) return res.status(400).json({ error: 'PIN must be 4–8 digits.' });
      const p = JSON.parse(raw), salt = L.crypto.randomBytes(8).toString('hex');
      await L.redis('HSET', 'players', player, JSON.stringify({ ...p, salt, hash: L.hashPin(pin, salt) }));
    } else if (action === 'removePlayer') {
      // Remove a player, their Venmo and all their picks (money board entries stay as history)
      if (!player) return res.status(400).json({ error: 'Pick a player.' });
      const cmds = [['HDEL', 'players', player], ['HDEL', 'venmo', player]];
      for (let w = 1; w <= L.currentWeek() + 1; w++) cmds.push(['HDEL', `week:${w}:picks`, player]);
      await L.pipe(cmds);
    } else if (action !== 'status') {
      return res.status(400).json({ error: 'Unknown action.' });
    }

    // Status for the panel (no API call)
    const [gRaw, rRaw, linesAt, scoresAt, quota, locked, win, manualRaw] = await L.pipe([
      ['GET', `week:${n}:games`], ['GET', `week:${n}:results`],
      ['GET', `week:${n}:linesAt`], ['GET', `week:${n}:scoresAt`], ['GET', 'quota'],
      ['GET', `week:${n}:locked`], ['GET', `week:${n}:window`], ['GET', `week:${n}:manual`],
    ]);
    const list = gRaw ? JSON.parse(gRaw) : [];
    const legacy = !!locked && list.every(g => g.lineLocked === undefined);
    res.json({
      week: n,
      games: list.length,
      gameList: list.map(g => ({ id: g.id, home: g.home, away: g.away, kickoff: g.kickoff, lineLocked: !!g.lineLocked || legacy })),
      lockedGames: list.filter(g => g.lineLocked || legacy).length,
      manual: manualRaw ? JSON.parse(manualRaw) : {},
      finals: rRaw ? Object.values(JSON.parse(rRaw)).filter(r => r.final !== false).length : 0,
      linesAt, scoresAt, locked, window: win || 'notopen',
      quota: quota ? JSON.parse(quota) : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
