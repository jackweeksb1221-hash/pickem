// Shared helpers. Files starting with "_" are not turned into URLs by Vercel.
const crypto = require('crypto');

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET = process.env.SESSION_SECRET || 'change-me';
const ODDS_KEY = process.env.ODDS_API_KEY;
const SPORT = process.env.SPORT || 'americanfootball_nfl';
// Tuesday before NFL week 1. Weeks run Tuesday -> Monday.
const SEASON_START = new Date(process.env.SEASON_START || '2026-09-08T09:00:00Z');
const WEEK_MS = 7 * 24 * 3600 * 1000;

// ---------- database (Upstash Redis REST, no packages needed) ----------
async function redis(...cmd) {
  const r = await fetch(DB_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DB_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function pipe(cmds) {
  if (!cmds.length) return [];
  const r = await fetch(DB_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: `Bearer ${DB_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(j.error || 'Database error');
  return j.map(x => x.result);
}
function parseHash(arr) {
  const o = {};
  for (let i = 0; arr && i < arr.length; i += 2) o[arr[i]] = JSON.parse(arr[i + 1]);
  return o;
}

// ---------- weeks ----------
function currentWeek() {
  return Math.max(1, Math.floor((Date.now() - SEASON_START) / WEEK_MS) + 1);
}
function weekRange(n) {
  const s = new Date(SEASON_START.getTime() + (n - 1) * WEEK_MS);
  return [s, new Date(s.getTime() + WEEK_MS)];
}

// ---------- Odds API (only called from the admin panel) ----------
async function oddsFetch(url) {
  if (!ODDS_KEY) throw new Error('ODDS_API_KEY is not set in Vercel');
  const r = await fetch(url);
  if (!r.ok) throw new Error('Odds API error ' + r.status + ': ' + (await r.text()));
  const remaining = r.headers.get('x-requests-remaining'), used = r.headers.get('x-requests-used');
  if (remaining !== null) await redis('SET', 'quota', JSON.stringify({ remaining, used, at: new Date().toISOString() }));
  return r.json();
}

// ---------- lines: whole numbers get an extra .5 so there are no ties ----------
function fixLine(x) {
  if (!Number.isInteger(x)) return x;
  if (x > 0) return x + 0.5;   // +6 -> +6.5, total 43 -> 43.5
  if (x < 0) return x - 0.5;   // -6 -> -6.5 (other side becomes +6.5)
  return 0.5;                  // pick'em -> home +0.5
}

async function fetchLines(n) {
  const [from, to] = weekRange(n);
  const iso = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds/?apiKey=${ODDS_KEY}` +
    `&regions=us&markets=spreads,totals&oddsFormat=american` +
    `&commenceTimeFrom=${iso(from)}&commenceTimeTo=${iso(to)}`;
  const events = await oddsFetch(url);
  return events.map(e => {
    let spread = null, total = null;
    const books = [...(e.bookmakers || [])].sort((a, b) => (b.key === 'draftkings') - (a.key === 'draftkings'));
    for (const b of books) {
      for (const m of b.markets || []) {
        if (m.key === 'spreads' && spread === null) {
          const o = m.outcomes.find(o => o.name === e.home_team);
          if (o && o.point != null) spread = o.point;
        }
        if (m.key === 'totals' && total === null) {
          const o = m.outcomes.find(o => o.name === 'Over');
          if (o && o.point != null) total = o.point;
        }
      }
      if (spread !== null && total !== null) break;
    }
    return {
      id: e.id, home: e.home_team, away: e.away_team, kickoff: e.commence_time,
      spread: spread === null ? null : fixLine(spread), // spread is for the HOME team
      total: total === null ? null : fixLine(total),
    };
  }).filter(g => g.spread !== null || g.total !== null)
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
}

// Only reads saved lines. New lines come from the admin panel's "Refresh lines" button.
async function getGames(n) {
  const saved = await redis('GET', `week:${n}:games`);
  return saved ? JSON.parse(saved) : [];
}

// ---------- scores ----------
async function gradeWeeks(weeks) {
  const scores = await oddsFetch(`https://api.the-odds-api.com/v4/sports/${SPORT}/scores/?apiKey=${ODDS_KEY}&daysFrom=3`);
  const byId = {};
  for (const s of scores) byId[s.id] = s;
  let count = 0;
  for (const n of weeks) {
    if (n < 1) continue;
    const [gRaw, rRaw] = await pipe([['GET', `week:${n}:games`], ['GET', `week:${n}:results`]]);
    if (!gRaw) continue;
    const games = JSON.parse(gRaw), results = rRaw ? JSON.parse(rRaw) : {};
    let changed = false;
    for (const g of games) {
      const s = byId[g.id];
      if (!s || !s.scores) continue;
      if (results[g.id] && results[g.id].final !== false) continue; // already final
      const h = s.scores.find(x => x.name === g.home), a = s.scores.find(x => x.name === g.away);
      if (!h || !a) continue;
      results[g.id] = { home: Number(h.score), away: Number(a.score), final: !!s.completed };
      changed = true; if (s.completed) count++;
    }
    if (changed) await redis('SET', `week:${n}:results`, JSON.stringify(results));
  }
  return count;
}

// ---------- scoring ----------
// Correct: 1x = 1, 2x = 2, 3x = 3.  Wrong: 1x = 0, 2x = -1, 3x = -2.
function gradePick(g, res, p) {
  const hs = res.home, as = res.away;
  let win;
  if (p.pick === 'home') win = hs + g.spread > as;
  else if (p.pick === 'away') win = as - g.spread > hs;
  else if (p.pick === 'over') win = hs + as > g.total;
  else win = hs + as < g.total;
  const m = p.mult || 1;
  return { win, pts: win ? m : (m === 1 ? 0 : m === 2 ? -1 : -2) };
}
// Official points only count FINAL games. includeLive also counts games in progress ("if it ended now").
function tally(games, picks, results, names, into = {}, includeLive = false) {
  for (const k of Object.keys(names)) into[k] = into[k] || { key: k, name: names[k], correct: 0, wrong: 0, points: 0 };
  const byId = Object.fromEntries(games.map(g => [g.id, g]));
  for (const [k, pk] of Object.entries(picks)) {
    if (!into[k]) continue;
    for (const [gid, p] of Object.entries(pk)) {
      const g = byId[gid], r = results[gid];
      if (!g || !r || (r.final === false && !includeLive)) continue;
      const x = gradePick(g, r, p);
      x.win ? into[k].correct++ : into[k].wrong++;
      into[k].points += x.pts;
    }
  }
  return into;
}
// Hand-entered results for weeks that were played before the site existed
function addManual(manual, into, names) {
  for (const [k, m] of Object.entries(manual || {})) {
    if (!names[k]) continue;
    into[k] = into[k] || { key: k, name: names[k], correct: 0, wrong: 0, points: 0 };
    into[k].points += Number(m.points) || 0;
    into[k].correct += Number(m.correct) || 0;
    into[k].wrong += Number(m.wrong) || 0;
    into[k].manual = true;
  }
  return into;
}
const sortRows = o => Object.values(o).sort((a, b) =>
  b.points - a.points || b.correct - a.correct || a.name.localeCompare(b.name));

// ---------- login ----------
function hashPin(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
function sign(key) {
  const p = Buffer.from(key).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
}
function whoAmI(req) {
  const [p, s] = (req.headers.authorization || '').replace('Bearer ', '').split('.');
  if (!p || !s) return null;
  const good = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  return s === good ? Buffer.from(p, 'base64url').toString() : null;
}

module.exports = {
  crypto, redis, pipe, parseHash, currentWeek, weekRange, fetchLines, getGames,
  gradeWeeks, gradePick, tally, addManual, sortRows, hashPin, sign, whoAmI,
};
