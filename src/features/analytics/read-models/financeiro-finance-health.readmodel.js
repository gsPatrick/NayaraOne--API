'use strict';

/**
 * M9-D615 — read model rm_finance_health (schema analytics): uma linha por empresa e data-base com os números que a diretoria olha todo dia
 * (caixa livre, dinheiro de terceiros, contas e recebíveis em 7/30/60 dias, vencidos, pendências, comissões, anomalias e necessidade
 * para respirar). Por EMPRESA: nunca soma empresas (a consolidação é feita na leitura, M9-D625). Só ids e agregados: nenhum nome nem
 * documento entra aqui.
 *
 * O worker (M9-D607) chama `recompute` com o ESTADO atual da fonte (nunca delta), de forma idempotente por sourceEventId; a agenda
 * (a cada 15 min e às 00:05 de São Paulo) recalcula o que depende do relógio (janelas e vencidos mudam sem nenhum evento).
 */
const { registerReadModel } = require('./readModel.registry');
const { sequelize } = require('../../../models');
const { businessDateKey } = require('../../../utils/businessDate');
const clock = require('../metrics/clock');
const { HEALTH_EVENTS } = require('./financeHealth.events');
const { financeBounds } = require('./financeHealth.dates');
const { readEntryComponents } = require('./financeHealth.entries');
const { readOtherComponents, breathingNeed } = require('./financeHealth.others');
const { financeCriteria } = require('./financeHealth.criteria');
const { readOverdueWindowDays } = require('./financeHealth.settings');
const { readCommissionDetails } = require('./financeHealth.commissions');
const { readOwnerRepasseDetail } = require('./financeHealth.repasses');

const MODEL = 'rm_finance_health';

/** M9-D624: campos extras que reproduzem os KPIs de conciliações pendentes e anomalias abertas (valor, idade, faixas, risco e tipo). */
const kpiFields = (o) => ({
  pending_reconciliations_amount: o.reconciliations.amount, pending_reconciliations_oldest_date: o.reconciliations.oldest,
  pending_reconciliations_by_band: o.reconciliations.byBand, last_statement_import_date: o.reconciliations.lastImportDate,
  open_anomalies_high: o.anomalies.byRisk.ALTO, open_anomalies_unclassified: o.anomalies.byRisk.NAO_CLASSIFICADO,
  open_anomalies_oldest_date: o.anomalies.oldest, open_anomalies_by_risk: o.anomalies.byRisk, open_anomalies_by_type: o.anomalies.byType,
});

/** M9-D623: detalhe das comissões (por corretor e tipo, sem corretor, paga sem lançamento) e dos repasses pendentes (por proprietário, imóvel e idade). */
async function resultFields(companyId, bounds, asOf, transaction) {
  const commissions = await readCommissionDetails(companyId, bounds, transaction);
  return {
    provisioned_commissions_detail: commissions.provisioned, paid_commissions_detail: commissions.paid,
    owner_repasses_detail: await readOwnerRepasseDetail(companyId, asOf, transaction),
  };
}

async function recompute({ companyId, groupId, key, now, transaction }) {
  const bounds = financeBounds(key.as_of_date, await readOverdueWindowDays({ companyId, groupId }, transaction));
  const e = await readEntryComponents(companyId, bounds, transaction);
  const o = await readOtherComponents(companyId, bounds, transaction, { groupId, asOf: key.as_of_date });
  const fields = {
    free_cash: e.free_cash, third_party_cash: e.third_party_cash,
    payables_7d: e.payables_7d, payables_30d: e.payables_30d, payables_60d: e.payables_60d,
    receivables_7d: e.receivables_7d, receivables_30d: e.receivables_30d, receivables_60d: e.receivables_60d,
    overdue_payables: e.overdue_payables, overdue_amount: e.overdue_amount,
    overdue_amount_in_window_90d: e.overdue_in_window, overdue_amount_outside_window_90d: e.overdue_outside_window, receivables_base_90d: e.receivables_base,
    pending_reconciliations: o.pendingReconciliations, pending_owner_repasses: o.pendingOwnerRepasses,
    provisioned_commissions: o.provisionedCommissions, paid_commissions: o.paidCommissions, commissions_unlinked_30d: o.commissionsUnlinked30d,
    open_anomalies: o.openAnomalies, entries_without_due_date: e.without_due_date,
    payables_without_due_date: e.payables_without_due_date, receivables_without_due_date: e.receivables_without_due_date, // M9-D621: qualidade das janelas por natureza
    ...kpiFields(o),
    ...(await resultFields(companyId, bounds, key.as_of_date, transaction)),
    source_criteria: financeCriteria(companyId, bounds),
  };
  fields.breathing_need = await breathingNeed({
    overduePayables: fields.overdue_payables, payables30d: fields.payables_30d, commissionsUnlinked30d: fields.commissions_unlinked_30d, freeCash: fields.free_cash,
  }, transaction);
  return { fields, sourceSnapshotAt: now };
}

/** M9-D699 / M9-D608: TODAS as datas-base da empresa (as linhas já gravadas) e a de hoje; o rebuild recalcula cada uma a partir das fontes. */
async function rebuildKeys({ companyId, now, transaction }) {
  const [rows] = await sequelize.query(`SELECT as_of_date::text AS as_of_date FROM analytics.${MODEL} WHERE company_id = :companyId`, { replacements: { companyId }, transaction });
  const dates = new Set([...rows.map((r) => r.as_of_date), businessDateKey(now || clock.now())]);
  return [...dates].sort().map((as_of_date) => ({ as_of_date }));
}

/** Snapshots dos KPIs financeiros (M9-D624) já gravados que dependem desta tabela: o rebuild os revisa (nova revisão) quando o número mudou. */
const corrections = (args) => require('../metrics/kpis').financeKpiCorrections(args);

const def = registerReadModel({
  name: MODEL,
  version: 1,
  keyColumns: ['as_of_date'],
  eventTypes: [...HEALTH_EVENTS],
  aggregateKey: (_event, { now }) => ({ as_of_date: businessDateKey(now) }), // o worker sempre informa o relógio (nunca new Date() aqui)
  recompute,
  scheduled: { keys: async ({ now }) => [{ as_of_date: businessDateKey(now) }] },
  rebuild: { keys: rebuildKeys, corrections },
});

module.exports = { def, recompute };
