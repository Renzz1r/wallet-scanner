// Tableau des funding rates actuels sur MAINNET (lecture publique, sans clé).
// Funding Hyperliquid : taux horaire ; APR = taux × 24 × 365.
// À lancer avec : node hyperliquid/funding-table.mjs
import { HttpTransport, InfoClient } from '@nktkas/hyperliquid';

const MIN_OPEN_INTEREST_USD = 1_000_000; // écarte les perps illiquides
const TOP_N = 20;

const info = new InfoClient({ transport: new HttpTransport() });
const [meta, assetCtxs] = await info.metaAndAssetCtxs();

const rows = meta.universe
  .map((asset, i) => {
    const ctx = assetCtxs[i];
    const funding = parseFloat(ctx.funding);          // taux horaire
    const markPx = parseFloat(ctx.markPx);
    const oiUsd = parseFloat(ctx.openInterest) * markPx;
    return {
      asset: asset.name,
      'funding/h %': (funding * 100).toFixed(4),
      'APR %': (funding * 24 * 365 * 100).toFixed(1),
      'OI (M$)': (oiUsd / 1e6).toFixed(1),
      'mark': markPx,
    };
  })
  .filter(r => parseFloat(r['OI (M$)']) * 1e6 >= MIN_OPEN_INTEREST_USD)
  .sort((a, b) => parseFloat(b['APR %']) - parseFloat(a['APR %']));

console.log(`Funding rates mainnet — ${new Date().toISOString()}`);
console.log(`(filtre : open interest ≥ ${MIN_OPEN_INTEREST_USD / 1e6} M$ — ${rows.length} assets)\n`);
console.log('Top funding POSITIF (candidats basis : short perp + long spot) :');
console.table(rows.slice(0, TOP_N));
console.log('Funding le plus NÉGATIF (à éviter / sens inverse) :');
console.table(rows.slice(-5));
