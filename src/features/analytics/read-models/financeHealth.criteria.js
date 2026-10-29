'use strict';

/**
 * M9-D615 / M9-D611 (3.3) — critérios (não os ids) que reproduzem cada componente do agregado, guardados em rm_finance_health.source_criteria
 * para o `sourceRefs` não depender do OLTP pesado: um filtro canônico por código de KPI, o mesmo que a especificação de origem da
 * M9-D611 aplica à tabela do Financeiro. Instantes em ISO (UTC); período com início inclusivo e fim exclusivo.
 */
const { iso } = require('./financeHealth.dates');
const { businessDateKey } = require('../../../utils/businessDate');

const OWN = { thirdParty: false, reversal: null };

/** M9-D623: critérios das margens por setor, comissões e repasses (o mesmo filtro que a especificação de origem aplica à tabela do Financeiro). */
function resultCriteria(companyId, b) {
  return {
    'fin.sector_margin': { companyId, status: ['SETTLED'], nature: ['PAYABLE', 'RECEIVABLE'], equals: { ...OWN, competenceMonth: businessDateKey(b('monthStart')).slice(0, 7) } },
    'fin.commissions_provisioned': { companyId, status: ['PENDING'] },
    'fin.commissions_paid': { companyId, period: { from: b('monthStart'), to: b('nextMonthStart') }, status: ['PAID'] },
    'fin.owner_repasses_pending': { companyId, status: ['PENDING', 'APPROVED'] },
  };
}

function financeCriteria(companyId, bounds) {
  const b = (key) => iso(bounds[key]);
  const pending = (nature, from, to) => ({ companyId, period: { from: from ? b(from) : null, to: b(to) }, status: ['PENDING'], nature: [nature], equals: { ...OWN } });
  const settled = (equals) => ({ companyId, period: { from: null, to: b('dayEnd') }, status: ['SETTLED'], nature: ['PAYABLE', 'RECEIVABLE'], equals });
  return {
    'fin.free_cash': settled({ ...OWN }),
    'fin.third_party_cash': settled({ thirdParty: true, reversal: null }),
    'fin.payables_7d': pending('PAYABLE', 'today', 'horizon7'),
    'fin.payables_30d': pending('PAYABLE', 'today', 'horizon30'),
    'fin.payables_60d': pending('PAYABLE', 'today', 'horizon60'),
    'fin.receivables_7d': pending('RECEIVABLE', 'today', 'horizon7'),
    'fin.receivables_30d': pending('RECEIVABLE', 'today', 'horizon30'),
    'fin.receivables_60d': pending('RECEIVABLE', 'today', 'horizon60'),
    'fin.overdue_payables': pending('PAYABLE', null, 'today'),
    'fin.overdue_receivables': pending('RECEIVABLE', null, 'today'),
    'fin.reconciliations_pending': { companyId, period: { from: null, to: b('dayEnd') } }, // M9-D624: a origem exclui as transações já conciliadas
    'fin.anomalies_open': { companyId, status: ['OPEN'] },
    ...resultCriteria(companyId, b), // M9-D623
    'fin.commissions_unlinked_30d': { companyId, period: { from: null, to: b('horizon30') }, status: ['PENDING'], equals: { financialEntryId: null } },
  };
}

module.exports = { financeCriteria };
