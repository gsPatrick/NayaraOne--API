'use strict';

/**
 * Worker de importação do extrato bancário (Guia M4 §2 workers/bank-import.worker). Ponto de entrada executável
 * da importação que já existe: lê o extrato de cada conexão bancária ativa da empresa pelo registro de
 * integrações (cursor por conexão, página e idempotência por linha) e grava as linhas novas. Quem chama hoje é o
 * job bankPaymentReconciliationJob; o agendamento e a fila em segundo plano são da demanda M4-D070.
 *
 * ctx: { group, company, onlyConnectionId? } — grupo e empresa (com `id`) cujo extrato é importado.
 * Devolve o resumo da importação ({ imported, ... }).
 */
const bankHub = require('../application/services/bank-hub');

async function runBankImport(ctx) {
  if (!ctx || !ctx.group || !ctx.company) throw new Error('runBankImport: informe o grupo e a empresa (ctx.group, ctx.company).');
  return bankHub.sweepStatements({ group: ctx.group, company: ctx.company, onlyConnectionId: ctx.onlyConnectionId });
}

module.exports = { runBankImport };
