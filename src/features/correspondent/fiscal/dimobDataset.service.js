'use strict';

const { Op } = require('sequelize');
const { CommissionEntitlement, Contract, ContractParty, FinancialEntry, Person, Property } = require('../../../models');

const LEASE_TYPES_PATTERN = 'LEASE%';

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** Pendências de um registro de locação (o caderno pede "validações" no dataset da DIMOB). */
function validateLease({ landlords, tenants, property, amount }) {
  const issues = [];
  const add = (code, message) => issues.push({ code, message });
  if (landlords.length === 0) add('LOCADOR_AUSENTE', 'O contrato não tem locador cadastrado.');
  if (tenants.length === 0) add('LOCATARIO_AUSENTE', 'O contrato não tem locatário cadastrado.');
  for (const [papel, lista] of [['locador', landlords], ['locatário', tenants]]) {
    for (const person of lista) {
      const digits = onlyDigits(person?.taxIdNormalized);
      if (!digits) add(`${papel === 'locador' ? 'LOCADOR' : 'LOCATARIO'}_SEM_DOCUMENTO`, `O ${papel} "${person?.legalName || 'sem nome'}" está sem CPF/CNPJ no cadastro.`);
      else if (![11, 14].includes(digits.length)) add('DOCUMENTO_INVALIDO', `O documento do ${papel} "${person?.legalName || 'sem nome'}" não tem 11 (CPF) nem 14 (CNPJ) dígitos.`);
    }
  }
  if (!property) add('IMOVEL_AUSENTE', 'O contrato não está vinculado a um imóvel.');
  if (!(amount > 0)) add('VALOR_NAO_POSITIVO', 'O valor de aluguel recebido no ano não é positivo.');
  return issues;
}

/**
 * buildDimobDataset — fonte real dos registros DIMOB. Duas origens, sempre só por referência:
 *  1. LEASE: aluguéis RECEBIDOS no ano (lançamentos liquidados) de cada contrato de locação, com
 *     locador, locatário e imóvel do contrato e as pendências de cadastro de cada registro;
 *  2. CORRESPONDENT_COMMISSION: comissões de correspondente já recebíveis no ano (acompanhamento
 *     operacional do módulo).
 * Determinístico (mesma entrada, mesma serialização, mesmo hash): ordenado por tipo e id.
 */
async function buildDimobDataset(referenceYear, groupId, companyId, transaction) {
  const start = new Date(Date.UTC(referenceYear, 0, 1));
  const end = new Date(Date.UTC(referenceYear + 1, 0, 1));
  const dataset = [];

  const leaseContracts = await Contract.findAll({
    where: { groupId, companyId, contractType: { [Op.like]: LEASE_TYPES_PATTERN } },
    order: [['id', 'ASC']],
    transaction,
  });
  if (leaseContracts.length) {
    const contractIds = leaseContracts.map((c) => c.id);
    const entries = await FinancialEntry.findAll({
      where: {
        groupId,
        companyId,
        contractId: contractIds,
        nature: 'RECEIVABLE',
        entryType: 'CREDIT',
        status: 'SETTLED',
        settledAt: { [Op.gte]: start, [Op.lt]: end },
      },
      transaction,
    });
    const received = new Map();
    for (const entry of entries) received.set(entry.contractId, round2((received.get(entry.contractId) || 0) + Number(entry.amount)));

    const parties = await ContractParty.findAll({ where: { groupId, companyId, contractId: contractIds, partyRole: ['LANDLORD', 'TENANT'] }, transaction });
    const people = await Person.findAll({ where: { groupId, companyId, id: [...new Set(parties.map((p) => p.personId))] }, attributes: ['id', 'legalName', 'taxIdNormalized'], transaction });
    const personById = new Map(people.map((p) => [p.id, p]));
    const propertyIds = [...new Set(leaseContracts.map((c) => c.propertyId).filter(Boolean))];
    const properties = propertyIds.length ? await Property.findAll({ where: { groupId, companyId, id: propertyIds }, attributes: ['id', 'internalCode'], transaction }) : [];
    const propertyById = new Map(properties.map((p) => [p.id, p]));

    for (const contract of leaseContracts) {
      const amount = received.get(contract.id);
      if (!amount) continue;
      const mine = parties.filter((p) => p.contractId === contract.id);
      const landlords = mine.filter((p) => p.partyRole === 'LANDLORD').map((p) => personById.get(p.personId)).filter(Boolean);
      const tenants = mine.filter((p) => p.partyRole === 'TENANT').map((p) => personById.get(p.personId)).filter(Boolean);
      const property = contract.propertyId ? propertyById.get(contract.propertyId) : null;
      const issues = validateLease({ landlords, tenants, property, amount });
      dataset.push({
        recordType: 'LEASE',
        sourceRefs: {
          contractId: contract.id,
          propertyId: contract.propertyId || null,
          landlordPersonIds: landlords.map((p) => p.id),
          tenantPersonIds: tenants.map((p) => p.id),
        },
        amount,
        validationStatus: issues.length ? 'INVALID' : 'VALID',
        validationIssues: issues,
        detailJson: { contractNumber: contract.contractNumber || null },
      });
    }
  }

  const entitlements = await CommissionEntitlement.findAll({
    where: {
      groupId,
      companyId,
      // ADJUSTED (chargeback/estorno) fica de fora de propósito: é receita revertida, nunca
      // deveria contar como renda recebida no DIMOB.
      status: { [Op.in]: ['RECEIVABLE', 'RECEIVED'] },
      // O model define `createdAt: 'created_at'` como override de nome do atributo: a chave do where é 'created_at'.
      created_at: { [Op.gte]: start, [Op.lt]: end },
    },
    order: [['id', 'ASC']],
    transaction,
  });
  for (const e of entitlements) {
    dataset.push({
      recordType: 'CORRESPONDENT_COMMISSION',
      sourceRefs: { commissionEntitlementId: e.id, financingCaseId: e.financingCaseId },
      amount: Number(e.amount),
      validationStatus: 'VALID',
      validationIssues: [],
      detailJson: {},
    });
  }

  return dataset;
}

function canonicalLine(record) {
  if (record.recordType === 'LEASE') return `LEASE:${record.sourceRefs.contractId}:${Number(record.amount).toFixed(2)}`;
  return `${record.sourceRefs.commissionEntitlementId}:${record.sourceRefs.financingCaseId}:${Number(record.amount).toFixed(2)}`;
}

module.exports = { buildDimobDataset, canonicalLine, validateLease, onlyDigits };
