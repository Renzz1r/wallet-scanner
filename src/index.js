import 'dotenv/config';
import { writeFileSync } from 'fs';
import { startWalletDiscovery } from './discovery.js';
import { scoreWallets, verifyWalletLongTerm } from './scorer.js';
import { filterWallets } from './filter.js';
import {
  initDatabase,
  getActiveWallets,
  deactivateAllScores,
  saveWalletScore,
  getTopWallets,
  getFreshVerifications,
  saveVerification,
  updateSlot,
  clearSlotsExcept,
  closeDatabase,
} from './database.js';

const COLLECT_DURATION_MS = 1 * 60 * 60 * 1000;
const MIN_APPEARANCES = 20;
// Étage 4 : 4 slots réservés aux wallets CONFIRMÉS par la vérification longue
// durée, 1 slot "early" (exposition plafonnée à 1/5 du capital) pour le
// meilleur NEUTRE — c'est lui qui monétise l'avance sur GMGN.
const CONFIRMED_SLOTS = 4;
const EARLY_SLOT_ID = 5;
// Pool de finalistes vérifiés : assez large pour remplir 4 slots confirmés
// même si plusieurs finalistes sont infirmés.
const FINALIST_POOL = 12;

async function processResults() {
  // --- a. récupération des wallets actifs ---
  const wallets = await getActiveWallets(MIN_APPEARANCES);
  if (!wallets.length) {
    console.log(`Aucun wallet actif trouvé (minimum ${MIN_APPEARANCES} apparitions dans les 48h).`);
    return;
  }

  console.log(`\ngetActiveWallets a retourné ${wallets.length} wallets (seuil ${MIN_APPEARANCES} apparitions sur 48h glissantes) — passés au pré-filtre puis au scoring.`);

  // --- d. scoring (avec pré-filtre étage 1 : apparitions + signatures) ---
  const scored = await scoreWallets(wallets);
  if (!scored.length) {
    console.log('Aucun wallet n\'a passé les filtres de scoring.');
    return;
  }

  // --- f. classification ---
  const boites = filterWallets(scored);

  // --- g. sauvegarde en base ---
  // Les lignes des runs précédents passent inactives ; l'upsert réactive
  // uniquement les wallets revus dans ce run.
  await deactivateAllScores();
  for (const [boite, list] of Object.entries(boites)) {
    if (boite === 'EXCLUS') continue;
    for (const wallet of list) {
      await saveWalletScore({ ...wallet, boite });
    }
  }

  // --- h. export JSON ---
  writeFileSync('resultats.json', JSON.stringify(boites, null, 2));
  console.log('\nRésultats sauvegardés dans resultats.json');

  // --- i. résumé ---
  console.log('\n=== Résumé des boîtes ===');
  console.log(`⭐⭐⭐ PREMIUM    : ${boites.PREMIUM.length} wallet(s)`);
  console.log(`⭐⭐  BON        : ${boites.BON.length} wallet(s)`);
  console.log(`⭐   PROMETTEUR : ${boites.PROMETTEUR.length} wallet(s)`);
  console.log(`🔍   SURVEILLER : ${boites.SURVEILLER.length} wallet(s)`);
  console.log(`❌   EXCLUS     : ${boites.EXCLUS.length} wallet(s)`);

  // --- j. détail PREMIUM + BON ---
  const topTiers = [...boites.PREMIUM, ...boites.BON];
  if (topTiers.length) {
    console.log('\n=== Détail PREMIUM & BON ===');
    for (const w of topTiers) {
      const pnl = w.pnl_48h >= 0 ? `+$${w.pnl_48h.toFixed(0)}` : `-$${Math.abs(w.pnl_48h).toFixed(0)}`;
      console.log(
        `${w.address}\n` +
        `  Score: ${w.score.toFixed(2)}/10  |  Winrate: ${w.winrate.toFixed(1)}%  |  Trades: ${w.trades_count}  |  PnL 48h: ${pnl}\n` +
        `  Sortino: ${w.sortino.toFixed(2)}  |  Profit Factor: ${w.profit_factor.toFixed(2)}\n`
      );
    }
  }

  // --- k. étage 3 : vérification longue durée des finalistes ---
  const finalists = await getTopWallets(FINALIST_POOL);
  const verdicts = await getFreshVerifications(finalists.map(w => w.address));

  if (finalists.length) console.log('\n=== Vérification longue durée (30j) des finalistes ===');
  for (const w of finalists) {
    if (verdicts.has(w.address)) {
      console.log(`${w.address}  ${verdicts.get(w.address)} (verdict en cache)`);
      continue;
    }
    try {
      const v = await verifyWalletLongTerm(w.address);
      await saveVerification(v);
      verdicts.set(w.address, v.verdict);
      console.log(
        `${w.address}  ${v.verdict}` +
        (v.pnl_long_usd !== null
          ? `  (PnL ${v.pnl_long_usd >= 0 ? '+' : '-'}$${Math.abs(v.pnl_long_usd).toFixed(0)}, ` +
            `DD ${v.drawdown_equity.toFixed(1)}%, ` +
            `${v.closed_positions} positions sur ${v.covered_days.toFixed(1)}j)`
          : `  (couverture ${v.covered_days.toFixed(1)}j)`)
      );
    } catch (err) {
      // Vérification impossible ce run : pas de verdict → pas slotté, sans
      // blacklister le wallet ni faire tomber le pipeline.
      console.error(`${w.address}  ÉCHEC vérification : ${err.message}`);
    }
  }

  // --- l. étage 4 : slots classés par score, filtrés par confiance ---
  const confirmed = finalists
    .filter(w => verdicts.get(w.address) === 'CONFIRME')
    .slice(0, CONFIRMED_SLOTS);
  const bestNeutral = finalists.find(w => verdicts.get(w.address) === 'NEUTRE');

  const assignments = confirmed.map((w, i) => ({ slotId: i + 1, wallet: w, tag: 'CONFIRMÉ' }));
  if (bestNeutral) {
    assignments.push({ slotId: EARLY_SLOT_ID, wallet: bestNeutral, tag: 'EARLY·NEUTRE' });
  }

  console.log(`\n=== Slots : 1-${CONFIRMED_SLOTS} confirmés, ${EARLY_SLOT_ID} early ===`);
  if (!assignments.length) {
    console.log('Aucun wallet éligible pour les slots.');
  }
  for (const { slotId, wallet, tag } of assignments) {
    await updateSlot(slotId, wallet.address, wallet.score);
    console.log(`Slot ${slotId}: ${wallet.address}  [${wallet.boite}|${tag}]  score=${parseFloat(wallet.score).toFixed(2)}`);
  }
  await clearSlotsExcept(assignments.map(a => a.slotId));
}

async function runScanner() {
  console.log('=== Wallet Scanner ===');
  console.log('Fenêtre d\'analyse : 48h glissantes');
  console.log('Score composite : Sortino × 0.25 | Profit Factor × 0.20 | Diversification × 0.20 | Récence × 0.20 | Cohérence × 0.15');
  console.log(`Collecte en cours pendant ${COLLECT_DURATION_MS / 60000} minutes...\n`);

  await initDatabase();

  await startWalletDiscovery(async () => {
    try {
      await processResults();
    } finally {
      await closeDatabase();
    }
  }, COLLECT_DURATION_MS);
}

runScanner().catch(err => {
  console.error('Erreur fatale:', err);
  process.exit(1);
});
