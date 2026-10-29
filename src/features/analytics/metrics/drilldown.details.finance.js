'use strict';

// M9-D690 (3.3) — campos e tela do registro no detalhe dos indicadores do Financeiro (origem: lançamentos e parcelas de comissão).
const { registerDrilldownDetail } = require('./drilldown.details');

const LEDGER = { columns: ['is_third_party_funds', 'due_at', 'settled_at'], link: '/painel/financeiro/lancamentos/{id}' };
const LEDGER_CODES = [
  'fin.free_cash', 'fin.third_party_cash', 'fin.overdue_payables', 'fin.overdue_receivables',
  ...[7, 30, 60].flatMap((n) => [`fin.payables_${n}d`, `fin.receivables_${n}d`]),
];
for (const code of LEDGER_CODES) registerDrilldownDetail(code, LEDGER);
registerDrilldownDetail('fin.commissions_unlinked_30d', { columns: ['due_at'], link: '/painel/financeiro/comissoes-repasses' });
