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

function calculateSortino(trades) {
  const tokenMap = groupByToken(trades);
  const rois = [];
  for (const pos of tokenMap.values()) {
    // Seules les positions fermées (achat ET vente) ont un ROI réalisé.
    if (pos.bought === 0 || pos.sold === 0) continue;
    rois.push((pos.sold - pos.bought) / pos.bought);
  }
  if (rois.length === 0) return 0;

  const losingROIs = rois.filter(r => r <= 0);
  const meanAll = rois.reduce((a, b) => a + b, 0) / rois.length;

  // Moins de 3 pertes observées : échantillon insuffisant pour mesurer le
  // risque → pénalité de confiance (0 perte ×0.25, 1 ×0.5, 2 ×0.75, ≥3 ×1)
  // au lieu d'un 10 automatique.
  const lossConfidence = Math.min(1, (losingROIs.length + 1) / 4);

  if (losingROIs.length === 0) return meanAll > 0 ? 10 * lossConfidence : 0;

  const meanLosing = losingROIs.reduce((a, b) => a + b, 0) / losingROIs.length;
  const downside = Math.sqrt(
    losingROIs.reduce((acc, r) => acc + (r - meanLosing) ** 2, 0) / losingROIs.length
  );

  if (downside === 0) return meanAll > 0 ? 10 * lossConfidence : 0;
  return Math.min(10, Math.max(0, (meanAll / downside) * 5)) * lossConfidence;
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
  const solPrice = await getSolPrice();

  const hoursBack = 48;
  const transactions = await getWalletTransactions(walletAddress, hoursBack, 5);
  if (transactions.length < 5) return reject('moins de 5 transactions');

  const trades = transactions
    .filter(tx => isWalletSwap(tx, walletAddress))
    .flatMap(tx => extractSwapData(tx, walletAddress));

  if (trades.length < 5) return reject('moins de 5 swaps extraits');

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

export async function scoreWallets(walletAddresses) {
  const limit = pLimit(3);
  const total = walletAddresses.length;
  let completed = 0;
  let errors = 0;

  for (const key of Object.keys(rejectionCounts)) delete rejectionCounts[key];

  const promises = walletAddresses.map(address =>
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

  console.log(`Bilan : ${total} reçus = ${valid.length} scorés + ${rejectedTotal} rejetés + ${errors} erreurs`);
  if (valid.length + rejectedTotal + errors !== total) {
    console.warn(`⚠️ Incohérence de comptage : ${valid.length} + ${rejectedTotal} + ${errors} ≠ ${total}`);
  }

  return valid;
}
