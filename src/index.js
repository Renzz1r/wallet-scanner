import 'dotenv/config';
import { writeFileSync } from 'fs';
import { startWalletDiscovery } from './discovery.js';
import { scoreWallets } from './scorer.js';
import { filterWallets } from './filter.js';
import {
  initDatabase,
  getActiveWallets,
  saveWalletScore,
  getTopWallets,
  updateSlot,
  closeDatabase,
} from './database.js';

const COLLECT_DURATION_MS = 1 * 60 * 60 * 1000;
const MIN_APPEARANCES = 20;

async function processResults() {
  // --- a. récupération des wallets actifs ---
  const wallets = await getActiveWallets(MIN_APPEARANCES);
  if (!wallets.length) {
    console.log(`Aucun wallet actif trouvé (minimum ${MIN_APPEARANCES} apparitions dans les 48h).`);
    return;
  }

  const addresses = wallets.map(w => w.address);
  console.log(`\ngetActiveWallets a retourné ${wallets.length} wallets (seuil ${MIN_APPEARANCES} apparitions sur 48h glissantes) — ${addresses.length} passés au scoring.`);

  // --- d. scoring ---
  const scored = await scoreWallets(addresses);
  if (!scored.length) {
    console.log('Aucun wallet n\'a passé les filtres de scoring.');
    return;
  }

  // --- f. classification ---
  const boites = filterWallets(scored);

  // --- g. sauvegarde en base ---
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

  // --- k-l. top 5 recommandé + mise à jour des slots ---
  const top5 = await getTopWallets(5);
  console.log('=== Recommandation pour les 5 slots actifs ===');
  if (!top5.length) {
    console.log('Aucun wallet éligible pour les slots.');
  } else {
    for (let i = 0; i < top5.length; i++) {
      const w = top5[i];
      await updateSlot(i + 1, w.address, w.score);
      console.log(`Slot ${i + 1}: ${w.address}  [${w.boite}]  score=${parseFloat(w.score).toFixed(2)}`);
    }
  }
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
