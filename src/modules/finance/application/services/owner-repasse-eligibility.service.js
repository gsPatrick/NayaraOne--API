'use strict';

const { Op } = require('sequelize');
const { OwnerRepass, FinancialEntry, AuditLog, Contract } = require('../../../../models');
const AppError = require('../../../../utils/AppError');

// Elegibilidade dos recebimentos que compõem um repasse ao proprietário (§12): saldo já
// alocado, escopo, lista de elegíveis e composição lida do rastro de auditoria.

// GAP REAL CORRIGIDO (auditoria externa Nayara, 15/10/2026, Seção 4 "Marco 4 — Financeiro",
// grupo "Repasses e composição §12": "dois repasses não reutilizam o mesmo saldo"): o teto
// elegível era recalculado do zero a cada chamada a partir do `amount` do lançamento-fonte,
// sem nunca checar quanto desse mesmo lançamento já tinha sido usado por um repasse ANTERIOR.
// Dois repasses distintos apontando para o mesmo `sourceEntryIds` passavam os dois, cada um
// usando o valor cheio do recebimento como teto — dinheiro sendo "repassado" duas vezes a
// partir do mesmo recebimento real. `getAlreadyAllocatedAmount` soma, por lançamento-fonte,
// quanto já foi alocado por repasses anteriores NÃO cancelados (lidos do mesmo rastro de
// auditoria append-only usado por `getOwnerRepasseComposition` — não há tabela de junção
// dedicada nesta rodada, ver nota de modelagem em owner-repasses.service.js) e deduz esse valor do teto disponível.
async function getAlreadyAllocatedAmount(entryId, transaction) {
  const logs = await AuditLog.findAll({
    where: { action: 'finance.owner_repasse.create', entityType: 'OwnerRepass' },
    transaction,
  });
  let allocatedCents = 0;
  for (const log of logs) {
    const afterJson = log.afterJson || {};
    const composition = Array.isArray(afterJson.composition) ? afterJson.composition : [];
    const match = composition.find((item) => item.financialEntryId === entryId);
    if (!match) continue;
    const repasse = await OwnerRepass.findByPk(log.entityId, { transaction });
    if (!repasse || repasse.status === 'CANCELLED') continue; // repasse cancelado libera o saldo de volta.
    allocatedCents += Math.round(Number(match.eligibleAmount || 0) * 100);
  }
  return allocatedCents / 100;
}

// Regra ÚNICA de elegibilidade de um recebimento como fonte de repasse — usada tanto na
// validação da criação (assertEligibleSources) quanto na lista de elegíveis da tela
// (listEligibleRepasseSources). Devolve null quando elegível.
function sourceIneligibility(entry) {
  if (entry.nature !== 'RECEIVABLE') {
    return {
      code: 'FINANCE_OWNER_REPASSE_SOURCE_NOT_RECEIVABLE',
      message: `O lançamento ${entry.id} não é um recebimento (nature=${entry.nature}) — não pode compor o valor elegível do repasse.`,
    };
  }
  if (!['SETTLED', 'PARTIALLY_SETTLED'].includes(entry.status)) {
    return {
      code: 'FINANCE_OWNER_REPASSE_SOURCE_NOT_RECEIVED',
      message: `O lançamento ${entry.id} ainda não foi recebido (status=${entry.status}) — só recebimento REAL pode compor o teto elegível.`,
    };
  }
  if (entry.isThirdPartyFunds) {
    return {
      code: 'FINANCE_OWNER_REPASSE_SOURCE_THIRD_PARTY',
      message: `O lançamento ${entry.id} é dinheiro de terceiro (caução) — não compõe o valor elegível de repasse próprio (FIN-006).`,
    };
  }
  return null;
}

// M45 F4: escopo — recebimento vinculado a contrato só compõe repasse daquele contrato (se o
// repasse tem contrato) ou de contrato do MESMO imóvel (se o repasse é só do imóvel). Recebimento
// sem contrato (lançamento avulso) não tem como ser ligado a um imóvel: continua aceito pela API
// (compatibilidade), mas não é sugerido na lista de elegíveis.
async function assertSourcesInScope(entries, { propertyId, contractId }, transaction) {
  const contractIds = [...new Set(entries.map((e) => e.contractId).filter(Boolean))];
  if (contractIds.length === 0) return;
  const contracts = await Contract.findAll({ where: { id: contractIds }, attributes: ['id', 'propertyId'], transaction });
  const propertyByContract = new Map(contracts.map((c) => [c.id, c.propertyId]));
  for (const entry of entries) {
    if (!entry.contractId) continue;
    const ok = contractId
      ? String(entry.contractId) === String(contractId)
      : String(propertyByContract.get(entry.contractId) || '') === String(propertyId);
    if (!ok) {
      throw AppError.conflict(
        `O recebimento "${entry.description || entry.id}" é de outro ${contractId ? 'contrato' : 'imóvel'} — não pode compor este repasse.`,
        'FINANCE_OWNER_REPASSE_SOURCE_OUT_OF_SCOPE',
        { financialEntryId: entry.id }
      );
    }
  }
}

async function allocatedAmountsByEntry(transaction) {
  const logs = await AuditLog.findAll({ where: { action: 'finance.owner_repasse.create', entityType: 'OwnerRepass' }, transaction });
  const repasseIds = [...new Set(logs.map((l) => l.entityId))];
  const live = repasseIds.length
    ? new Set((await OwnerRepass.findAll({ where: { id: repasseIds, status: { [Op.ne]: 'CANCELLED' } }, attributes: ['id'], transaction })).map((r) => r.id))
    : new Set();
  const cents = new Map();
  for (const log of logs) {
    if (!live.has(log.entityId)) continue;
    for (const item of (log.afterJson && Array.isArray(log.afterJson.composition) ? log.afterJson.composition : [])) {
      cents.set(item.financialEntryId, (cents.get(item.financialEntryId) || 0) + Math.round(Number(item.eligibleAmount || 0) * 100));
    }
  }
  return cents;
}

/**
 * listEligibleRepasseSources — recebimentos que podem compor um repasse do imóvel/contrato/período
 * escolhidos: mesma regra de sourceIneligibility + escopo (contrato do imóvel, ou o contrato
 * escolhido) + competência até o período do repasse + saldo ainda não alocado > 0.
 */
async function listEligibleRepasseSources(transaction, filters = {}) {
  const { propertyId, contractId, referenceMonth } = filters;
  if (!propertyId) {
    throw AppError.badRequest('Escolha o imóvel para listar os recebimentos elegíveis ao repasse.', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }
  if (referenceMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(referenceMonth))) {
    throw AppError.badRequest('O período deve estar no formato AAAA-MM.', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }
  let contractIds;
  if (contractId) {
    const c = await Contract.findOne({ where: { id: contractId, propertyId }, attributes: ['id'], transaction });
    contractIds = c ? [c.id] : [];
  } else {
    contractIds = (await Contract.findAll({ where: { propertyId }, attributes: ['id'], transaction })).map((c) => c.id);
  }
  if (contractIds.length === 0) return [];
  const where = { contractId: contractIds, nature: 'RECEIVABLE', status: ['SETTLED', 'PARTIALLY_SETTLED'], isThirdPartyFunds: false };
  if (referenceMonth) where.competenceMonth = { [Op.lte]: referenceMonth };
  const entries = await FinancialEntry.findAll({ where, order: [['settledAt', 'DESC'], ['created_at', 'DESC']], transaction });
  const allocated = await allocatedAmountsByEntry(transaction);
  const out = [];
  for (const entry of entries) {
    if (sourceIneligibility(entry)) continue;
    const availableCents = Math.max(0, Math.round(eligibleAmountOf(entry) * 100) - (allocated.get(entry.id) || 0));
    if (availableCents <= 0) continue;
    out.push({
      id: entry.id,
      description: entry.description,
      contractId: entry.contractId,
      competenceMonth: entry.competenceMonth,
      settledAt: entry.settledAt,
      amount: Number(entry.amount),
      alreadyAllocatedAmount: (allocated.get(entry.id) || 0) / 100,
      availableAmount: availableCents / 100,
    });
  }
  return out;
}

async function assertEligibleSources(companyId, sourceEntryIds, transaction) {
  if (!Array.isArray(sourceEntryIds) || sourceEntryIds.length === 0) {
    throw AppError.badRequest(
      'Escolha ao menos um recebimento: o repasse precisa estar ligado a recebimento(s) reais.',
      'FINANCE_OWNER_REPASSE_VALIDATION'
    );
  }
  const uniqueIds = [...new Set(sourceEntryIds)];
  // FOR UPDATE (Frente 3, §12): dois repasses concorrentes sobre o mesmo recebimento ficam em
  // fila — o segundo só lê o saldo já alocado depois que o primeiro terminar (sem repasse duplo).
  const entries = await FinancialEntry.findAll({
    where: { id: uniqueIds, companyId },
    order: [['id', 'ASC']],
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (entries.length !== uniqueIds.length) {
    throw AppError.notFound(
      'Um ou mais recebimentos escolhidos não foram encontrados nesta empresa.',
      'FINANCE_OWNER_REPASSE_SOURCE_NOT_FOUND'
    );
  }
  for (const entry of entries) {
    const problem = sourceIneligibility(entry);
    if (problem) throw AppError.conflict(problem.message, problem.code);
  }
  return entries;
}

function eligibleAmountOf(entry) {
  // Recebimento SETTLED: todo o amount é elegível. PARTIALLY_SETTLED: só a parte já realmente
  // recebida (soma das baixas filhas SETTLED) entra no teto — nunca o saldo ainda não recebido.
  if (entry.status === 'SETTLED') return Number(entry.amount);
  return 0; // PARTIALLY_SETTLED tratado via computeRemainingAmount pelo chamador quando necessário.
}

/**
 * getOwnerRepasseComposition — devolve a composição (lançamentos-fonte + valor elegível de
 * cada) registrada no momento da criação do repasse, lendo o rastro de auditoria append-only
 * (ver nota de modelagem em owner-repasses.service.js). "Extrato do proprietário mostra composição, não apenas valor
 * líquido." — esta função é o que alimenta essa visão.
 */
async function getOwnerRepasseComposition(ownerRepasseId, transaction) {
  const log = await AuditLog.findOne({
    where: { action: 'finance.owner_repasse.create', entityType: 'OwnerRepass', entityId: ownerRepasseId },
    order: [['created_at', 'ASC']],
    transaction,
  });
  if (!log) throw AppError.notFound('Nenhum registro de criação encontrado para este repasse.', 'FINANCE_OWNER_REPASSE_NOT_FOUND');
  const afterJson = log.afterJson || {};
  return {
    ownerRepasseId,
    eligibleAmount: afterJson.eligibleAmount || null,
    composition: afterJson.composition || [],
    formalAdjustment: afterJson.formalAdjustment || null,
  };
}

module.exports = {
  getAlreadyAllocatedAmount,
  assertSourcesInScope,
  listEligibleRepasseSources,
  assertEligibleSources,
  eligibleAmountOf,
  getOwnerRepasseComposition,
};
