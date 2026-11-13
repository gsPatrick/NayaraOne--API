'use strict';

/**
 * Worker de conciliação automática (Guia M4 §2 workers/reconciliation.worker). Ponto de entrada executável da
 * conciliação que já existe: casa as saídas do extrato importado com os pagamentos enviados ao banco (valor em
 * centavos, favorecido e data dentro da tolerância da empresa) e abre revisão humana quando o valor diverge.
 * Quem chama hoje é o job bankPaymentReconciliationJob; o agendamento e a fila em segundo plano são da demanda
 * M4-D070.
 *
 * ctx: { group, company } — grupo e empresa (com `id`) cujo extrato é conciliado.
 * Devolve o resumo ({ reconciled, mismatched }).
 */
const bankHub = require('../application/services/bank-hub');

async function runReconciliation(ctx) {
  if (!ctx || !ctx.group || !ctx.company) throw new Error('runReconciliation: informe o grupo e a empresa (ctx.group, ctx.company).');
  return bankHub.reconcileStatements({ group: ctx.group, company: ctx.company });
}

module.exports = { runReconciliation };
