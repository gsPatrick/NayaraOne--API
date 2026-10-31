'use strict';

const { Op, literal } = require('sequelize');
const { getDimobIncludeCommissions, getDimobExcludedKeywords } = require('../commissionSplit.service');
const { CommissionEntitlement, Contract, ContractParty, FinancialEntry, Person, Property } = require('../../../models');
const { isValidTaxId } = require('./fiscalCommon');

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
      else if (!isValidTaxId(digits)) add('DOCUMENTO_INVALIDO', `O CPF/CNPJ do ${papel} "${person?.legalName || 'sem nome'}" não é válido (dígitos verificadores incorretos).`);
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
  // O ano fiscal é o de Brasília (UTC-3): um recebimento liquidado em 31/12 às 22h entra nesse ano.
  const start = new Date(Date.UTC(referenceYear, 0, 1, 3));
  const end = new Date(Date.UTC(referenceYear + 1, 0, 1, 3));
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
        // Dinheiro de terceiros (caução, garantia) não é aluguel recebido: fica fora da DIMOB.
        isThirdPartyFunds: { [Op.not]: true },
        settledAt: { [Op.gte]: start, [Op.lt]: end },
      },
      transaction,
    });
    // Baixa parcial: o pagamento real são as filhas (cada uma com a sua data); o lançamento pai, que
    // volta como liquidado com o valor cheio, NÃO conta de novo. Cobrança que a empresa classifica
    // como não-aluguel (condomínio, IPTU, multa, taxa...: palavras em Parâmetros) fica de fora.
    // Só as baixas efetivamente liquidadas contam como pagamento: filha estornada, cancelada ou pendente não cobre o pai.
    const parentsWithChildren = new Set(
      (await FinancialEntry.findAll({ where: { groupId, companyId, contractId: contractIds, parentEntryId: { [Op.ne]: null }, status: 'SETTLED' }, attributes: ['parentEntryId'], transaction }))
        .map((c) => c.parentEntryId)
    );
    const plain = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const keywords = (await getDimobExcludedKeywords(groupId, companyId, null, transaction)).map(plain).filter(Boolean);
    const isRent = (entry) => {
      if (parentsWithChildren.has(entry.id)) return false;
      // Palavra inteira (ou começo de palavra, para palavras longas): "taxa" não pega "taxativa" e "agua" não pega "aguardando".
      const words = plain(entry.description).match(/[a-z0-9]+/g) || [];
      return !keywords.some((k) => words.some((w) => w === k || (k.length >= 5 && w.startsWith(k))));
    };
    const received = new Map();
    for (const entry of entries.filter(isRent)) received.set(entry.contractId, round2((received.get(entry.contractId) || 0) + Number(entry.amount)));

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
        // Foto dos dados no momento da geração: o arquivo de um batch fechado sai desta foto, não do
        // cadastro de hoje (mudar o CPF de alguém depois não pode mudar um batch já gerado).
        detailJson: {
          contractNumber: contract.contractNumber || null,
          landlords: landlords.map((p) => ({ id: p.id, name: p.legalName || null, taxId: onlyDigits(p.taxIdNormalized) || null })),
          tenants: tenants.map((p) => ({ id: p.id, name: p.legalName || null, taxId: onlyDigits(p.taxIdNormalized) || null })),
          propertyCode: property?.internalCode || null,
        },
      });
    }
  }

  // Comissão de correspondente só entra na DIMOB se a empresa assim configurou (o caderno não pede).
  const includeCommissions = await getDimobIncludeCommissions(groupId, companyId, null, transaction);
  const entitlements = includeCommissions ? await CommissionEntitlement.findAll({
    where: {
      groupId,
      companyId,
      // ADJUSTED (chargeback/estorno) fica de fora de propósito: é receita revertida, nunca
      // deveria contar como renda recebida no DIMOB.
      status: { [Op.in]: ['RECEIVABLE', 'RECEIVED'] },
      // Competência pela data em que a comissão foi recebida (ou, na falta, confirmada/criada).
      [Op.and]: [sequelizeLiteralYear(start, end)],
    },
    order: [['id', 'ASC']],
    transaction,
  }) : [];
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

// COALESCE(recebida, confirmada, criada) dentro do ano fiscal. As datas vêm de Date (ISO), nunca de texto livre.
function sequelizeLiteralYear(start, end) {
  return literal(`COALESCE("CommissionEntitlement"."received_at", "CommissionEntitlement"."confirmed_at", "CommissionEntitlement"."created_at") >= '${start.toISOString()}' AND COALESCE("CommissionEntitlement"."received_at", "CommissionEntitlement"."confirmed_at", "CommissionEntitlement"."created_at") < '${end.toISOString()}'`);
}

function canonicalLine(record) {
  if (record.recordType === 'LEASE') {
    // O hash cobre também quem são as partes (documento) e o imóvel: mudar locador, locatário ou
    // CPF gera um snapshot diferente.
    const docs = (list) => (list || []).map((p) => p.taxId || '').sort().join(',');
    const detail = record.detailJson || {};
    const names = (list) => (list || []).map((p) => p.name || '').sort().join(',');
    return `LEASE:${record.sourceRefs.contractId}:${Number(record.amount).toFixed(2)}:L=${docs(detail.landlords)}:T=${docs(detail.tenants)}:P=${detail.propertyCode || ''}:N=${detail.contractNumber || ''}:LN=${names(detail.landlords)}:TN=${names(detail.tenants)}`;
  }
  return `${record.sourceRefs.commissionEntitlementId}:${record.sourceRefs.financingCaseId}:${Number(record.amount).toFixed(2)}`;
}

module.exports = { buildDimobDataset, canonicalLine, validateLease, onlyDigits };
