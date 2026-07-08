import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
  connectionTimeoutMillis: 10000,
});

// Un client inactif du pool peut être tué par le réseau (NAT, pooler) : sans
// handler, l'événement 'error' ferait tomber tout le process.
pool.on('error', (err) => {
  console.error(`Erreur d'un client Postgres inactif (ignorée) : ${err.message}`);
});

// Erreurs réseau transitoires observées en production : la socket idle meurt
// pendant l'heure de collecte (read ETIMEDOUT) et la première requête
// suivante échoue. Un retry obtient un client neuf du pool.
const RETRIABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', '57P01']);
const QUERY_MAX_RETRIES = 2;

async function query(text, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      if (attempt >= QUERY_MAX_RETRIES || !RETRIABLE_CODES.has(err.code)) throw err;
      console.warn(`Requête DB échouée (${err.code}) — nouvelle tentative ${attempt + 1}/${QUERY_MAX_RETRIES}...`);
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

export async function initDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS wallet_appearances (
      address TEXT NOT NULL,
      count INTEGER NOT NULL,
      seen_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_wallet_appearances_seen_at
    ON wallet_appearances (seen_at)
  `);

  // Purge des apparitions sorties de la fenêtre glissante de 48h.
  await query(`
    DELETE FROM wallet_appearances
    WHERE seen_at < NOW() - INTERVAL '48 hours'
  `);

  await query(`
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
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    ALTER TABLE wallet_scores
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS wallet_scores_history (
      id BIGSERIAL PRIMARY KEY,
      address TEXT NOT NULL,
      score NUMERIC,
      sortino NUMERIC,
      profit_factor NUMERIC,
      diversification NUMERIC,
      recence NUMERIC,
      coherence NUMERIC,
      winrate NUMERIC,
      trades_count INTEGER,
      trades_per_day NUMERIC,
      hold_time_median NUMERIC,
      drawdown_max NUMERIC,
      pnl_48h NUMERIC,
      boite TEXT,
      run_started_at TIMESTAMP NOT NULL,
      recorded_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_wallet_scores_history_address
    ON wallet_scores_history (address, recorded_at)
  `);

  // Verdicts de la vérification longue durée (étage 3). Sert aussi de
  // blacklist temporaire : un INFIRME reste opposable pendant son TTL.
  await query(`
    CREATE TABLE IF NOT EXISTS wallet_verifications (
      address TEXT PRIMARY KEY,
      verdict TEXT NOT NULL,
      pnl_long_usd NUMERIC,
      drawdown_equity NUMERIC,
      weeks_positive_ratio NUMERIC,
      closed_positions INTEGER,
      covered_days NUMERIC,
      verified_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
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
  await query(
    `INSERT INTO wallet_appearances (address, count)
     SELECT * FROM UNNEST($1::text[], $2::integer[])`,
    [addresses, appearances]
  );
}

// Apparitions agrégées sur fenêtre glissante de 48h.
export async function getActiveWallets(minAppearances = 5) {
  const { rows } = await query(
    `SELECT address, SUM(count) AS appearances
     FROM wallet_appearances
     WHERE seen_at >= NOW() - INTERVAL '48 hours'
     GROUP BY address
     HAVING SUM(count) >= $1`,
    [minAppearances]
  );
  return rows;
}

// Un process = un run : horodatage capturé au chargement du module, partagé
// par toutes les lignes d'historique du run pour permettre le GROUP BY run.
// Chaîne ISO UTC et non Date : le driver pg sérialiserait un Date en heure
// locale du client, incohérent avec les colonnes NOW() de la base (Etc/UTC).
const RUN_STARTED_AT = new Date().toISOString();

// Trace append-only : une ligne par wallet et par run, jamais mise à jour.
// C'est la mémoire longitudinale qui permettra de confirmer un wallet sur
// plusieurs semaines sans re-payer d'historique Helius.
async function insertWalletScoreHistory(data) {
  const {
    address, score, sortino, profit_factor, diversification,
    recence, coherence, winrate, trades_count, trades_per_day,
    hold_time_median, drawdown_max, pnl_48h, boite,
  } = data;

  await query(
    `INSERT INTO wallet_scores_history (
       address, score, sortino, profit_factor, diversification,
       recence, coherence, winrate, trades_count, trades_per_day,
       hold_time_median, drawdown_max, pnl_48h, boite, run_started_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      address, score, sortino, profit_factor, diversification,
      recence, coherence, winrate, trades_count, trades_per_day,
      hold_time_median, drawdown_max, pnl_48h, boite, RUN_STARTED_AT,
    ]
  );
}

// Marque toutes les lignes comme inactives : à appeler juste avant la
// sauvegarde d'un run, l'upsert de saveWalletScore réactive les wallets
// revus. Les lignes restées inactives sont l'historique des runs passés.
export async function deactivateAllScores() {
  await query(`UPDATE wallet_scores SET is_active = FALSE`);
}

export async function saveWalletScore(data) {
  const {
    address, score, sortino, profit_factor, diversification,
    recence, coherence, winrate, trades_count, trades_per_day,
    hold_time_median, drawdown_max, pnl_48h, boite,
  } = data;

  await query(
    `INSERT INTO wallet_scores (
       address, score, sortino, profit_factor, diversification,
       recence, coherence, winrate, trades_count, trades_per_day,
       hold_time_avg, drawdown_max, pnl_48h, boite, is_active, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,TRUE,NOW())
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
       is_active = TRUE,
       updated_at = NOW()`,
    [
      address, score, sortino, profit_factor, diversification,
      recence, coherence, winrate, trades_count, trades_per_day,
      // La colonne hold_time_avg stocke en réalité la médiane.
      hold_time_median, drawdown_max, pnl_48h, boite,
    ]
  );

  await insertWalletScoreHistory(data);
}

export async function getTopWallets(limit = 5) {
  const { rows } = await query(
    `SELECT * FROM wallet_scores
     WHERE is_active
       AND boite IN ('PREMIUM', 'BON')
     ORDER BY score DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

// Verdicts encore frais (TTL par verdict) : CONFIRME 7j, INFIRME 14j
// (blacklist temporaire), NEUTRE 2j (un wallet jeune mûrit vite, on
// re-vérifie tôt). Un verdict expiré n'est pas retourné → re-vérification.
export async function getFreshVerifications(addresses) {
  if (!addresses.length) return new Map();
  const { rows } = await query(
    `SELECT address, verdict FROM wallet_verifications
     WHERE address = ANY($1::text[])
       AND verified_at >= NOW() - (CASE verdict
         WHEN 'CONFIRME' THEN INTERVAL '7 days'
         WHEN 'INFIRME' THEN INTERVAL '14 days'
         ELSE INTERVAL '2 days'
       END)`,
    [addresses]
  );
  return new Map(rows.map(r => [r.address, r.verdict]));
}

export async function saveVerification(v) {
  await query(
    `INSERT INTO wallet_verifications (
       address, verdict, pnl_long_usd, drawdown_equity,
       weeks_positive_ratio, closed_positions, covered_days, verified_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (address) DO UPDATE SET
       verdict = EXCLUDED.verdict,
       pnl_long_usd = EXCLUDED.pnl_long_usd,
       drawdown_equity = EXCLUDED.drawdown_equity,
       weeks_positive_ratio = EXCLUDED.weeks_positive_ratio,
       closed_positions = EXCLUDED.closed_positions,
       covered_days = EXCLUDED.covered_days,
       verified_at = NOW()`,
    [
      v.address, v.verdict, v.pnl_long_usd, v.drawdown_equity,
      v.weeks_positive_ratio, v.closed_positions, v.covered_days,
    ]
  );
}

export async function getActiveSlots() {
  const { rows } = await query(`SELECT * FROM active_slots`);
  return rows;
}

export async function closeDatabase() {
  await pool.end();
}

export async function updateSlot(slotId, address, score) {
  await query(
    `INSERT INTO active_slots (slot_id, address, score)
     VALUES ($1, $2, $3)
     ON CONFLICT (slot_id) DO UPDATE SET
       address = EXCLUDED.address,
       score = EXCLUDED.score,
       activated_at = NOW()`,
    [slotId, address, score]
  );
}

// Supprime tout slot non attribué ce run (les slots peuvent être non
// contigus : 1-4 confirmés, 5 early), pour qu'un wallet disparu des
// résultats frais ne reste pas indéfiniment dans un slot actif.
export async function clearSlotsExcept(slotIds) {
  if (!slotIds.length) {
    await query(`DELETE FROM active_slots`);
    return;
  }
  await query(
    `DELETE FROM active_slots WHERE NOT (slot_id = ANY($1::int[]))`,
    [slotIds]
  );
}
