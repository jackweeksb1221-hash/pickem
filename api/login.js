const { crypto, redis, hashPin, sign } = require('./_lib');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
    const { name, pin, code, mode } = req.body || {};
    const clean = String(name || '').trim().slice(0, 24);
    if (!clean || !/^\d{4,8}$/.test(String(pin || '')))
      return res.status(400).json({ error: 'Enter a name and a 4–8 digit PIN.' });
    const key = clean.toLowerCase();
    const existing = await redis('HGET', 'players', key);

    if (mode === 'register') {
      if (existing) return res.status(400).json({ error: 'That name is taken. Log in instead.' });
      if (process.env.LEAGUE_CODE && code !== process.env.LEAGUE_CODE)
        return res.status(403).json({ error: 'Wrong league code.' });
      const salt = crypto.randomBytes(8).toString('hex');
      await redis('HSET', 'players', key, JSON.stringify({ name: clean, salt, hash: hashPin(pin, salt) }));
      return res.json({ token: sign(key), name: clean });
    }

    if (!existing) return res.status(401).json({ error: 'No player with that name. Join the league first.' });
    const p = JSON.parse(existing);
    if (hashPin(pin, p.salt) !== p.hash) return res.status(401).json({ error: 'Wrong PIN.' });
    res.json({ token: sign(key), name: p.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
