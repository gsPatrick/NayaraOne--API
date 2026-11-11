'use strict';

const { FinancialEntry } = require('../../models');
const { REQUIRED } = require('./guaranteeTypeData');

/**
 * Fechamento M5 (Caderno §9 SECURITY_DEPOSIT "Valor de terceiro, vínculo financeiro, devolução/compensação"; JUR-TS-015):
 * a leitura da garantia mostra o que ainda falta para ativá-la e, na caução, a trilha do Financeiro — recebimento,
 * devoluções/compensações e saldo, calculados pelo próprio Financeiro (o jurídico não guarda saldo).
 */
async function depositTrail(guarantee, transaction) {
  if (guarantee.guaranteeType !== 'SECURITY_DEPOSIT' || !guarantee.financeEntryId) return null;
  const { computeThirdPartyOriginBalance } = require('../finance/financialEntries.service');
  const origin = await FinancialEntry.findByPk(guarantee.financeEntryId, { transaction });
  if (!origin) return null;
  const balance = await computeThirdPartyOriginBalance(origin, transaction);
  const movements = await FinancialEntry.findAll({ where: { thirdPartyOriginEntryId: origin.id }, order: [['created_at', 'ASC']], transaction });
  return {
    originEntryId: origin.id,
    originStatus: origin.status,
    ...balance,
    movements: movements.map((m) => ({ entryId: m.id, nature: m.nature, amount: m.amount, status: m.status, description: m.description, createdAt: m.created_at || m.createdAt })),
  };
}

async function getGuaranteeDetail(guaranteesService, id, transaction) {
  const guarantee = await guaranteesService.getGuarantee(id, transaction);
  const data = guarantee.toJSON();
  const missing = (REQUIRED[guarantee.guaranteeType] || []).filter((k) => data[k] === undefined || data[k] === null || data[k] === '' || (Array.isArray(data[k]) && data[k].length === 0));
  return { ...data, missingForActivation: missing, depositTrail: await depositTrail(guarantee, transaction) };
}

module.exports = { getGuaranteeDetail, depositTrail };
