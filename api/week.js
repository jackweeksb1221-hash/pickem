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
    const isManual = Object.keys(manual).length > 0;
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
    // Weekly winners: winners don't pay — the pot is $10 from every player who
    // didn't win, split among the winners (win alone: $60, two-way tie: $25 each).
    const playerCount = Math.max(1, Object.keys(names).length);
    const wins = {};
    let decidedWeeks = 0;
    const awardWeek = rowsObj => {
      const rows = Object.values(rowsObj);
      if (!rows.some(r => r.correct + r.wrong > 0 || r.points !== 0)) return;   // nobody picked: no winner, no pot
      decidedWeeks++;
      const best = Math.max(...rows.map(r => r.points));
      const champs = rows.filter(r => r.points === best);
      const share = 10 * (playerCount - champs.length) / champs.length;
      for (const c of champs) {
        wins[c.key] = wins[c.key] || { weeksWon: 0, money: 0 };
        wins[c.key].weeksWon += 1;
        wins[c.key].money += share;
      }
    };
    for (let i = 0; i < out.length; i += 4) {
      // A week with hand-entered results uses ONLY those numbers; the system's graded picks for that week are ignored
      const wkManual = JSON.parse(out[i + 3] || '{}');
      if (Object.keys(wkManual).length) {
        L.addManual(wkManual, season, names);
        awardWeek(L.addManual(wkManual, L.tally([], {}, {}, names), names));
      } else {
        const wkGames = JSON.parse(out[i] || '[]'), wkPicks = L.parseHash(out[i + 1]), wkResults = JSON.parse(out[i + 2] || '{}');
        L.tally(wkGames, wkPicks, wkResults, names, season);
        // A week only crowns a winner once every game in it is final
        if (wkGames.length && wkGames.every(g => wkResults[g.id] && wkResults[g.id].final !== false))
          awardWeek(L.tally(wkGames, wkPicks, wkResults, names));
      }
    }

    res.json({
      week: n, currentWeek: cur, locked: games.length > 0, lockedGames: games.length, totalGames: all.length, window: windowState, range: L.weekRange(n),
      me: names[me] ? me : null, myName: names[me] || null,
      games, results, picks: visible, players: names,
      unlocked: legacy ? [] : all.filter(g => !g.lineLocked).map(g => g.id),
      manualWeek: isManual,
      weekStandings: (() => {
        if (isManual) { // hand-entered results replace the system's results for this week
          const off = L.addManual(manual, L.tally([], {}, {}, names), names);
          return L.sortRows(off).map(r => ({ ...r, live: r.points }));
        }
        const live = L.tally(games, picks, results, names, {}, true);
        const off = L.tally(games, picks, results, names);
        return L.sortRows(off).map(r => ({ ...r, live: live[r.key].points }));
      })(),
      hasLive: !isManual && Object.values(results).some(r => r.final === false),
      season: L.sortByPct(season),
      weeklyWins: Object.entries(names)
        .map(([k, name]) => {
          const w = wins[k] || { weeksWon: 0, money: 0 };
          const money = Math.round(w.money * 100) / 100;
          return { key: k, name, weeksWon: w.weeksWon, money, net: Math.round((money - 10 * (decidedWeeks - w.weeksWon)) * 100) / 100 };
        })
        .sort((a, b) => b.weeksWon - a.weeksWon || b.money - a.money || a.name.localeCompare(b.name)),
      debts: debtsRaw ? JSON.parse(debtsRaw) : [],
      venmo: L.parseHash(venmoRaw),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

