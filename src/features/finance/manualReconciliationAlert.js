'use strict';

/**
 * Caderno M4 §17 "Conciliação manual recorrente -> Alerta gerencial" (FIN-013). A contagem
 * (checkRecurringManualReconciliationAlert) existia mas nunca era chamada. Agora, a cada
 * conciliação MANUAL confirmada (par informado pela pessoa ou lançamento escolhido por ela na
 * confirmação), se a empresa atingiu o limiar dentro da janela e ainda não há caso do mesmo tipo
 * aberto na janela, abre um AnomalyCase RECURRING_MANUAL_RECONCILIATION (MEDIUM), visível em
 * GET /finance/anomaly-cases e no relatório semanal. Conciliação automática do motor e sugestão
 * confirmada sem escolha não contam. Um casamento em grupo (N:M, mesmo match_group_id) conta 1.
 * O livro não fixa limiar nem janela: são parâmetros do administrador (padrão 3 em 30 dias, os
 * valores que o contador já usava).
 */
const { Op } = require('sequelize');
const { AnomalyCase, sequelize } = require('../../models');

const MANUAL_METHODS = ['MANUAL', 'MANUAL_CHOICE'];
const CASE_TYPE = 'RECURRING_MANUAL_RECONCILIATION';
const DEFAULT_MIN_COUNT = 3;
const DEFAULT_WINDOW_DAYS = 30;

async function resolveParams(tenant, transaction) {
  const { getSetting } = require('../settings/settings.service');
  const minCount = Number(await getSetting('finance.antifraud_manual_reconciliation_min_count', tenant, transaction, DEFAULT_MIN_COUNT));
  const windowDays = Number(await getSetting('finance.antifraud_manual_reconciliation_window_days', tenant, transaction, DEFAULT_WINDOW_DAYS));
  return {
    minCount: Number.isFinite(minCount) && minCount >= 1 ? minCount : DEFAULT_MIN_COUNT,
    windowDays: Number.isFinite(windowDays) && windowDays >= 1 ? windowDays : DEFAULT_WINDOW_DAYS,
  };
}

async function countManualReconciliations(companyId, since, transaction) {
  const [row] = await sequelize.query(
    `SELECT COUNT(DISTINCT COALESCE(match_group_id, id))::int AS n
       FROM finance.reconciliations
      WHERE company_id = :companyId AND match_method IN (:methods) AND matched_at >= :since`,
    { replacements: { companyId, methods: MANUAL_METHODS, since }, type: sequelize.QueryTypes.SELECT, transaction }
  );
  return row.n;
}

/**
 * checkAfterManualReconciliation — chamada depois de gravar uma conciliação manual. Devolve
 * { flagged, count, windowDays, minCount, anomalyCase? }. Nunca bloqueia a conciliação.
 */
async function checkAfterManualReconciliation({ groupId, companyId, matchMethod }, actorUserId, transaction) {
  if (!MANUAL_METHODS.includes(matchMethod)) return { flagged: false, skipped: 'not_manual' };
  const { minCount, windowDays } = await resolveParams({ groupId, companyId }, transaction);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const count = await countManualReconciliations(companyId, since, transaction);
  if (count < minCount) return { flagged: false, count, windowDays, minCount };
  const existing = await AnomalyCase.findOne({ where: { companyId, caseType: CASE_TYPE, status: 'OPEN', created_at: { [Op.gte]: since } }, transaction });
  if (existing) return { flagged: false, count, windowDays, minCount, existingCaseId: existing.id };
  const { createAnomalyCase } = require('./anomalyCases.service');
  const anomalyCase = await createAnomalyCase(
    {
      groupId,
      companyId,
      caseType: CASE_TYPE,
      riskLevel: 'MEDIUM',
      relatedEntityType: null,
      relatedEntityId: null,
      reason: `Conciliação manual recorrente: ${count} conciliações feitas à mão nos últimos ${windowDays} dias (limiar ${minCount}). Vale revisar a qualidade dos dados do extrato e dos lançamentos, que o motor de sugestão não está casando sozinho.`,
    },
    actorUserId,
    transaction
  );
  return { flagged: true, count, windowDays, minCount, anomalyCase };
}

module.exports = { checkAfterManualReconciliation, MANUAL_METHODS, CASE_TYPE };
