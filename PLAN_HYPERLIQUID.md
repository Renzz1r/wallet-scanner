# Plan d'exécution — Pivot Hyperliquid

> Rédigé le 2026-07-08. Endpoints vérifiés contre la doc officielle + testés en direct.
> Deux volets, chacun avec une porte de falsification : on ne construit l'étape suivante
> que si l'étape courante prouve son espérance.

## 0. Contexte de la décision

Le copy trading memecoin Solana est invalidé comme stratégie de gain par quatre limites
structurelles : alpha decay à la copie, biais hot hand du scoring court, latence de copie
incompatible avec des holds de minutes, et edge majoritairement narratif (non transférable)
plutôt qu'exécution. Le scanner Solana est rétrogradé en couche de veille. Le projet pivote
vers Hyperliquid avec deux volets :

- **Volet 2 (à démarrer en premier)** : market-neutral funding/basis — espérance connue,
  modeste, 100 % reproductible ; sert aussi de tutoriel du venue.
- **Volet 1** : copy sélectif de wallets — espérance inconnue, à falsifier par backtest
  de persistance AVANT toute infrastructure de copie.

La méthodologie héritée de Solana (funnel de vérification, mesure de persistance,
blacklist TTL, clustering anti-jumeaux) est conservée ; le code ne l'est pas.

## 1. Stack & SDK — recommandation

**Utiliser `@nktkas/hyperliquid` (npm, v0.33.1 au 2026-07-08) pour tout, version épinglée.**

Raisonnement :
- La couche *lecture* (info endpoints) pourrait se faire en `fetch` brut (un wrapper de
  5 lignes), mais le SDK apporte le typage des réponses et la gestion du transport WS.
- La couche *exécution* (ordres du Volet 2) tranche la question : la signature Hyperliquid
  (hash msgpack de l'action + EIP-712 + nonces + agent wallets) est piégeuse à coder à la
  main avec de l'argent réel. C'est là qu'un SDK est non négociable.
- On reste en Node.js (stack du projet existant). Le SDK officiel Python
  (`hyperliquid-dex/hyperliquid-python-sdk`) sert de **implémentation de référence** en cas
  de doute sur la signature — pas de stack secondaire.
- Risque de dépendance communautaire : version épinglée, smoke test de signature sur
  testnet avant tout ordre mainnet, et wrapper interne mince autour du SDK pour pouvoir
  en changer sans toucher au reste.

## 2. Référence API confirmée

Base REST : `POST https://api.hyperliquid.xyz/info` (toujours POST, `type` dans le body).
Base WS : `wss://api.hyperliquid.xyz/ws`.

| Donnée | Requête | Usage |
|---|---|---|
| Fills récents d'un wallet | `{"type":"userFills","user":"0x…"}` | stats trade-level |
| Fills par période (paginé) | `{"type":"userFillsByTime","user":"0x…","startTime":…,"endTime":…}` | historique complet, hold time, levier effectif |
| Equity curve + PnL | `{"type":"portfolio","user":"0x…"}` → `pnlHistory`, `accountValueHistory` (day/week/month/allTime) | rendements journaliers → toutes les stats de persistance |
| État du compte live | `{"type":"clearinghouseState","user":"0x…"}` | positions, marge, levier (paper trading + monitoring basis) |
| Funding payé/reçu par wallet | `{"type":"userFundings","user":"0x…"}` (existe aussi en WS) | P&L funding du Volet 2, comptabilité |
| Funding rates historiques | `{"type":"fundingHistory",…}` | backtest de rendement basis, choix des assets |
| Leaderboard global | `GET https://stats-data.hyperliquid.xyz/Mainnet/leaderboard` | univers du Volet 1 |

### Pièges connus (vérifiés)

1. **Agent wallets** : ne JAMAIS interroger les données de compte avec l'adresse d'un agent
   wallet — résultat **vide silencieux**, pas d'erreur. Toujours l'adresse du compte
   principal ou du sub-account. → Garde-fou dans l'indexeur : alerter si `portfolio`
   retourne vide pour une adresse issue du leaderboard (incohérence = probable agent).
2. **Le leaderboard n'est PAS dans la doc officielle** (domaine séparé `stats-data.…`).
   Testé le 2026-07-08 : HTTP 200, sans clé, ~33 Mo, structure
   `leaderboardRows[] = { ethAddress, accountValue, windowPerformances: [day|week|month|allTime → {pnl, roi, vlm}] }`.
   Il peut disparaître sans préavis. **Fallback prévu** : reconstruire un univers en
   collectant les adresses actives via le WS `trades` des principaux assets pendant
   quelques heures (équivalent de notre discovery Solana, en plus simple), puis
   `portfolio` sur chacune. Le leaderboard est un raccourci, pas une dépendance dure.
3. **Rate limit REST en poids (~1200/min/IP)** : l'indexeur doit être patient (crawl de
   ~500 adresses × historique = quelques heures, avec cache local). Ne pas paralléliser
   agressivement.
4. **Corriger les flux de capital** : le ROI brut ment si le compte dépose/retire.
   Utiliser `userNonFundingLedgerUpdates` pour des rendements time-weighted.

## 3. VOLET 2 — Market-neutral funding/basis (démarrage immédiat)

### Concept (rappel une ligne)
Short perp + long spot du même montant = exposition prix nulle ; le short encaisse le
funding horaire tant qu'il est positif. Profit = funding − frais. Aucune prédiction.

### Étapes
1. **Jour 1** : compte Hyperliquid + petit capital de test (montant qu'on accepte de
   perdre à 100 % — risque de venue binaire). Smoke test SDK sur testnet (signature,
   ordre, annulation).
2. **Jour 1-2** : script de lecture des funding (`metaAndAssetCtxs` + `fundingHistory`) —
   tableau des APR courants et moyens 7j/30j par asset, majors uniquement au début
   (jambe spot sur Hyperliquid spot : UBTC, UETH, HYPE…).
3. **Jour 2-3** : première position manuelle (~500 $) : long spot + short perp levier ≤ 2.
   Comptabilité exacte via `userFundings`.
4. **Semaine 2** : monitoring automatisé — alertes Telegram si funding < 0 pendant N heures
   (sortie), si buffer de marge du short < 25 % (rééquilibrer), rapport quotidien.
5. **Ensuite** : rotation disciplinée (ne bouger que si l'écart de funding le justifie sur
   ≥ 1 semaine — 4 jambes de frais par rotation ≈ 0,2-0,4 %).

### Attentes et risques
- Rendement réaliste net : **10-25 % APR** avec rotation raisonnable ; à 1-5 k$ c'est un
  laboratoire rentable (~10-100 $/mois), pas un revenu — sa valeur : maîtrise du venue +
  edge reproductible qui scale linéairement avec le capital.
- Risques classés : (1) liquidation du short sur pump violent → levier ≤ 2 + rééquilibrage
  auto (LE composant critique à fiabiliser) ; (2) inversion du funding → règle de sortie
  automatique ; (3) risque de venue (bridge, centralisation) → capital plafonné ;
  (4) frais de rotation → discipline hebdo ; (5) illiquidité spot hors majors → majors only.
- Surveillance : semi-active (alertes + 10 min/jour) une fois le monitoring en place.

## 4. VOLET 1 — Copy sélectif (backtest d'abord, infra ensuite)

### 4.1 Indexeur (jours 1-3, partagé avec Volet 2)
- Snapshot leaderboard → univers brut.
- Qualification : ≥ 90 j d'historique, ≥ 100 fills, equity moyenne ≥ 10 k$, rendements
  corrigés des dépôts/retraits. Cible **≥ 300-500 adresses qualifiées** (en dessous,
  pas de puissance statistique).
- Par adresse : `portfolio` (rendements journaliers), `userFillsByTime` (levier effectif,
  hold time, comptage), `userNonFundingLedgerUpdates` (correction des flux).
- Stockage : Postgres existant (nouvelles tables `hl_accounts`, `hl_daily_returns`,
  `hl_fills`), crawl patient sous le rate limit.

### 4.2 Backtest de persistance (jours 4-8)
Question falsifiable : **le classement d'une période prédit-il la suivante ?**
- Fenêtres roulantes : formation 60 j → classement risk-adjusted → évaluation sur les
  30 j suivants, non chevauchants, décalage de 30 j. **≥ 4 périodes d'évaluation**
  (≈ 6 mois d'historique, disponibles immédiatement).
- Trois mesures, pas une :
  1. **IC de Spearman** entre Sharpe(formation) et Sharpe(holdout) — persistance réelle si
     IC moyen > 0,1 avec IC bootstrap 95 % excluant 0 ;
  2. **Test de portefeuille** : top-décile en holdout vs médiane de l'univers, net de
     coûts simulés (taker 0,045 % + 1 tick de slippage) ;
  3. **Matrice de transition** : P(top-décile → top-quartile suivant) vs 25 % du hasard.
- Contrôles anti-illusion : inclure les comptes morts en holdout (liquidation = rendement
  réel, pas donnée manquante) ; benchmark « long BTC au même levier moyen » (beaucoup de
  génies de leaderboard sont juste long le marché).

### 4.3 Filtres « levier-chanceux » (appliqués à la formation)
1. Rendement sur **notionnel max**, pas sur equity ;
2. Concentration : part des 5 meilleurs jours dans le PnL total ≤ 60 % ;
3. Distance à la liquidation : jamais < 15 % de buffer sur l'historique ;
4. Levier effectif : moyen ≤ 5, max ≤ 15 ;
5. Sharpe journalier ≥ 1, max drawdown ≤ 30 % sur 90 j ;
6. Asymétrie de sizing perdants/gagnants (anti-martingale).

### 4.4 PORTE N°1
IC indistinguable de zéro sur 4 fenêtres → **volet tué**, on ne construit pas le paper
trading. Coût du test : ~0 $.

### 4.5 Paper trading (4 semaines, si porte franchie)
- Miroir simulé via WS `userFills` des 5-10 sélectionnés : exécution à prix mark + 1 tick
  + taker fee, latence simulée 2-5 s, sizing **vol-target** (jamais le levier brut copié).
- Une rotation de sélection à mi-parcours.
- **PORTE N°2, fixée à l'avance, non renégociable** : PnL net > 0 **ET** Sharpe > 0,5
  **ET** PnL net toujours > 0 après retrait du meilleur trade. Un critère raté → volet
  tué ou renvoyé en backtest.

## 5. Séquencement

| Période | Volet 2 | Volet 1 |
|---|---|---|
| J1-J3 | Compte + smoke test SDK + tableau funding + 1re position manuelle | Indexeur (partagé) |
| J4-J8 | Comptabilité `userFundings`, réglages | Backtest persistance → **PORTE 1** |
| Sem. 2 | Monitoring/alertes automatisés | Infra paper trading (si porte franchie) |
| Sem. 3-6 | Tourne en semi-auto, rotation hebdo | Paper run → **PORTE 2** |

Charge estimée : indexeur 2-3 j ; backtest 3-5 j ; monitoring basis 2-3 j ; infra paper
2-3 j ; paper 4 semaines calendaires (~15 min/j).

## 6. Hygiène de projet

- Testnet d'abord pour toute signature/ordre ; clés dans `.env`, jamais commitées.
- Chaque porte de décision = un verdict écrit dans ce fichier avec les chiffres.
- Le scanner Solana reste en l'état (veille) ; aucune maintenance active pendant le pivot.
