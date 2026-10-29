'use strict';

// Dados de partida dos exemplos do contract test (M9-D842, não é teste): o exemplo nomeia o preparo em "seed" e as variáveis devolvidas ficam à disposição dos exemplos seguintes.
const seeds = { ...require('./m9d842SeedBcp'), ...require('./m9d842SeedData'), ...require('./m9d842SeedLegal') };

/** Roda os preparos pedidos pelo exemplo (nome ou lista de nomes) e devolve as variáveis novas. */
async function runSeeds(example, vars, ctx) {
  const out = {};
  for (const name of [].concat(example.seed || [])) {
    if (!seeds[name]) throw new Error(`preparo "${name}" do exemplo não existe`);
    Object.assign(out, await seeds[name]({ ...vars, ...out }, ctx));
  }
  return out;
}

module.exports = { runSeeds, SEED_NAMES: Object.keys(seeds) };
