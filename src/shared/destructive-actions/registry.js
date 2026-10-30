'use strict';

const inventory = require('./inventory');

/**
 * Registro dos provedores de impacto (M9-D852 §3.1/§3.3). Cada ação do inventário tem UM provedor:
 *   async ({ id, params, query, body, tenant, transaction, preview, req }) => ({ code, label?, skip?, impact:{counts,totalAmountCents,blockers,items} })
 * `code` é o texto que o usuário digita no nível 3; `skip: true` (só quando não é `preview`) diz que esta chamada não é a ação perigosa
 * (ex.: transição de obra para outro estado que não CANCELLED) e o guarda deixa passar. Demandas donas das linhas ainda sem rota
 * (retenção, legal hold, kill switch, rollback, publicação) registram o seu provedor aqui.
 */
const providers = new Map();

function registerProvider(key, fn) {
  inventory.get(key); // recusa chave fora do inventário
  providers.set(key, fn);
}

function getProvider(key) {
  const fn = providers.get(key);
  if (!fn) throw new Error(`Ação destrutiva sem provedor de impacto registrado: ${key}.`);
  return fn;
}

const registeredKeys = () => [...providers.keys()];

module.exports = { registerProvider, getProvider, registeredKeys };
