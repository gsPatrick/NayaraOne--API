'use strict';

/**
 * Pontos de extensão dos blockers que outras demandas da migração v2 definem (M9-D901 §3.3): comparação paralela fora da tolerância (M9-D903), relógio fora da tolerância
 * (M9-D908) e operação externa irreversível sem plano (M9-D907). Cada demanda registra aqui uma função `(tenant, scope, transaction) => [{ code, entity, ref, owner, detail }]`;
 * a Torre junta o resultado ao das condições próprias. Sem provedor registrado, não há blocker desse tipo.
 */
const registered = new Map();

function register(name, provider) {
  if (typeof provider !== 'function') throw new Error('Provedor de blocker deve ser uma função.');
  registered.set(name, provider);
  return () => registered.delete(name);
}

async function collect(tenant, scope, transaction) {
  const out = [];
  for (const provider of registered.values()) {
     
    out.push(...await provider(tenant, scope, transaction));
  }
  return out;
}

module.exports = { register, collect };
