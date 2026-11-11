'use strict';

/**
 * Caderno M4 §17 "Conciliação manual recorrente -> Alerta gerencial" (FIN-013). A cada conciliação MANUAL confirmada (par informado pela pessoa ou
 * lançamento escolhido por ela na confirmação) confere três gatilhos e abre um AnomalyCase RECURRING_MANUAL_RECONCILIATION (MEDIUM), visível em
 * GET /finance/anomaly-cases e no relatório semanal. Conciliação automática do motor e sugestão confirmada sem escolha não contam; um casamento em grupo
 * (N:M, mesmo match_group_id) conta 1. Nunca bloqueia a conciliação.
 *   1. DEC-007, por usuário: a mesma pessoa com antifraude.conciliacao_manual_usuario_7d (5) conciliações manuais em 7 dias. Caso ligado à pessoa
 *      (relatedEntityType 'User'); um aberto por pessoa a cada 7 dias.
 *   2. DEC-007, percentual do mês: a empresa com mais de antifraude.conciliacao_manual_percentual_mes (30%) das conciliações do mês (São Paulo) feitas à
 *      mão ("maior que", M4-D022 item 7; em 100 o gatilho não dispara). Um caso da empresa aberto por mês.
 *   3. Regra que já existia, por empresa: finance.antifraud_manual_reconciliation_min_count (3) em finance.antifraud_manual_reconciliation_window_days
 *      (30). Mantida além das da decisão porque tirá-la afrouxaria o alerta (falha segura, DI-DEC007-1). Um caso da empresa aberto por janela.
 * A janela de 7 dias faz parte do nome da chave (_7d).
 */
const { Op } = require('sequelize');
const { AnomalyCase, sequelize } = require('../../models');
const { KEYS, readFinanceNumber } = require('./finance.settings');

const MANUAL_METHODS = ['MANUAL', 'MANUAL_CHOICE'];
const CASE_TYPE = 'RECURRING_MANUAL_RECONCILIATION';
const USER_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

async function resolveParams(tenant, transaction) {
  const [minCount, windowDays, userMin, monthPct] = await Promise.all([
    readFinanceNumber(KEYS.manualReconciliationMinCount, tenant, transaction),
    readFinanceNumber(KEYS.manualReconciliationWindowDays, tenant, transaction),
    readFinanceNumber(KEYS.manualReconciliationUser7d, tenant, transaction),
    readFinanceNumber(KEYS.manualReconciliationMonthPct, tenant, transaction),
  ]);
  return { minCount, windowDays, userMin, monthPct };
}

const groups = 'COUNT(DISTINCT COALESCE(match_group_id, id))';
const one = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT, transaction }))[0];

async function countManual(companyId, since, transaction, userId = null) {
  const row = await one(
    `SELECT ${groups}::int AS n FROM finance.reconciliations
      WHERE company_id = :companyId AND match_method IN (:methods) AND matched_at >= :since ${userId ? 'AND matched_by_user_id = :userId' : ''}`,
    { companyId, methods: MANUAL_METHODS, since, userId }, transaction
  );
  return row.n;
}

async function monthShare(companyId, transaction) {
  const row = await one(
    `SELECT (${groups} FILTER (WHERE match_method IN (:methods)))::int AS manual, ${groups}::int AS total, date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo' AS since
       FROM finance.reconciliations
      WHERE company_id = :companyId AND matched_at >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`,
    { companyId, methods: MANUAL_METHODS }, transaction
  );
  return { manual: row.manual, total: row.total, pct: row.total > 0 ? (row.manual * 100) / row.total : 0, since: new Date(row.since) };
}

const openCase = (where, since, transaction) => AnomalyCase.findOne({ where: { ...where, caseType: CASE_TYPE, status: 'OPEN', created_at: { [Op.gte]: since } }, transaction });

async function open({ groupId, companyId, relatedEntityType = null, relatedEntityId = null, reason }, actorUserId, transaction) {
  const { createAnomalyCase } = require('./anomalyCases.service');
  return createAnomalyCase({ groupId, companyId, caseType: CASE_TYPE, riskLevel: 'MEDIUM', relatedEntityType, relatedEntityId, reason }, actorUserId, transaction);
}

const QUALITY_HINT = 'Vale revisar a qualidade dos dados do extrato e dos lançamentos, que o motor de sugestão não está casando sozinho.';

async function userTrigger(ctx, p, actorUserId, transaction) {
  if (!actorUserId) return null;
  const since = new Date(Date.now() - USER_WINDOW_DAYS * DAY_MS);
  const count = await countManual(ctx.companyId, since, transaction, actorUserId);
  if (count < p.userMin) return null;
  if (await openCase({ companyId: ctx.companyId, relatedEntityType: 'User', relatedEntityId: actorUserId }, since, transaction)) return null;
  return open({ ...ctx, relatedEntityType: 'User', relatedEntityId: actorUserId, reason: `Conciliação manual recorrente: ${count} conciliações feitas à mão pela mesma pessoa nos últimos ${USER_WINDOW_DAYS} dias (limiar ${p.userMin}). ${QUALITY_HINT}` }, actorUserId, transaction);
}

async function companyTrigger(ctx, p, count, windowSince, actorUserId, transaction) {
  if (count >= p.minCount && !(await openCase({ companyId: ctx.companyId, relatedEntityType: null }, windowSince, transaction))) {
    return open({ ...ctx, reason: `Conciliação manual recorrente: ${count} conciliações feitas à mão nos últimos ${p.windowDays} dias (limiar ${p.minCount}). ${QUALITY_HINT}` }, actorUserId, transaction);
  }
  const share = await monthShare(ctx.companyId, transaction);
  if (share.total > 0 && share.pct > p.monthPct && !(await openCase({ companyId: ctx.companyId, relatedEntityType: null }, share.since, transaction))) {
    return open({ ...ctx, reason: `Conciliação manual recorrente: ${share.manual} de ${share.total} conciliações deste mês feitas à mão (${share.pct.toFixed(1)}%, limiar ${p.monthPct}%). ${QUALITY_HINT}` }, actorUserId, transaction);
  }
  return null;
}

/**
 * checkAfterManualReconciliation — chamada depois de gravar uma conciliação manual. Devolve
 * { flagged, count, windowDays, minCount, userMin, monthPct, anomalyCase?, userCase? }. Nunca bloqueia a conciliação.
 */
async function checkAfterManualReconciliation({ groupId, companyId, matchMethod }, actorUserId, transaction) {
  if (!MANUAL_METHODS.includes(matchMethod)) return { flagged: false, skipped: 'not_manual' };
  const ctx = { groupId, companyId };
  const p = await resolveParams(ctx, transaction);
  const windowSince = new Date(Date.now() - p.windowDays * DAY_MS);
  const count = await countManual(companyId, windowSince, transaction);
  const userCase = await userTrigger(ctx, p, actorUserId, transaction);
  const anomalyCase = await companyTrigger(ctx, p, count, windowSince, actorUserId, transaction);
  return { flagged: Boolean(anomalyCase || userCase), count, ...p, ...(anomalyCase ? { anomalyCase } : {}), ...(userCase ? { userCase } : {}) };
}

/** Contagem de leitura (sem abrir caso) da regra por empresa, usada pelo relatório/contrato antigo. */
async function readManualReconciliationAlert(companyId, transaction) {
  const p = await resolveParams({ companyId }, transaction);
  const count = await countManual(companyId, new Date(Date.now() - p.windowDays * DAY_MS), transaction);
  const share = await monthShare(companyId, transaction);
  return { count, windowDays: p.windowDays, minCount: p.minCount, monthPct: p.monthPct, monthManualPct: share.pct, flagged: count >= p.minCount || (share.total > 0 && share.pct > p.monthPct) };
}

module.exports = { checkAfterManualReconciliation, readManualReconciliationAlert, MANUAL_METHODS, CASE_TYPE, USER_WINDOW_DAYS };
