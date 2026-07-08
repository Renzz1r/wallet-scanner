// Smoke test SDK sur TESTNET : connexion info + signature d'un ordre limite
// loin du marché + annulation. À lancer avec :
//   node --env-file=.env hyperliquid/smoke-test.mjs
import { HttpTransport, InfoClient, ExchangeClient } from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';

const ADDRESS = process.env.HL_ADDRESS;
const wallet = privateKeyToAccount(process.env.HL_PRIVATE_KEY);
if (wallet.address.toLowerCase() !== ADDRESS.toLowerCase()) {
  throw new Error('HL_PRIVATE_KEY ne correspond pas à HL_ADDRESS');
}

const transport = new HttpTransport({ isTestnet: true });
const info = new InfoClient({ transport });
const exchange = new ExchangeClient({ transport, wallet });

// --- 1. Lecture des DEUX poches : perp et spot (le drip crédite souvent le spot) ---
const [perpState, spotState] = await Promise.all([
  info.clearinghouseState({ user: ADDRESS }),
  info.spotClearinghouseState({ user: ADDRESS }),
]);
let perpBalance = parseFloat(perpState.marginSummary?.accountValue ?? '0');
const spotUsdc = parseFloat(
  spotState.balances?.find(b => b.coin === 'USDC')?.total ?? '0'
);
console.log(`Poche perp : ${perpBalance} USDC — poche spot : ${spotUsdc} USDC`);

if (perpBalance === 0 && spotUsdc === 0) {
  console.log(
    '❌ Aucun fonds ni en perp ni en spot. Vérifie sur app.hyperliquid-testnet.xyz que\n' +
    `   l'adresse connectée au moment du drip était bien ${ADDRESS}.`
  );
  process.exit(1);
}

// --- 2. Si le drip est en spot : bascule spot→perp (action signée = 1er test de signature).
// Sur un compte "unifié" (spot et perp partagent le collatéral), ce transfert
// n'existe plus et n'est pas nécessaire : on continue directement.
if (perpBalance === 0 && spotUsdc > 0) {
  try {
    console.log(`Transfert spot → perp de ${spotUsdc} USDC...`);
    await exchange.usdClassTransfer({ amount: String(spotUsdc), toPerp: true });
    const refreshed = await info.clearinghouseState({ user: ADDRESS });
    perpBalance = parseFloat(refreshed.marginSummary?.accountValue ?? '0');
    console.log(`✅ Transfert signé et exécuté — poche perp : ${perpBalance} USDC`);
  } catch (err) {
    if (/unified account/i.test(String(err.message ?? err))) {
      console.log('ℹ️ Compte unifié : le spot sert directement de collatéral perp — transfert inutile.');
    } else {
      throw err;
    }
  }
}

// --- 3. Résolution dynamique de BTC sur le testnet : index + précision de taille ---
const meta = await info.meta();
const btcIndex = meta.universe.findIndex(a => a.name === 'BTC');
if (btcIndex === -1) throw new Error('BTC introuvable dans meta.universe testnet');
const { szDecimals } = meta.universe[btcIndex];

const mids = await info.allMids();
const btcMid = parseFloat(mids.BTC);
// Prix : ≤ 5 chiffres significatifs → arrondi à la centaine, à -30% du mid.
const safePrice = String(Math.round(btcMid * 0.7 / 100) * 100);
// Taille : ~15 $ de notionnel (minimum exchange : 10 $), multiple de 10^-szDecimals.
const step = 10 ** -szDecimals;
const size = (Math.ceil((15 / btcMid) / step) * step).toFixed(szDecimals);
console.log(
  `BTC testnet : index ${btcIndex}, szDecimals ${szDecimals}, mid ${btcMid}` +
  ` → ordre ${size} BTC @ ${safePrice} (~$${(size * safePrice).toFixed(0)})`
);

// --- 4. Signature : ordre limite GTC loin du marché, puis annulation ---
const result = await exchange.order({
  orders: [{
    a: btcIndex,
    b: true,
    p: safePrice,
    s: size,
    r: false,
    t: { limit: { tif: 'Gtc' } },
  }],
  grouping: 'na',
});
const status = result.response?.data?.statuses?.[0];
if (status?.resting) {
  console.log(`✅ Ordre signé et accepté — oid ${status.resting.oid}`);
  await exchange.cancel({ cancels: [{ a: btcIndex, o: status.resting.oid }] });
  console.log('✅ Annulation OK — pipeline de signature entièrement validé.');
} else if (status?.error) {
  console.log(`❌ Ordre refusé : ${status.error}`);
  process.exit(1);
} else {
  console.log('Réponse inattendue :', JSON.stringify(result.response?.data ?? result));
}
