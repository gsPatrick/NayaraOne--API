'use strict';

// M9-D690 (3.3) — campos e tela do registro no detalhe dos indicadores do Financeiro (origem: lançamentos e parcelas de comissão).
const { registerDrilldownDetail } = require('./drilldown.details');

const LEDGER = { columns: ['is_third_party_funds', 'due_at', 'settled_at'], link: '/painel/financeiro/lancamentos/{id}' };
const LEDGER_CODES = [
  'fin.free_cash', 'fin.third_party_cash', 'fin.overdue_payables', 'fin.overdue_receivables',
  ...[7, 30, 60].flatMap((n) => [`fin.payables_${n}d`, `fin.receivables_${n}d`]),
];
for (const code of LEDGER_CODES) registerDrilldownDetail(code, LEDGER);
// M9-D620: no dinheiro de terceiros o detalhe mostra a origem (referência) e a pessoa detentora; só quem tem analytics:drilldown e finance:read chega aqui
registerDrilldownDetail('fin.third_party_cash', { columns: [...LEDGER.columns, 'third_party_reference', 'third_party_holder_person_id', 'third_party_release_type'], link: LEDGER.link });
registerDrilldownDetail('fin.commissions_unlinked_30d', { columns: ['due_at'], link: '/painel/financeiro/comissoes-repasses' });
// M9-D623: margem por setor (lançamentos da competência), parcelas de comissão e repasses ao proprietário
registerDrilldownDetail('fin.sector_margin', { columns: ['result_center_id', 'competence_month', 'settled_at'], link: LEDGER.link });
registerDrilldownDetail('fin.commissions_provisioned', { columns: ['due_at', 'installment_number'], link: '/painel/financeiro/comissoes-repasses' });
registerDrilldownDetail('fin.commissions_paid', { columns: ['paid_at', 'installment_number'], link: '/painel/financeiro/comissoes-repasses' });
registerDrilldownDetail('fin.owner_repasses_pending', { columns: ['reference_month', 'created_at'], link: '/painel/financeiro/comissoes-repasses' });
