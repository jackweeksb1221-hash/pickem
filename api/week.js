const L = require('./_lib');

module.exports = async (req, res) => {
  try {
    const cur = L.currentWeek();
    const n = parseInt(req.query.week) || cur;
    const me = L.whoAmI(req);
    const now = Date.now();
    const [playersRaw, picksRaw, resultsRaw, locked, win, debtsRaw, venmoRaw, manualRaw] = await L.pipe([
      ['HGETALL', 'players'], ['HGETALL', `week:${n}:picks`], ['GET', `week:${n}:results`],
      ['GET', `week:${n}:locked`], ['GET', `week:${n}:window`], ['GET', 'debts'], ['HGETALL', 'venmo'], ['GET', `week:${n}:manual`],
    ]);
    // Players only see a game once its line is locked (older weeks: the whole week was locked at once)
    const all = await L.getGames(n);
    const legacy = !!locked && all.every(g => g.lineLocked === undefined);
    const games = all.filter(g => g.lineLocked || legacy);
    const manual = manualRaw ? JSON.parse(manualRaw) : {};
    const windowState = win || 'notopen';
    const results = resultsRaw ? JSON.parse(resultsRaw) : {};

    const players = L.parseHash(playersRaw);
    const names = Object.fromEntries(Object.entries(players).map(([k, p]) => [k, p.name]));
    const picks = L.parseHash(picksRaw);

    // Other players' picks stay hidden until the admin closes picks (or that game kicks off)
    const started = id => { const g = games.find(g => g.id === id); return windowState === 'closed' || (g && Date.parse(g.kickoff) <= now); };
    const visible = {};
    for (const [k, pk] of Object.entries(picks)) {
      visible[k] = {};
      for (const [gid, p] of Object.entries(pk)) visible[k][gid] = (k === me || started(gid)) ? p : { hidden: true };
    }

    // Season totals
    const cmds = [];
    for (let w = 1; w <= cur; w++)
      cmds.push(['GET', `week:${w}:games`], ['HGETALL', `week:${w}:picks`], ['GET', `week:${w}:results`], ['GET', `week:${w}:manual`]);
    const out = await L.pipe(cmds);
    const season = {};
    L.tally([], {}, {}, names, season);
    for (let i = 0; i < out.length; i += 4) {
      L.tally(JSON.parse(out[i] || '[]'), L.parseHash(out[i + 1]), JSON.parse(out[i + 2] || '{}'), names, season);
      L.addManual(JSON.parse(out[i + 3] || '{}'), season, names);
    }

    res.json({
      week: n, currentWeek: cur, locked: games.length > 0, lockedGames: games.length, totalGames: all.length, window: windowState, range: L.weekRange(n),
      me: names[me] ? me : null, myName: names[me] || null,
      games, results, picks: visible, players: names,
      weekStandings: (() => {
        const live = L.addManual(manual, L.tally(games, picks, results, names, {}, true), names);
        const off = L.addManual(manual, L.tally(games, picks, results, names), names);
        return L.sortRows(off).map(r => ({ ...r, live: live[r.key].points }));
      })(),
      hasLive: Object.values(results).some(r => r.final === false),
      season: L.sortRows(season),
      debts: debtsRaw ? JSON.parse(debtsRaw) : [],
      venmo: L.parseHash(venmoRaw),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
