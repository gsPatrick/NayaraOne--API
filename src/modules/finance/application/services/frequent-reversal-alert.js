'use strict';

/**
 * Caderno M4 §17 "Estorno frequente -> Anomaly case", com os números da DEC-007 ("estorno frequente 3 por usuário e 5 por empresa em 30 dias"):
 *   - por usuário: estornos (lançamentos compensatórios, totais ou parciais) feitos pela mesma pessoa nos últimos 30 dias, a partir de
 *     antifraude.estorno_frequente_usuario_30d (3);
 *   - por empresa: estornos da empresa nos últimos 30 dias, a partir de antifraude.estorno_frequente_empresa_30d (padrão 5, DEC-007 e M4-D006 item 9;
 *     DI-DEC007-2). A empresa que gravou outro valor na tela (ex.: 3) continua com o valor gravado.
 * O caso aberto (receipt.service.js) é FREQUENT_REVERSAL MEDIUM (M4-D006 item 9).
 * A janela de 30 dias faz parte do nome das chaves (_30d). A contagem da empresa é a maior entre lançamentos estornados (status REVERSED) e lançamentos
 * compensatórios criados na janela (o estorno parcial não muda o status do original e mesmo assim conta). Só sinaliza: nunca bloqueia o estorno.
 */
const { Op } = require('sequelize');
const { FinancialEntry } = require('../../../../models');
const { KEYS, readFinanceNumber } = require('./finance-settings');

const WINDOW_DAYS = 30;

async function countCompany(companyId, since, transaction) {
  // NOTA: os atributos de timestamp deste model estão registrados como 'created_at'/'updated_at' (snake_case literal) — ver FinancialEntry.js.
  const [reversed, compensating] = await Promise.all([
    FinancialEntry.count({ where: { companyId, status: 'REVERSED', updated_at: { [Op.gte]: since } }, transaction }),
    FinancialEntry.count({ where: { companyId, reversalOfEntryId: { [Op.ne]: null }, created_at: { [Op.gte]: since } }, transaction }),
  ]);
  return Math.max(reversed, compensating);
}

async function countUser(companyId, userId, since, transaction) {
  if (!userId) return 0;
  return FinancialEntry.count({ where: { companyId, reversalOfEntryId: { [Op.ne]: null }, createdBy: userId, created_at: { [Op.gte]: since } }, transaction });
}

/**
 * checkFrequentReversalAlert — `flagged: true` quando a empresa ou o usuário (se informado) atingiu o limiar. Devolve as contagens, os limiares e o
 * motivo em texto (para o caso). Só leitura.
 */
async function checkFrequentReversalAlert(companyId, transaction, actorUserId = null) {
  const tenant = { companyId };
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [companyMin, userMin, count, userCount] = await Promise.all([
    readFinanceNumber(KEYS.frequentReversalCompany30d, tenant, transaction),
    readFinanceNumber(KEYS.frequentReversalUser30d, tenant, transaction),
    countCompany(companyId, since, transaction),
    countUser(companyId, actorUserId, since, transaction),
  ]);
  const companyFlagged = count >= companyMin;
  const userFlagged = Boolean(actorUserId) && userCount >= userMin;
  const reasons = [
    companyFlagged ? `${count} estornos na empresa nos últimos ${WINDOW_DAYS} dias (limiar ${companyMin})` : null,
    userFlagged ? `${userCount} estornos feitos pela mesma pessoa (usuário ${actorUserId}) nos últimos ${WINDOW_DAYS} dias (limiar ${userMin})` : null,
  ].filter(Boolean);
  return {
    count, userCount, windowDays: WINDOW_DAYS, companyMin, userMin, companyFlagged, userFlagged,
    flagged: companyFlagged || userFlagged,
    reason: reasons.length ? `Estorno frequente: ${reasons.join('; ')}.` : null,
  };
}

module.exports = { checkFrequentReversalAlert, WINDOW_DAYS };
