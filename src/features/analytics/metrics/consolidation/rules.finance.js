'use strict';

/**
 * M9-D625 — regras de consolidação dos indicadores do Financeiro que já existem por empresa. Os dois de caixa (M9-D620) somam as empresas: o caixa
 * livre contém a perna liquidada da transferência entre empresas (sai de uma conta, entra em outra), então nada é eliminado, mas par incompleto
 * deixa o consolidado DEGRADED. O dinheiro de terceiros não contém transferência. Contas a pagar e recebíveis em janelas (M9-D621) só contam
 * lançamentos RECEIVABLE e PAYABLE; a transferência entre empresas é ADJUSTMENT, portanto também não há o que eliminar. Cada demanda de KPI do Financeiro
 * que entregar outro indicador por empresa registra a sua regra com `registerConsolidationRule` (taxa: RATE; fluxo com a perna dentro: SUM com intercompany).
 */
const { registerConsolidationRule, getConsolidationRule } = require('./rules');

const REGISTER = [
  ['fin.free_cash', { kind: 'SUM', intercompany: { side: 'NONE' } }],
  ['fin.third_party_cash', { kind: 'SUM' }],
  ['fin.breathing_need', { kind: 'NONE', reason: 'indicador composto (mínimo entre zero e uma soma de componentes): não se soma entre empresas' }],
  ...[7, 30, 60].flatMap((n) => [[`fin.payables_${n}d`, { kind: 'SUM' }], [`fin.receivables_${n}d`, { kind: 'SUM' }]]),
];
for (const [code, rule] of REGISTER) if (!getConsolidationRule(code)) registerConsolidationRule(code, rule);
