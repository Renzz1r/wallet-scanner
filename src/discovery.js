import WebSocket from 'ws';
import 'dotenv/config';
import { saveWalletsBatch } from './database.js';

const HELIUS_KEY = process.env.HELIUS_API_KEY;

const FLUSH_INTERVAL_MS = 5000;
const DRAIN_TIMEOUT_MS = 60000;

const DEX_ACCOUNTS = [
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
];

export function startWalletDiscovery(onCollectComplete, collectDurationMs = 3600000) {
  console.log('🔌 Connexion WebSocket Helius...');

  const ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`);
  let count = 0;
  let stopping = false;
  let flushing = false;
  const pendingCounts = new Map();

  async function flush() {
    if (flushing || pendingCounts.size === 0) return;
    flushing = true;
    const batch = new Map(pendingCounts);
    pendingCounts.clear();
    try {
      await saveWalletsBatch(batch);
    } catch (err) {
      console.error(`\nFlush échoué (${batch.size} wallets) : ${err.message}`);
      // Réinjecte le batch pour retenter au prochain flush.
      for (const [address, n] of batch) {
        pendingCounts.set(address, (pendingCounts.get(address) ?? 0) + n);
      }
    } finally {
      flushing = false;
    }
  }

  // Flush final avec feedback : retente jusqu'à vider la Map, abandonne
  // au-delà de DRAIN_TIMEOUT_MS plutôt que d'attendre indéfiniment.
  async function finalFlush() {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;

    while ((flushing || pendingCounts.size > 0) && Date.now() < deadline) {
      process.stdout.write(`\r💾 Flush final : ${pendingCounts.size} wallets en attente...   `);
      if (flushing) {
        await new Promise(r => setTimeout(r, 200));
      } else {
        await flush();
        // Si la Map n'est pas vide, le flush a échoué : pause avant de retenter.
        if (pendingCounts.size > 0) await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (pendingCounts.size > 0) {
      console.warn(
        `\n⚠️ Timeout du flush final (${DRAIN_TIMEOUT_MS / 1000}s) — ` +
        `${pendingCounts.size} wallets abandonnés.`
      );
      pendingCounts.clear();
    } else {
      process.stdout.write('\r💾 Flush final terminé.                        \n');
    }
  }

  const flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);

  ws.on('open', () => {
    console.log('✅ WebSocket connecté — collecte en cours...');
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'transactionSubscribe',
      params: [
        { failed: false, accountInclude: DEX_ACCOUNTS },
        {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
          transactionDetails: 'full',
          encoding: 'jsonParsed',
        },
      ],
    }));
  });

  ws.on('message', (raw) => {
    if (stopping) return;
    try {
      const msg = JSON.parse(raw);
      if (!msg.params?.result) return;

      const tx = msg.params.result.transaction;
      const accounts = tx?.transaction?.message?.accountKeys ?? [];
      const first = accounts[0];
      const signer = typeof first === 'string' ? first : first?.pubkey;

      if (signer) {
        count++;
        process.stdout.write(`\r📡 ${count} swaps détectés...`);
        pendingCounts.set(signer, (pendingCounts.get(signer) ?? 0) + 1);
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });

  ws.on('close', async () => {
    clearTimeout(timer);
    clearInterval(flushTimer);
    stopping = true;
    await finalFlush();
    console.log(`🔌 WebSocket fermé — ${count} swaps détectés au total.`);
    try {
      await onCollectComplete();
    } catch (err) {
      console.error('Erreur pendant le traitement post-collecte:', err);
    }
  });

  const timer = setTimeout(() => {
    console.log('\n⏱️ Durée de collecte atteinte');
    stopping = true;
    ws.close();
  }, collectDurationMs);
}
