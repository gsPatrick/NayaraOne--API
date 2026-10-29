'use strict';

// M9-D017 — a NAY só roda pela conexão de execução restrita (role nayara_runtime com RLS FORCE): nunca superusuário, dono do
// schema nem role com BYPASSRLS. A conferência vale para a transação da chamada e é feita uma vez por transação.

const { readConnectionIdentity } = require('../readmodels/connectionIdentity.readmodel');
const { connectionNotAllowed } = require('./toolSecurity.errors');

function assertRuntimeIdentity(identity) {
  if (!identity || identity.rolsuper === true || identity.rolbypassrls === true) throw connectionNotAllowed();
  return identity;
}

const conferidas = new WeakMap(); // transação -> identidade já aceita

async function assertRuntimeConnection(transaction) {
  if (!transaction) throw connectionNotAllowed();
  if (conferidas.has(transaction)) return conferidas.get(transaction);
  const identity = assertRuntimeIdentity(await readConnectionIdentity(transaction));
  conferidas.set(transaction, identity);
  return identity;
}

module.exports = { assertRuntimeIdentity, assertRuntimeConnection };
