'use strict';

const { ChartOfAccount, ChartOfAccountVersion } = require('../../../../models');
const AppError = require('../../../../utils/AppError');

// --- §4 Plano de contas versionado (Frente 3) ------------------------------------------------
//
// Cada criação/alteração/desativação de conta grava uma VERSÃO append-only em
// finance.chart_of_account_versions (trigger no banco: nunca apaga; só encerra a vigência da
// versão aberta). O lançamento grava a versão vigente na data do fato, então renomear,
// reclassificar ou desativar uma conta não reescreve a classificação de lançamentos passados.

function snapshotOf(account) {
  return {
    code: account.code,
    name: account.name,
    accountType: account.accountType,
    parentAccountId: account.parentAccountId || null,
    isActive: Boolean(account.isActive),
  };
}

async function recordAccountVersion(account, changeReason, actorUserId, transaction, effectiveFrom = new Date()) {
  const open = await ChartOfAccountVersion.findOne({
    where: { chartOfAccountId: account.id, effectiveUntil: null },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  const last = await ChartOfAccountVersion.findOne({
    where: { chartOfAccountId: account.id },
    order: [['versionNumber', 'DESC']],
    transaction,
  });
  if (open) {
    const snap = snapshotOf(account);
    const unchanged = Object.keys(snap).every((k) => String(open[k] ?? '') === String(snap[k] ?? ''));
    if (unchanged) return open;
    open.effectiveUntil = effectiveFrom;
    await open.save({ transaction });
  }
  return ChartOfAccountVersion.create(
    {
      groupId: account.groupId,
      companyId: account.companyId,
      chartOfAccountId: account.id,
      versionNumber: last ? last.versionNumber + 1 : 1,
      ...snapshotOf(account),
      changeReason: changeReason || null,
      effectiveFrom: open ? effectiveFrom : (last ? effectiveFrom : account.createdAt || effectiveFrom),
      effectiveUntil: null,
      createdBy: actorUserId || null,
    },
    { transaction }
  );
}

/**
 * resolveAccountVersionForEntry — versão da conta vigente em `factDate`. A conta precisa ser da
 * empresa e estar ATIVA naquela data. Fato anterior à primeira versão usa a primeira versão
 * (a conta nunca teve outra classificação). Conta sem nenhuma versão (criada fora do serviço)
 * recebe a v1 aqui mesmo, a partir do estado atual.
 */
async function resolveAccountVersionForEntry(chartOfAccountId, companyId, factDate, transaction) {
  if (!chartOfAccountId) return null;
  const account = await ChartOfAccount.findByPk(chartOfAccountId, { transaction });
  if (!account || (companyId && account.companyId !== companyId)) {
    throw AppError.badRequest('A conta contábil informada não existe no plano de contas desta empresa.', 'FINANCE_CHART_ACCOUNT_NOT_FOUND');
  }
  // Caderno M4 §4: "contas analíticas e sintéticas". Conta com filhas ativas é SINTÉTICA
  // (agrupadora): só consolida nos relatórios e não recebe lançamento direto — o lançamento vai
  // para a conta analítica (folha).
  const activeChildren = await ChartOfAccount.count({ where: { parentAccountId: account.id, isActive: true }, transaction });
  if (activeChildren > 0) {
    throw AppError.badRequest(
      `A conta "${account.code} — ${account.name}" é sintética (tem ${activeChildren} subconta(s)); lance na conta analítica.`,
      'FINANCE_CHART_ACCOUNT_SYNTHETIC'
    );
  }
  const at = factDate ? new Date(factDate) : new Date();
  if (Number.isNaN(at.getTime())) {
    throw AppError.badRequest('Data do fato inválida.', 'FINANCE_ENTRY_VALIDATION');
  }
  const { Op } = require('sequelize'); // eslint-disable-line global-require
  let version = await ChartOfAccountVersion.findOne({
    where: {
      chartOfAccountId,
      effectiveFrom: { [Op.lte]: at },
      [Op.or]: [{ effectiveUntil: null }, { effectiveUntil: { [Op.gt]: at } }],
    },
    order: [['versionNumber', 'DESC']],
    transaction,
  });
  if (!version) {
    version = await ChartOfAccountVersion.findOne({ where: { chartOfAccountId }, order: [['versionNumber', 'ASC']], transaction });
  }
  if (!version) {
    version = await recordAccountVersion(account, 'Versão inicial (conta sem histórico).', null, transaction);
  }
  if (!version.isActive) {
    throw AppError.conflict(
      `A conta contábil "${version.code} — ${version.name}" estava inativa na data do fato e não aceita lançamentos.`,
      'FINANCE_CHART_ACCOUNT_INACTIVE'
    );
  }
  return version;
}

module.exports = {
  recordAccountVersion,
  resolveAccountVersionForEntry,
};
