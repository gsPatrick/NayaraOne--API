'use strict';

// Dados de partida do BCP para o contract test (M9-D842, não é teste): setores, evidência, operação a importar e divergência a decidir. Banco descartável.
const env = require('./m9d832Env');

let context = null;

/** Setores dos perfis de CI e o contexto de negócio (recebível, processo jurídico e de financiamento) para os formulários. */
async function bcpPrepare(_vars, { tenants }) {
  await env.prepare(tenants.A);
  context = await env.context(tenants.A);
  return {};
}

/** Foto do papel gravada de verdade (evidência do POST /bcp/manual-operations). */
async function bcpEvidence(_vars, { tenants }) {
  return { evidenceFileId: await env.evidence(tenants.A) };
}

/** Operação RECORDED pronta para a importação (cadastro de lead). */
async function bcpRecorded(_vars, { tenants }) {
  const op = await env.recordAction(tenants.A, 'REGISTER_LEAD', context);
  return { bcpImportOpId: op.id };
}

/** Recebimento de R$ 1.250,00 contra um recebível de R$ 1.205,00: a importação deixa a conferência DIVERGENT, à espera da decisão. */
async function bcpDivergent(_vars, { tenants }) {
  const A = tenants.A;
  const receivableId = await require('./m9d832More').createReceivable(A, context.base, 1205);
  const op = await env.recordAction(A, 'RECEIVE_PAYMENT', { ...context, receivableId }, { valorCentavos: 125000 });
  await env.importIds(A, [op.id]);
  const row = await env.reconciliationOf(op.id);
  return { reconciliationId: row.id };
}

module.exports = { bcpPrepare, bcpEvidence, bcpRecorded, bcpDivergent };
