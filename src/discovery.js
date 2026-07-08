import WebSocket from 'ws';
import 'dotenv/config';
import { saveWalletsBatch } from './database.js';

const HELIUS_KEY = process.env.HELIUS_API_KEY;

const FLUSH_INTERVAL_MS = 5000;
const DRAIN_TIMEOUT_MS = 60000;
const PROGRESS_INTERVAL_MS = 15 * 60 * 1000;
// Helius peut cesser d'émettre sans fermer la socket (observé : collecte
// muette après ~30 min). Ping périodique + reconnexion si le flux se tait.
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const STALL_TIMEOUT_MS = 90 * 1000;
const RECONNECT_DELAY_MS = 5000;

// Programme bonding curve pump.fun : exclu de l'écoute (trades non
// reproductibles en copy trading), et droppé si un routeur y passe quand même.
const PUMP_BONDING_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const DEX_ACCOUNTS = [
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter v6 (agrégateur)
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',  // PumpSwap (AMM post-migration pump.fun)
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  // Meteora DLMM
];

export function startWalletDiscovery(onCollectComplete, collectDurationMs = 3600000) {
  console.log('🔌 Connexion WebSocket Helius...');

  let ws = null;
  let lastActivity = Date.now();
  let finished = false;
  let count = 0;
  let stopping = false;
  let flushing = false;
  const pendingCounts = new Map();
  // pendingCounts est vidée à chaque flush : ce Set garde le cumul des
  // wallets uniques vus depuis le début, sans requête DB.
  const seenWallets = new Set();
  const startedAt = Date.now();

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

  const progressTimer = setInterval(() => {
    const elapsedMin = Math.round((Date.now() - startedAt) / 60000);
    console.log(
      `\n📊 Progression : ${elapsedMin} min écoulées — ` +
      `${seenWallets.size} wallets uniques vus (${count} swaps)`
    );
  }, PROGRESS_INTERVAL_MS);

  // Fin de collecte unique et idempotente : appelée par le handler 'close'
  // quand stopping est posé, ou directement par le timer de durée si la
  // socket n'est pas ouverte à ce moment-là (reconnexion en cours).
  async function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearInterval(flushTimer);
    clearInterval(progressTimer);
    clearInterval(heartbeatTimer);
    await finalFlush();
    console.log(`🔌 Collecte terminée — ${count} swaps détectés au total.`);
    try {
      await onCollectComplete();
    } catch (err) {
      console.error('Erreur pendant le traitement post-collecte:', err);
    }
  }

  function connect() {
    ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`);
    lastActivity = Date.now();

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

    ws.on('pong', () => {
      lastActivity = Date.now();
    });

    ws.on('message', (raw) => {
      lastActivity = Date.now();
      if (stopping) return;
      try {
        const msg = JSON.parse(raw);
        if (!msg.params?.result) return;

        const tx = msg.params.result.transaction;
        const accounts = tx?.transaction?.message?.accountKeys ?? [];

        // Drop silencieux des tx touchant la bonding curve pump.fun (routage
        // Jupiter inclus) : ces trades ne sont pas copiables.
        const touchesBondingCurve = accounts.some(
          a => (typeof a === 'string' ? a : a?.pubkey) === PUMP_BONDING_PROGRAM
        );
        if (touchesBondingCurve) return;

        const first = accounts[0];
        const signer = typeof first === 'string' ? first : first?.pubkey;

        if (signer) {
          count++;
          process.stdout.write(`\r📡 ${count} swaps détectés...`);
          pendingCounts.set(signer, (pendingCounts.get(signer) ?? 0) + 1);
          seenWallets.add(signer);
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });

    ws.on('close', () => {
      if (stopping) {
        finish();
        return;
      }
      console.warn(`\n⚠️ WebSocket fermé prématurément — reconnexion dans ${RECONNECT_DELAY_MS / 1000}s...`);
      setTimeout(() => {
        if (!stopping) connect();
      }, RECONNECT_DELAY_MS);
    });
  }

  // Détection de flux muet : ping régulier, et reconnexion forcée si ni
  // message ni pong depuis STALL_TIMEOUT_MS.
  const heartbeatTimer = setInterval(() => {
    if (stopping || !ws || ws.readyState !== WebSocket.OPEN) return;
    const silentMs = Date.now() - lastActivity;
    if (silentMs > STALL_TIMEOUT_MS) {
      console.warn(`\n⚠️ Flux muet depuis ${Math.round(silentMs / 1000)}s — reconnexion forcée.`);
      ws.terminate(); // déclenche 'close' → reconnexion
    } else {
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  const timer = setTimeout(() => {
    console.log('\n⏱️ Durée de collecte atteinte');
    stopping = true;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(); // 'close' → finish()
    } else {
      // Socket absente ou en cours de reconnexion : terminer directement.
      finish();
    }
  }, collectDurationMs);

  connect();
}
