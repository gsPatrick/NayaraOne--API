'use strict';

const logger = require('../../../../utils/logger');
const { sequelize } = require('../../../../models');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { publishGovernanceEvent } = require('../../governance.events');
const { notify } = require('../../calendar/alerts/alerts.log');
const { findCompanyUser } = require('../../governance.users');
const { THRESHOLDS, EVENT_THRESHOLD, AUDIT_ENTITY } = require('./budget.constants');
const { brl } = require('./budget.format');
const repo = require('./budget.repository');

function messageOf(budget, threshold, c) {
  return {
    title: `Orçamento de custos em ${threshold}%`,
    body: `O orçamento mensal de ${budget.environment}/${budget.domain} chegou a ${c.percent}% (limiar ${threshold}): consumo de ${brl(c.consumedCents)} sobre ${brl(budget.amount_cents)}. `
      + `Parcela estimada: ${brl(c.estimatedCents)}; parcela faturada: ${brl(c.billedCents)} (séries separadas, nunca somadas). `
      + `${threshold === 100 ? 'Aviso informativo: nada é desligado por este alerta.' : 'Acompanhe o gasto antes do fim do mês.'}`,
  };
}

/** Avisa o responsável; a falha do aviso NÃO desfaz o alerta nem o evento (savepoint) e vai ao log. */
async function notifyOwner(tenant, budget, threshold, c, transaction) {
  try {
    const owner = await findCompanyUser(budget.owner_user_id, tenant, transaction);
    if (!owner.active) { logger.warn({ budgetId: budget.id }, 'finops.budget.owner_inactive'); return; }
    await sequelize.transaction({ transaction }, (sp) => notify(tenant, [budget.owner_user_id], messageOf(budget, threshold, c), sp));
  } catch (err) {
    logger.warn({ budgetId: budget.id, err: err.message }, 'finops.budget.notify_failed');
  }
}

/**
 * Dispara, em ordem crescente, cada limiar atingido e ainda não disparado no mês (M9-D861 §3.3 e §3.4). O alerta (UNIQUE), o evento `finops.budget.threshold`
 * (chave `finops.budget.threshold:<orçamento>:<mês>:<limiar>`) e a auditoria saem na MESMA transação; o aviso ao responsável vem depois. Este módulo NÃO aciona
 * nenhuma política de degradação: o alerta 100 é informativo (a política de PROD é da M9-D863, que consome o evento).
 */
async function fireReached(tenant, budget, monthKey, c, transaction) {
  const periodStart = `${monthKey}-01`;
  const fired = [];
  for (const threshold of THRESHOLDS) {
    if (c.percent < threshold) break;
    const row = await repo.claimAlert(tenant, { budgetId: budget.id, periodStart, threshold, percent: c.percent, consumedCents: c.consumedCents, budgetCents: budget.amount_cents, series: c.baseSeries }, transaction);
    if (!row) continue;
    const payload = { budgetId: budget.id, environment: budget.environment, domain: budget.domain, threshold, percent: c.percent, consumedCents: c.consumedCents, budgetCents: Number(budget.amount_cents), periodStart, series: c.baseSeries, estimatedCents: c.estimatedCents, billedCents: c.billedCents };
    await publishGovernanceEvent({
      groupId: tenant.groupId, companyId: tenant.companyId, aggregateType: AUDIT_ENTITY, aggregateId: budget.id, eventType: EVENT_THRESHOLD, payload,
      idempotencyKey: `${EVENT_THRESHOLD}:${budget.id}:${periodStart}:${threshold}`,
    }, transaction);
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'governance.budget.threshold', entityType: AUDIT_ENTITY, entityId: budget.id,
      beforeJson: null, afterJson: payload, reason: `Orçamento de custos chegou a ${threshold}% em ${monthKey}.`,
    }, transaction);
    await notifyOwner(tenant, budget, threshold, c, transaction);
    fired.push(threshold);
  }
  return fired;
}

module.exports = { fireReached };
