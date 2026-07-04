const BOITES = [
  { name: 'PREMIUM',    min: 7.5  },
  { name: 'BON',        min: 5.5  },
  { name: 'PROMETTEUR', min: 3.5  },
  { name: 'SURVEILLER', min: 2.0  },
  { name: 'EXCLUS',     min: -Infinity },
];

function getBoite(score) {
  return BOITES.find(b => score >= b.min)?.name ?? 'EXCLUS';
}

export function filterWallets(scoredWallets) {
  const result = { PREMIUM: [], BON: [], PROMETTEUR: [], SURVEILLER: [], EXCLUS: [] };

  for (const wallet of scoredWallets) {
    if (wallet == null) continue;
    result[getBoite(wallet.score)].push(wallet);
  }

  for (const arr of Object.values(result)) {
    arr.sort((a, b) => b.score - a.score);
  }

  return result;
}
