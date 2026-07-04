import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_appearances (
      address TEXT NOT NULL,
      count INTEGER NOT NULL,
      seen_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_wallet_appearances_seen_at
    ON wallet_appearances (seen_at)
  `);

  // Purge des apparitions sorties de la fenêtre glissante de 48h.
  await pool.query(`
    DELETE FROM wallet_appearances
    WHERE seen_at < NOW() - INTERVAL '48 hours'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_scores (
      address TEXT PRIMARY KEY,
      score NUMERIC,
      sortino NUMERIC,
      profit_factor NUMERIC,
      diversification NUMERIC,
      recence NUMERIC,
      coherence NUMERIC,
      winrate NUMERIC,
      trades_count INTEGER,
      trades_per_day NUMERIC,
      hold_time_avg NUMERIC,
      drawdown_max NUMERIC,
      pnl_48h NUMERIC,
      boite TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS active_slots (
      slot_id INTEGER PRIMARY KEY,
      address TEXT,
      score NUMERIC,
      activated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

// Insertion groupée d'apparitions horodatées (append-only) :
// counts est une Map<address, nombre d'apparitions du batch>.
export async function saveWalletsBatch(counts) {
  if (!counts.size) return;
  const addresses = [];
  const appearances = [];
  for (const [address, n] of counts) {
    addresses.push(address);
    appearances.push(n);
  }
  await pool.query(
    `INSERT INTO wallet_appearances (address, count)
     SELECT * FROM UNNEST($1::text[], $2::integer[])`,
    [addresses, appearances]
  );
}

// Apparitions agrégées sur fenêtre glissante de 48h.
export async function getActiveWallets(minAppearances = 5) {
  const { rows } = await pool.query(
    `SELECT address, SUM(count) AS appearances
     FROM wallet_appearances
     WHERE seen_at >= NOW() - INTERVAL '48 hours'
     GROUP BY address
     HAVING SUM(count) >= $1`,
    [minAppearances]
  );
  return rows;
}

export async function saveWalletScore(data) {
  const {
    address, score, sortino, profit_factor, diversification,
    recence, coherence, winrate, trades_count, trades_per_day,
    hold_time_median, drawdown_max, pnl_48h, boite,
  } = data;

  await pool.query(
    `INSERT INTO wallet_scores (
       address, score, sortino, profit_factor, diversification,
       recence, coherence, winrate, trades_count, trades_per_day,
       hold_time_avg, drawdown_max, pnl_48h, boite, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
     ON CONFLICT (address) DO UPDATE SET
       score = EXCLUDED.score,
       sortino = EXCLUDED.sortino,
       profit_factor = EXCLUDED.profit_factor,
       diversification = EXCLUDED.diversification,
       recence = EXCLUDED.recence,
       coherence = EXCLUDED.coherence,
       winrate = EXCLUDED.winrate,
       trades_count = EXCLUDED.trades_count,
       trades_per_day = EXCLUDED.trades_per_day,
       hold_time_avg = EXCLUDED.hold_time_avg,
       drawdown_max = EXCLUDED.drawdown_max,
       pnl_48h = EXCLUDED.pnl_48h,
       boite = EXCLUDED.boite,
       updated_at = NOW()`,
    [
      address, score, sortino, profit_factor, diversification,
      recence, coherence, winrate, trades_count, trades_per_day,
      // La colonne hold_time_avg stocke en réalité la médiane.
      hold_time_median, drawdown_max, pnl_48h, boite,
    ]
  );
}

export async function getTopWallets(limit = 5) {
  const { rows } = await pool.query(
    `SELECT * FROM wallet_scores
     WHERE boite IN ('PREMIUM', 'BON')
     ORDER BY score DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getActiveSlots() {
  const { rows } = await pool.query(`SELECT * FROM active_slots`);
  return rows;
}

export async function closeDatabase() {
  await pool.end();
}

export async function updateSlot(slotId, address, score) {
  await pool.query(
    `INSERT INTO active_slots (slot_id, address, score)
     VALUES ($1, $2, $3)
     ON CONFLICT (slot_id) DO UPDATE SET
       address = EXCLUDED.address,
       score = EXCLUDED.score,
       activated_at = NOW()`,
    [slotId, address, score]
  );
}
