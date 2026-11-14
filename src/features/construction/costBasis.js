'use strict';

const { Op } = require('sequelize');
const { FinancialEntry, ProjectStage, StageMeasurement } = require('../../models');
const { getSetting } = require('../settings/settings.service');

/**
 * Base do custo financeiro realizado das obras (lacuna do Caderno — Construção + Obras + Pós-obra §5 pede
 * actual_financial_cost mas não diz se é regime de CAIXA ou de COMPETÊNCIA). Regra do Patrick: o que o livro
 * não resolve vira parâmetro da empresa, com o comportamento atual como padrão.
 *
 *   CAIXA (padrão): custo realizado = lançamentos PAYABLE da obra já pagos (SETTLED inteiro; PARTIALLY_SETTLED só
 *     as baixas parciais liquidadas).
 *   COMPETENCIA: soma também as obrigações da obra já reconhecidas e ainda em aberto — PAYABLE PENDING inteiro e o
 *     saldo em aberto do PARTIALLY_SETTLED. Inclui a conta a pagar das medições APROVADAS (StageMeasurement
 *     PAYABLE) e as de desconto/ressarcimento de garantia aprovadas; REVERSED/CANCELLED não entram. A parte já
 *     paga continua vindo do CAIXA, então nada é somado duas vezes.
 *
 * Vale no read model de custo (GET .../health), na margem projetada, nos bloqueios de margem (approveBudget e
 * decideChangeOrder usam a mesma computeMarginProjection) e no painel agregado de Obras.
 */
const KEY = 'construction.custo_realizado.base';
const BASES = ['CAIXA', 'COMPETENCIA'];
const DEFAULT_BASE = 'CAIXA';

const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

async function getCostBasis(tenant, transaction) {
  const value = await getSetting(KEY, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction, DEFAULT_BASE);
  return BASES.includes(value) ? value : DEFAULT_BASE;
}

async function settledChildrenByParent(parentIds, transaction) {
  const paid = new Map();
  if (!parentIds.length) return paid;
  const children = await FinancialEntry.findAll({ where: { parentEntryId: { [Op.in]: parentIds }, status: 'SETTLED' }, attributes: ['parentEntryId', 'amount'], transaction });
  for (const ch of children) paid.set(ch.parentEntryId, (paid.get(ch.parentEntryId) || 0) + toNumber(ch.amount));
  return paid;
}

/** Custo financeiro PAGO por obra (mesma regra do drill-down de projectHealth#computeMarginProjection). */
async function paidFinancialCostByProject(projectIds, transaction) {
  const ids = [...new Set((projectIds || []).filter(Boolean))];
  const result = new Map(ids.map((id) => [id, 0]));
  if (!ids.length) return result;
  const entries = await FinancialEntry.findAll({
    // Só a obrigação (parentEntryId nulo): a baixa parcial filha também carrega a obra (M6-97) e entra pelo pai abaixo.
    where: { constructionProjectId: { [Op.in]: ids }, nature: 'PAYABLE', parentEntryId: null, status: { [Op.in]: ['SETTLED', 'PARTIALLY_SETTLED'] } },
    attributes: ['id', 'constructionProjectId', 'amount', 'status'],
    transaction,
  });
  const partial = entries.filter((e) => e.status === 'PARTIALLY_SETTLED');
  const paidChildren = await settledChildrenByParent(partial.map((e) => e.id), transaction);
  for (const e of entries) {
    const v = e.status === 'SETTLED' ? toNumber(e.amount) : paidChildren.get(e.id) || 0;
    result.set(e.constructionProjectId, round2(result.get(e.constructionProjectId) + v));
  }
  return result;
}

/** Obrigações da obra reconhecidas e ainda em aberto: { total, fromMeasurements } por obra. */
async function openPayablesByProject(projectIds, transaction) {
  const ids = [...new Set((projectIds || []).filter(Boolean))];
  const result = new Map(ids.map((id) => [id, { total: 0, fromMeasurements: 0 }]));
  if (!ids.length) return result;
  const entries = await FinancialEntry.findAll({
    where: { constructionProjectId: { [Op.in]: ids }, nature: 'PAYABLE', parentEntryId: null, status: { [Op.in]: ['PENDING', 'PARTIALLY_SETTLED'] } },
    attributes: ['id', 'constructionProjectId', 'amount', 'status'],
    transaction,
  });
  if (!entries.length) return result;
  const paidChildren = await settledChildrenByParent(entries.filter((e) => e.status === 'PARTIALLY_SETTLED').map((e) => e.id), transaction);
  const stages = await ProjectStage.findAll({ where: { projectId: { [Op.in]: ids } }, attributes: ['id'], transaction });
  const measurementEntryIds = stages.length
    ? new Set((await StageMeasurement.findAll({
      where: { projectStageId: { [Op.in]: stages.map((s) => s.id) }, status: 'PAYABLE', payableFinancialEntryId: { [Op.in]: entries.map((e) => e.id) } },
      attributes: ['payableFinancialEntryId'],
      transaction,
    })).map((m) => m.payableFinancialEntryId))
    : new Set();
  for (const e of entries) {
    const open = Math.max(toNumber(e.amount) - (paidChildren.get(e.id) || 0), 0);
    const acc = result.get(e.constructionProjectId);
    acc.total = round2(acc.total + open);
    if (measurementEntryIds.has(e.id)) acc.fromMeasurements = round2(acc.fromMeasurements + open);
  }
  return result;
}

/**
 * Quanto somar ao custo pago, conforme a base da empresa: { base, open (Map, sempre calculado, para transparência),
 * accrual (Map: 0 em CAIXA; total em aberto em COMPETENCIA) }.
 */
async function accrualByProject(projectIds, tenant, transaction) {
  const base = await getCostBasis(tenant, transaction);
  const open = await openPayablesByProject(projectIds, transaction);
  const accrual = new Map([...open].map(([k, v]) => [k, base === 'COMPETENCIA' ? v.total : 0]));
  return { base, open, accrual };
}

module.exports = { KEY, BASES, DEFAULT_BASE, getCostBasis, paidFinancialCostByProject, openPayablesByProject, accrualByProject };
