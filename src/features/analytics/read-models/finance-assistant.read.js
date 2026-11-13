'use strict';

/**
 * Leitura do read model financeiro do BI para a NAY Financeira (Caderno M4 §18; Guia M4 §13: ela "recebe esse read model; não precisa varrer
 * ledger bruto a cada pergunta"; DI-M4CC-4). Quem fica FORA da camada read-models lê o BI por aqui (M9-D700 e regras R1/R2 de
 * scripts/lib/analyticsReadScan.js): a permissão do domínio Financeiro vem do mapa domínio -> permissão do administrador (assertDomainAccess,
 * padrão finance:read) e a leitura roda sob o RLS da empresa da transação. Só leitura.
 *
 * `ctx`: { groupId, companyId, userId, permissions? }. Sem `permissions` (chamada de serviço), valem as do vínculo ativo do usuário com a empresa;
 * sem usuário, nenhuma (403): o BI nunca é lido sem alguém com permissão.
 */
const { sequelize } = require('../../../models');
const { assertDomainAccess } = require('../security');
const { membershipPermissions } = require('../metrics/consolidation/companyAccess');

const HEALTH = 'analytics.rm_finance_health';
const SECTOR_MARGIN = 'analytics.rm_finance_sector_margin';
const select = async (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: sequelize.QueryTypes.SELECT });

async function withPermissions(ctx, transaction) {
  if (ctx && (Array.isArray(ctx.permissions) || ctx.permissions instanceof Set)) return ctx;
  const permissions = ctx && ctx.userId && ctx.companyId ? await membershipPermissions(ctx.userId, ctx.companyId, transaction) : [];
  return { ...ctx, permissions };
}

async function assertFinanceRead(ctx, transaction) {
  const full = await withPermissions(ctx, transaction);
  await assertDomainAccess(full, 'FINANCE', transaction);
}

/** Linha mais recente do read model de saúde financeira com data-base até `asOfDate` (AAAA-MM-DD), ou null. */
async function readFinanceHealthForAssistant(ctx, asOfDate, transaction) {
  await assertFinanceRead(ctx, transaction);
  const rows = await select(
    `SELECT as_of_date::text AS as_of_date, source_snapshot_at, refreshed_at, version,
            free_cash::text AS free_cash, third_party_cash::text AS third_party_cash, total_cash::text AS total_cash,
            payables_7d::text AS payables_7d, payables_30d::text AS payables_30d, receivables_7d::text AS receivables_7d, receivables_30d::text AS receivables_30d,
            overdue_payables::text AS overdue_payables, overdue_amount::text AS overdue_amount,
            overdue_amount_in_window_90d::text AS overdue_in_window, receivables_base_90d::text AS receivables_base,
            pending_reconciliations, pending_reconciliations_amount::text AS pending_reconciliations_amount, last_statement_import_date::text AS last_statement_import_date,
            pending_owner_repasses::text AS pending_owner_repasses, provisioned_commissions::text AS provisioned_commissions,
            open_anomalies, open_anomalies_high, breathing_need::text AS breathing_need, overdue_receivables_detail
       FROM ${HEALTH}
      WHERE company_id = :companyId AND as_of_date <= :asOfDate::date
      ORDER BY as_of_date DESC LIMIT 1`,
    { companyId: ctx.companyId, asOfDate }, transaction);
  return rows[0] || null;
}

/** Receita e custo realizados por setor (centro de resultado) nos meses pedidos, com a data do retrato. */
async function readSectorMarginsForAssistant(ctx, months, transaction) {
  await assertFinanceRead(ctx, transaction);
  return select(
    `SELECT result_center_id::text AS result_center_id, competence_month, revenue_actual::text AS revenue, cost_actual::text AS cost, source_snapshot_at
       FROM ${SECTOR_MARGIN} WHERE company_id = :companyId AND competence_month IN (:months)`,
    { companyId: ctx.companyId, months }, transaction);
}

/** Nomes dos read models lidos, para o rastro da execução da NAY (quem chama não cita a tabela do BI). */
const FINANCE_ASSISTANT_READ_MODELS = Object.freeze({ health: HEALTH, sectorMargin: SECTOR_MARGIN });

module.exports = { readFinanceHealthForAssistant, readSectorMarginsForAssistant, FINANCE_ASSISTANT_READ_MODELS };
