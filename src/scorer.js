import axios from 'axios';
import pLimit from 'p-limit';
import 'dotenv/config';

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const helius = axios.create({ baseURL: 'https://api.helius.xyz/v0' });

let solPriceCache = { price: 150, timestamp: 0 };

async function getSolPrice() {
  const now = Date.now();
  if (now - solPriceCache.timestamp < 5 * 60 * 1000) return solPriceCache.price;
  try {
    const { data } = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`
    );
    const pair = data.pairs?.find(p => p.chainId === 'solana');
    const price = parseFloat(pair?.priceUsd) || 150;
    solPriceCache = { price, timestamp: now };
    return price;
  } catch {
    return 150;
  }
}

async function getWalletTransactions(walletAddress, hoursBack = 48, maxPages = 5) {
  const cutoffTime = Math.floor(Date.now() / 1000) - hoursBack * 3600;
  const transactions = [];
  let before;

  for (let page = 0; page < maxPages; page++) {
    const params = { limit: 100, 'api-key': HELIUS_KEY };
    if (before) params.before = before;

    const { data } = await helius.get(`/addresses/${walletAddress}/transactions`, { params });
    if (!data?.length) break;

    let cutoffReached = false;
    for (const tx of data) {
      if (tx.timestamp < cutoffTime) { cutoffReached = true; break; }
      transactions.push(tx);
    }

    if (cutoffReached || data.length < 100) break;
    before = data[data.length - 1].signature;
  }

  return transactions;
}

// --- Pré-filtre étage 1 ------------------------------------------------
// Écarte les wallets évidents avant l'Enhanced API (100 crédits/page) :
// (a) 0 crédit : les apparitions comptées pendant la collecte sont une borne
//     inférieure des swaps du wallet sur 48h. Le scoring rejette au-delà de
//     120 trades copiables/48h (trades/jour > 60) ; comme le filtre de
//     copiabilité peut retirer jusqu'à 40% des positions, on ne coupe ici
//     qu'à partir de 120/0.6 = 200 apparitions — rejet certain, sans appel.
// (b) 1 crédit : getSignaturesForAddress (timestamps inclus) élimine les
//     wallets sans activité suffisante ou à cadence absurde sur 48h.
export const PREFILTER_MAX_APPEARANCES_48H = 200;
const PREFILTER_MIN_TXS_48H = 5;
const PREFILTER_MAX_TXS_48H = 1000;

// Nombre de transactions du wallet sur 48h, via les signatures brutes
// (1 crédit, jusqu'à 1000 signatures par appel). Retourne null en cas
// d'erreur RPC : fail-open, le scoring standard tranchera.
async function countRecentTransactions(walletAddress) {
  const cutoffTime = Math.floor(Date.now() / 1000) - 48 * 3600;
  try {
    const { data } = await axios.post(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`,
      {
        jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
        params: [walletAddress, { limit: PREFILTER_MAX_TXS_48H }],
      }
    );
    const sigs = data?.result;
    if (!Array.isArray(sigs)) return null;
    return sigs.filter(s => (s.blockTime ?? 0) >= cutoffTime).length;
  } catch {
    return null;
  }
}

function isWalletSwap(tx, walletAddress) {
  if (!tx.accountData) return false;
  const allTokenChanges = tx.accountData.flatMap(a => a.tokenBalanceChanges ?? []);
  const hasTokenChange = allTokenChanges.some(
    t => t.userAccount === walletAddress && t.mint !== SOL_MINT
  );
  const walletData = tx.accountData.find(a => a.account === walletAddress);
  const hasSolChange = (walletData?.nativeBalanceChange ?? 0) !== 0;
  return hasTokenChange && hasSolChange;
}

function extractSwapData(tx, walletAddress) {
  const feeSol = (tx.fee ?? 0) / 1e9;
  const walletData = tx.accountData?.find(a => a.account === walletAddress);
  const solChange = (walletData?.nativeBalanceChange ?? 0) / 1e9;

  const tokenChanges = (tx.accountData ?? [])
    .flatMap(a => a.tokenBalanceChanges ?? [])
    .filter(t => t.userAccount === walletAddress && t.mint !== SOL_MINT)
    .map(t => ({ ...t, amount: parseFloat(t.rawTokenAmount?.tokenAmount ?? 0) }))
    .filter(t => t.amount !== 0);

  // Le solChange et les frais sont répartis entre les tokens de la tx
  // pour ne pas compter le même SOL plusieurs fois (swaps multi-tokens).
  const share = tokenChanges.length > 0 ? 1 / tokenChanges.length : 0;

  return tokenChanges.map(t => {
    const isBuy = t.amount > 0;
    return {
      walletAddress,
      tokenMint: t.mint,
      side: isBuy ? 'buy' : 'sell',
      amountToken: Math.abs(t.amount),
      amountSol: (isBuy
        ? Math.abs(solChange) + feeSol
        : Math.max(0, Math.abs(solChange) - feeSol)) * share,
      timestamp: tx.timestamp,
      signature: tx.signature,
    };
  });
}

// Groups trades by token and sums bought/sold SOL amounts.
function groupByToken(trades) {
  const map = new Map();
  for (const trade of trades) {
    const pos = map.get(trade.tokenMint) ?? { bought: 0, sold: 0 };
    if (trade.side === 'buy') pos.bought += trade.amountSol;
    else pos.sold += trade.amountSol;
    map.set(trade.tokenMint, pos);
  }
  return map;
}

// --- Filtre de reproductibilité économique (copy trading) -------------------
// Un achat n'est copiable que si le token avait une market cap suffisante au
// moment du trade (sinon slippage prohibitif pour notre taille d'ordre) et si
// le wallet ne détient pas une part significative de la supply (sa sortie
// serait elle-même le problème de liquidité).
export const MIN_MCAP_USD = 25_000;
export const MAX_SUPPLY_SHARE = 0.01;
// Au-delà de cette proportion de positions non copiables, le wallet entier est
// rejeté : son edge vit dans la zone non reproductible.
const MAX_MICROCAP_RATIO = 0.40;

// Supply brute (plus petites unités) par mint. Fixe pour l'immense majorité
// des memecoins (mint authority révoquée) → cache sans expiration.
const supplyCache = new Map();

async function getTokenSupplyRaw(mint) {
  if (supplyCache.has(mint)) return supplyCache.get(mint);
  try {
    const { data } = await axios.post(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`,
      { jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [mint] }
    );
    const supply = parseFloat(data?.result?.value?.amount) || 0;
    if (supply > 0) supplyCache.set(mint, supply);
    return supply;
  } catch {
    // Supply inconnue : reproductibilité invérifiable → non copiable.
    return 0;
  }
}

// Réutilisable tel quel par le module d'exécution du copy trade : évalue un
// achat observé (montants du swap) à l'instant où il se produit.
// - buySol / buyTokens : montants du swap de référence — le prix qui en
//   découle est le prix d'exécution réel, slippage inclus.
// - walletTokensTotal : cumul de tokens achetés par le wallet sur ce mint.
// Les montants token sont en unités brutes : les décimales s'annulent entre
// le prix par unité brute et la supply brute.
export async function assessCopyability(tokenMint, buySol, buyTokens, walletTokensTotal = buyTokens) {
  if (buySol <= 0 || buyTokens <= 0) return { copyable: false, reason: 'montants invalides' };
  const supplyRaw = await getTokenSupplyRaw(tokenMint);
  if (supplyRaw <= 0) return { copyable: false, reason: 'supply inconnue' };
  const solPrice = await getSolPrice();
  const mcapUsd = (buySol / buyTokens) * supplyRaw * solPrice;
  const supplyShare = walletTokensTotal / supplyRaw;
  if (mcapUsd < MIN_MCAP_USD) return { copyable: false, reason: 'mcap trop faible', mcapUsd, supplyShare };
  if (supplyShare > MAX_SUPPLY_SHARE) return { copyable: false, reason: 'part de supply trop élevée', mcapUsd, supplyShare };
  return { copyable: true, mcapUsd, supplyShare };
}

// Retire les trades des mints non copiables (mcap au premier achat de la
// fenêtre, part de supply cumulée). Retourne null si la proportion de
// positions non copiables dépasse MAX_MICROCAP_RATIO.
async function filterCopyableTrades(trades) {
  const buysByMint = new Map();
  for (const t of trades) {
    if (t.side !== 'buy') continue;
    const cur = buysByMint.get(t.tokenMint);
    if (!cur) buysByMint.set(t.tokenMint, { first: t, total: t.amountToken });
    else {
      cur.total += t.amountToken;
      if (t.timestamp < cur.first.timestamp) cur.first = t;
    }
  }
  if (buysByMint.size === 0) return { trades, excluded: 0, assessed: 0 };

  const limit = pLimit(5);
  const excludedMints = new Set();
  await Promise.all([...buysByMint].map(([mint, { first, total }]) =>
    limit(async () => {
      const res = await assessCopyability(mint, first.amountSol, first.amountToken, total);
      if (!res.copyable) excludedMints.add(mint);
    })
  ));

  if (excludedMints.size / buysByMint.size > MAX_MICROCAP_RATIO) return null;
  return {
    trades: trades.filter(t => !excludedMints.has(t.tokenMint)),
    excluded: excludedMints.size,
    assessed: buysByMint.size,
  };
}

function calculateSortino(trades) {
  const tokenMap = groupByToken(trades);
  const positions = [];
  for (const pos of tokenMap.values()) {
    // Seules les positions fermées (achat ET vente) ont un ROI réalisé.
    if (pos.bought === 0 || pos.sold === 0) continue;
    positions.push({ roi: (pos.sold - pos.bought) / pos.bought, weight: pos.bought });
  }
  if (positions.length === 0) return 0;

  const totalWeight = positions.reduce((sum, p) => sum + p.weight, 0);
  // Σ roi·bought = Σ (sold - bought) : PnL SOL réalisé des positions fermées.
  const realizedPnl = positions.reduce((sum, p) => sum + p.roi * p.weight, 0);
  const losingCount = positions.filter(p => p.roi <= 0).length;

  // Moins de 3 pertes observées : échantillon insuffisant pour mesurer le
  // risque → pénalité de confiance (0 perte ×0.25, 1 ×0.5, 2 ×0.75, ≥3 ×1)
  // au lieu d'un 10 automatique.
  const lossConfidence = Math.min(1, (losingCount + 1) / 4);

  // Moyenne des ROI pondérée par le capital engagé : une grosse position
  // perdante ne peut plus être noyée par des petits gains en %.
  const weightedMean = realizedPnl / totalWeight;
  // Downside deviation standard (cible 0, N = toutes les positions fermées) :
  // mesure l'amplitude des pertes, pas leur dispersion entre elles — des
  // rugs réguliers restent comptés comme du risque.
  const downside = Math.sqrt(
    positions.reduce((sum, p) => sum + Math.min(p.roi, 0) ** 2 * p.weight, 0) / totalWeight
  );

  let score;
  if (downside === 0) {
    score = weightedMean > 0 ? 10 * lossConfidence : 0;
  } else {
    // 10·tanh(ratio/2) : même pente (×5) que l'ancien scaling linéaire près
    // de 0, mais compression asymptotique vers 10 au lieu d'un cap dur
    // (≈9.95 atteint vers ratio 6 au lieu d'un plafond exact dès ratio 2).
    score = Math.max(0, 10 * Math.tanh(weightedMean / downside / 2)) * lossConfidence;
  }

  // Garde-fou économique : un wallet dont le PnL réalisé (positions fermées,
  // même périmètre que le ratio) est ≤ 0 ne peut pas afficher un bon Sortino.
  if (realizedPnl <= 0) score = Math.min(score, 2);

  return score;
}

function calculateProfitFactor(trades) {
  if (trades.length < 5) return 0;
  const tokenMap = groupByToken(trades);
  let gains = 0, losses = 0, losingCount = 0;
  for (const pos of tokenMap.values()) {
    // Positions ouvertes exclues : pas de PnL réalisé.
    if (pos.bought === 0 || pos.sold === 0) continue;
    const pnl = pos.sold - pos.bought;
    if (pnl > 0) gains += pnl;
    else { losses += Math.abs(pnl); losingCount++; }
  }

  // Même pénalité de confiance que le Sortino : < 3 positions perdantes.
  const lossConfidence = Math.min(1, (losingCount + 1) / 4);

  if (losses === 0) return gains > 0 ? 10 * lossConfidence : 0;
  return Math.min(10, (Math.min(gains / losses, 5) / 5) * 10) * lossConfidence;
}

function calculateDiversification(trades) {
  const tokenMap = groupByToken(trades);
  let winningTokens = 0;
  let totalGains = 0;
  const gainsByToken = new Map();

  for (const [mint, pos] of tokenMap) {
    const pnl = pos.sold - pos.bought;
    if (pnl > 0) {
      winningTokens++;
      totalGains += pnl;
      gainsByToken.set(mint, pnl);
    }
  }

  let score = (winningTokens / tokenMap.size) * 10;

  if (totalGains > 0) {
    for (const gain of gainsByToken.values()) {
      if (gain / totalGains > 0.70) {
        score -= 2;
        break;
      }
    }
  }

  return Math.min(10, Math.max(0, score));
}

function calculateRecence(trades) {
  const tokenMap = groupByToken(trades);
  const tokenROI = new Map();
  for (const [mint, pos] of tokenMap) {
    tokenROI.set(mint, pos.bought > 0 ? (pos.sold - pos.bought) / pos.bought : 0);
  }

  const sorted = [...trades].sort((a, b) => b.timestamp - a.timestamp);

  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < sorted.length; i++) {
    const decay = Math.pow(0.85, i);
    weightedSum += (tokenROI.get(sorted[i].tokenMint) ?? 0) * decay;
    weightTotal += decay;
  }

  const weightedROI = weightTotal > 0 ? weightedSum / weightTotal : 0;
  return Math.min(10, Math.max(0, (Math.tanh(weightedROI) + 1) / 2 * 10));
}

function calculateCoherence(trades) {
  const buyAmounts = trades.filter(t => t.side === 'buy').map(t => t.amountSol);
  if (buyAmounts.length < 2) return 5;
  const mean = buyAmounts.reduce((a, b) => a + b, 0) / buyAmounts.length;
  if (mean === 0) return 0;
  const variance = buyAmounts.reduce((acc, a) => acc + (a - mean) ** 2, 0) / buyAmounts.length;
  const cov = Math.sqrt(variance) / mean;
  return Math.min(10, Math.max(0, (1 - cov) * 10));
}

// Drawdown max de la courbe de PnL réalisé du portefeuille (positions
// fermées, ordonnées par date de clôture), en % du capital total engagé.
function calculateDrawdown(trades) {
  const tokenTrades = new Map();
  for (const trade of trades) {
    if (!tokenTrades.has(trade.tokenMint)) tokenTrades.set(trade.tokenMint, []);
    tokenTrades.get(trade.tokenMint).push(trade);
  }

  const closedPositions = [];
  let totalInvested = 0;
  for (const list of tokenTrades.values()) {
    let bought = 0, sold = 0, lastSell = 0;
    for (const t of list) {
      if (t.side === 'buy') bought += t.amountSol;
      else { sold += t.amountSol; lastSell = Math.max(lastSell, t.timestamp); }
    }
    totalInvested += bought;
    if (bought > 0 && sold > 0) closedPositions.push({ pnl: sold - bought, closedAt: lastSell });
  }

  if (totalInvested === 0 || closedPositions.length === 0) return 0;

  closedPositions.sort((a, b) => a.closedAt - b.closedAt);
  let cumPnL = 0, peak = 0, maxDrawdown = 0;
  for (const pos of closedPositions) {
    cumPnL += pos.pnl;
    if (cumPnL > peak) peak = cumPnL;
    const dd = ((peak - cumPnL) / totalInvested) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  return maxDrawdown;
}

function calculateHoldTime(trades) {
  const tokenTrades = new Map();
  for (const trade of trades) {
    if (!tokenTrades.has(trade.tokenMint)) tokenTrades.set(trade.tokenMint, []);
    tokenTrades.get(trade.tokenMint).push(trade);
  }

  const holdTimes = [];
  for (const list of tokenTrades.values()) {
    const buys = list.filter(t => t.side === 'buy');
    const sells = list.filter(t => t.side === 'sell');
    if (!buys.length || !sells.length) continue;
    const firstBuy = Math.min(...buys.map(t => t.timestamp));
    const lastSell = Math.max(...sells.map(t => t.timestamp));
    holdTimes.push((lastSell - firstBuy) / 60);
  }

  if (holdTimes.length === 0) return 0;
  holdTimes.sort((a, b) => a - b);
  const mid = Math.floor(holdTimes.length / 2);
  return holdTimes.length % 2 !== 0
    ? holdTimes[mid]
    : (holdTimes[mid - 1] + holdTimes[mid]) / 2;
}

// TEMPORAIRE (diagnostic) : compte les raisons de rejet des wallets.
const rejectionCounts = {};

function reject(reason) {
  rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
  return null;
}

export async function scoreWallet(walletAddress) {
  // Étage 1b (1 crédit) : compte les tx sur 48h via les signatures brutes
  // avant de déclencher l'Enhanced API à 100 crédits/page.
  const txs48h = await countRecentTransactions(walletAddress);
  if (txs48h !== null) {
    if (txs48h < PREFILTER_MIN_TXS_48H) {
      return reject('pré-filtre 1 crédit : moins de 5 tx en 48h (signatures)');
    }
    if (txs48h >= PREFILTER_MAX_TXS_48H) {
      return reject(`pré-filtre 1 crédit : cadence absurde (≥${PREFILTER_MAX_TXS_48H} tx en 48h)`);
    }
  }

  const solPrice = await getSolPrice();

  const hoursBack = 48;
  const transactions = await getWalletTransactions(walletAddress, hoursBack, 3);
  if (transactions.length < 5) return reject('moins de 5 transactions');

  let trades = transactions
    .filter(tx => isWalletSwap(tx, walletAddress))
    .flatMap(tx => extractSwapData(tx, walletAddress));

  if (trades.length < 5) return reject('moins de 5 swaps extraits');

  // Filtre de reproductibilité : seules les positions copiables sont scorées,
  // et les filtres d'entrée suivants s'appliquent à l'ensemble filtré.
  const copyFilter = await filterCopyableTrades(trades);
  if (copyFilter === null) return reject('plus de 40% de positions non copiables (mcap/supply)');
  trades = copyFilter.trades;
  if (trades.length < 5) return reject('moins de 5 swaps copiables après filtre mcap');

  const tokenMap = groupByToken(trades);
  let winningTokens = 0, losingTokensSold = 0, openPositions = 0, totalPnlSol = 0;

  for (const pos of tokenMap.values()) {
    const pnl = pos.sold - pos.bought;
    totalPnlSol += pnl;
    if (pos.bought > 0 && pos.sold > 0) {
      if (pnl > 0) winningTokens++;
      else losingTokensSold++;
    } else if (pos.bought > 0) {
      openPositions++;
    }
  }

  // Les positions ouvertes (achat sans vente) comptent comme potentiellement perdantes.
  const totalTokens = winningTokens + losingTokensSold + openPositions;
  const winrate = totalTokens > 0 ? winningTokens / totalTokens : 0;
  const trades_per_day = trades.length / (hoursBack / 24);
  const hold_time_median = calculateHoldTime(trades);
  const drawdown_max = calculateDrawdown(trades);
  const distinctWinningTokens = [...tokenMap.values()].filter(p => p.sold > p.bought).length;

  if (trades_per_day > 60) return reject('trades/jour > 60');
  if (winrate > 0.95) return reject('winrate > 95%');
  if (distinctWinningTokens < 3) return reject('moins de 3 tokens gagnants distincts');
  if (hold_time_median < 0.5) return reject('hold time hors bornes');
  if (hold_time_median > 2880) return reject('hold time hors bornes');
  if (drawdown_max > 80) return reject('drawdown > 80%');

  const confidenceCoef = Math.min(1, trades.length / 30);
  const sortino = calculateSortino(trades) * confidenceCoef;
  const profitFactor = calculateProfitFactor(trades);
  const diversification = calculateDiversification(trades);
  const recence = calculateRecence(trades);
  const coherence = calculateCoherence(trades);

  const score =
    0.25 * sortino +
    0.20 * profitFactor +
    0.20 * diversification +
    0.20 * recence +
    0.15 * coherence;

  return {
    address: walletAddress,
    score,
    sortino,
    profit_factor: profitFactor,
    diversification,
    recence,
    coherence,
    winrate: winrate * 100,
    trades_count: trades.length,
    trades_per_day,
    hold_time_median,
    drawdown_max,
    pnl_48h: totalPnlSol * solPrice,
  };
}

// Accepte les lignes de getActiveWallets ({ address, appearances }) ou de
// simples adresses (appearances inconnu → étage 1a sauté pour ce wallet).
export async function scoreWallets(wallets) {
  const items = wallets.map(w => typeof w === 'string'
    ? { address: w, appearances: null }
    : { address: w.address, appearances: w.appearances != null ? Number(w.appearances) : null });

  for (const key of Object.keys(rejectionCounts)) delete rejectionCounts[key];

  // Étage 1a (0 crédit) : tranché ici, avant le throttling — aucun appel réseau.
  const toScore = items.filter(({ appearances }) => {
    if (appearances !== null && appearances > PREFILTER_MAX_APPEARANCES_48H) {
      reject(`pré-filtre 0 crédit : > ${PREFILTER_MAX_APPEARANCES_48H} apparitions en 48h (trades/jour > 60 certain)`);
      return false;
    }
    return true;
  });
  if (toScore.length < items.length) {
    console.log(`Pré-filtre 0 crédit : ${items.length - toScore.length} wallet(s) écarté(s) avant tout appel API.`);
  }

  const limit = pLimit(3);
  const total = toScore.length;
  let completed = 0;
  let errors = 0;

  const promises = toScore.map(({ address }) =>
    limit(async () => {
      await new Promise(r => setTimeout(r, 300));
      try {
        const result = await scoreWallet(address);
        process.stdout.write(`\r[${++completed}/${total}] wallets scored...`);
        return result;
      } catch (err) {
        process.stdout.write(`\r[${++completed}/${total}] wallets scored...`);
        console.error(`\nFailed to score ${address}: ${err.message}`);
        errors++;
        return null;
      }
    })
  );

  const results = await Promise.all(promises);
  const valid = results.filter(Boolean);
  console.log(`\nDone: ${valid.length}/${total} valid scores.`);

  const rejected = Object.entries(rejectionCounts);
  const rejectedTotal = rejected.reduce((sum, [, n]) => sum + n, 0);
  if (rejected.length) {
    console.log('Raisons de rejet :');
    for (const [reason, n] of rejected) {
      console.log(`- ${n} wallet(s) rejeté(s) : ${reason}`);
    }
  }

  console.log(`Bilan : ${items.length} reçus = ${valid.length} scorés + ${rejectedTotal} rejetés + ${errors} erreurs`);
  if (valid.length + rejectedTotal + errors !== items.length) {
    console.warn(`⚠️ Incohérence de comptage : ${valid.length} + ${rejectedTotal} + ${errors} ≠ ${items.length}`);
  }

  return valid;
}

// --- Étage 3 : vérification longue durée des finalistes ---------------------
// Ne recalcule pas le score 48h : mesure la robustesse sur fenêtre longue pour
// détecter un bon 48h qui masque un mauvais mois. Réservé aux candidats
// PREMIUM/BON — coût plafonné à VERIFY_MAX_PAGES × 100 crédits par wallet.
export const VERIFY_WINDOW_DAYS = 30;
const VERIFY_MAX_PAGES = 30;
const VERIFY_MIN_CLOSED_POSITIONS = 5;
const VERIFY_MIN_COVERED_DAYS = 10;
const VERIFY_MAX_DRAWDOWN_PCT = 60;
const VERIFY_MIN_POSITIVE_WEEKS_RATIO = 0.5;

// PnL réalisé par semaine calendaire, rattaché à la date de dernière vente de
// chaque position fermée (même construction que calculateDrawdown).
function weeklyPnlStats(trades) {
  const tokenTrades = new Map();
  for (const t of trades) {
    if (!tokenTrades.has(t.tokenMint)) tokenTrades.set(t.tokenMint, []);
    tokenTrades.get(t.tokenMint).push(t);
  }

  const weeks = new Map();
  let closedCount = 0;
  for (const list of tokenTrades.values()) {
    let bought = 0, sold = 0, lastSell = 0;
    for (const t of list) {
      if (t.side === 'buy') bought += t.amountSol;
      else { sold += t.amountSol; lastSell = Math.max(lastSell, t.timestamp); }
    }
    if (bought > 0 && sold > 0) {
      closedCount++;
      const week = Math.floor(lastSell / (7 * 86400));
      weeks.set(week, (weeks.get(week) ?? 0) + (sold - bought));
    }
  }

  const weekCount = weeks.size;
  const positiveWeeks = [...weeks.values()].filter(p => p > 0).length;
  return {
    closedCount,
    weekCount,
    positiveRatio: weekCount > 0 ? positiveWeeks / weekCount : null,
  };
}

export async function verifyWalletLongTerm(walletAddress) {
  const solPrice = await getSolPrice();
  const transactions = await getWalletTransactions(
    walletAddress, VERIFY_WINDOW_DAYS * 24, VERIFY_MAX_PAGES
  );

  const result = {
    address: walletAddress,
    verdict: 'NEUTRE',
    pnl_long_usd: null,
    drawdown_equity: null,
    weeks_positive_ratio: null,
    closed_positions: 0,
    covered_days: 0,
  };

  let trades = transactions
    .filter(tx => isWalletSwap(tx, walletAddress))
    .flatMap(tx => extractSwapData(tx, walletAddress));
  if (!trades.length) return result; // aucune activité visible → NEUTRE

  // Plafond de pages atteint : couverture tronquée, les métriques valent
  // pour la période réellement couverte (covered_days).
  const pageCapReached = transactions.length >= VERIFY_MAX_PAGES * 100;
  result.covered_days =
    (Date.now() / 1000 - Math.min(...trades.map(t => t.timestamp))) / 86400;

  // Même exigence de reproductibilité que le scoring 48h : un edge long
  // terme qui vit dans la zone non copiable infirme le wallet.
  const copyFilter = await filterCopyableTrades(trades);
  if (copyFilter === null) {
    result.verdict = 'INFIRME';
    return result;
  }
  trades = copyFilter.trades;

  let pnlSol = 0;
  for (const pos of groupByToken(trades).values()) pnlSol += pos.sold - pos.bought;
  result.pnl_long_usd = pnlSol * solPrice;
  result.drawdown_equity = calculateDrawdown(trades);

  const { closedCount, weekCount, positiveRatio } = weeklyPnlStats(trades);
  result.closed_positions = closedCount;
  result.weeks_positive_ratio = positiveRatio;

  // Wallet trop jeune pour être jugé : pas d'historique ≠ mauvais historique.
  // (Sauf plafond de pages atteint : la couverture courte vient alors d'une
  // hyperactivité, pas de la jeunesse — on juge sur les données obtenues.)
  if (closedCount < VERIFY_MIN_CLOSED_POSITIONS ||
      (!pageCapReached && result.covered_days < VERIFY_MIN_COVERED_DAYS)) {
    return result; // NEUTRE
  }

  const infirme =
    result.pnl_long_usd < 0 ||
    result.drawdown_equity > VERIFY_MAX_DRAWDOWN_PCT ||
    (weekCount >= 2 && positiveRatio < VERIFY_MIN_POSITIVE_WEEKS_RATIO);

  result.verdict = infirme ? 'INFIRME' : 'CONFIRME';
  return result;
}
