'use strict';

const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const campaignRepo = require('./campaigns.repository');
const { readCampaignCostCents } = require('./cost.reader');
const { readFinanceSourceActive, readRecalcHours } = require('./cost.settings');

const ENTITY = 'marketing.campaign';
const HOUR_MS = 3600000;
let reader = readCampaignCostCents;

/** Troca a leitura do Financeiro (testes simulam a fonte fora do ar); sem argumento volta à leitura real. */
function setCostReaderForTests(fn) { reader = fn || readCampaignCostCents; }

const staleWarning = (row) => ({
  code: 'MKT_COST_SOURCE_STALE', message: 'Custo não atualizado desde a última consulta.', lastUpdatedAt: row.cost_updated_at ? new Date(row.cost_updated_at).toISOString() : null,
});

/** Avisos da resposta da campanha: fonte do custo indisponível na última tentativa. */
const costWarnings = (row) => (row.cost_stale ? [staleWarning(row)] : []);

/**
 * Recalcula o custo real da campanha a partir do Financeiro (regras 1 a 5). Trava a campanha (FOR UPDATE), lê numa transação
 * aninhada (a falha da fonte não derruba a transação do chamador), grava cost_actual, cost_updated_at e cost_stale. Determinístico:
 * recalcular sem mudança no Financeiro dá o mesmo valor. Fonte indisponível: cost_actual fica como estava, cost_stale = true.
 * Empresa sem o Financeiro (parâmetro desligado): nada muda, cost_actual segue 0 e o orçamento é o único custo.
 */
async function recalculateCampaignCost(campaignId, tenant, transaction, { now = new Date(), actor = null } = {}) {
  const row = await campaignRepo.findById(campaignId, tenant, transaction, { lock: true });
  if (!row) return { found: false };
  if (!(await readFinanceSourceActive(tenant, transaction))) return { found: true, skipped: true, costActual: Number(row.cost_actual) };
  let cents;
  try {
    cents = await sequelize.transaction({ transaction }, (inner) => reader(row, tenant, inner));
  } catch (err) {
    logger.error({ campaignId, err: err.message }, 'marketing.campaign.cost.source_failed');
    const stale = await campaignRepo.update(campaignId, { costStale: true }, actor, transaction);
    return { found: true, stale: true, costActual: Number(stale.cost_actual), warning: staleWarning(stale) };
  }
  const costActual = cents / 100;
  const updated = await campaignRepo.update(campaignId, { costActual, costUpdatedAt: now, costStale: false }, actor, transaction);
  if (Number(row.cost_actual) !== costActual || row.cost_stale) {
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor, action: 'marketing.campaign.cost_recalculated', entityType: ENTITY, entityId: campaignId,
      beforeJson: { costActual: Number(row.cost_actual), costStale: row.cost_stale }, afterJson: { costActual, costStale: false },
      reason: `Custo real da campanha ${row.code} recalculado a partir do Financeiro.`,
    }, transaction);
  }
  return { found: true, stale: false, costActual: Number(updated.cost_actual) };
}

/** Job diário: campanhas RUNNING cujo custo nunca foi calculado ou tem mais de `intervalo_recalculo_horas`. Cada uma em savepoint. */
async function recalculateDueCosts(tenant, transaction, now = new Date()) {
  const hours = await readRecalcHours(tenant, transaction);
  const due = await campaignRepo.run(
    `SELECT id FROM marketing.campaigns WHERE company_id = :companyId AND status = 'RUNNING' AND deleted_at IS NULL
        AND (cost_updated_at IS NULL OR cost_updated_at <= :limit OR cost_stale) ORDER BY id`,
    { companyId: tenant.companyId, limit: new Date(now.getTime() - hours * HOUR_MS) }, transaction
  );
  const out = { recalculated: [], stale: [], failed: [] };
  for (const { id } of due) {
    try {
      const res = await sequelize.transaction({ transaction }, (inner) => recalculateCampaignCost(id, tenant, inner, { now }));
      (res.stale ? out.stale : out.recalculated).push(id);
    } catch (err) {
      out.failed.push(id);
      logger.error({ campaignId: id, err: err.message }, 'marketing.campaign.cost.recalc_failed');
    }
  }
  return out;
}

module.exports = { recalculateCampaignCost, recalculateDueCosts, costWarnings, setCostReaderForTests };
