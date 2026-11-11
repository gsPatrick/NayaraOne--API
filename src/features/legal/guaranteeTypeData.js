'use strict';

const { Op } = require('sequelize');
const { File, Person, ContractParty, FinancialEntry, Guarantee } = require('../../models');
const AppError = require('../../utils/AppError');
const { getSetting } = require('../settings/settings.service');

/**
 * Fechamento M5 (Caderno §9 "Garantias locatícias" — Código | Tipo | Dados). Os cinco códigos do livro e os dados de
 * cada tipo; os apelidos antigos (DEPOSIT, CAPITALIZATION_TITLE) só são aceitos na entrada.
 *  GUARANTOR       Pessoas, documentos, vigência, aceite.
 *  INSURANCE       Provider/apólice, vigência, parcelas, renovação.
 *  SECURITY_DEPOSIT Valor de terceiro, vínculo financeiro, devolução/compensação (o saldo vive só no Financeiro).
 *  CAPITALIZATION  Documento/provider/vigência.
 *  OTHER           Fluxo configurado (`legal.guarantee_other_flows`: [{ code, label, requiredFields }]).
 * Dado informado é sempre conferido; dado obrigatório que falta deixa a garantia PENDING (não ACTIVE).
 */
const GUARANTEE_TYPES = ['GUARANTOR', 'INSURANCE', 'SECURITY_DEPOSIT', 'CAPITALIZATION', 'OTHER'];
const GUARANTEE_TYPE_ALIASES = { DEPOSIT: 'SECURITY_DEPOSIT', CAPITALIZATION_TITLE: 'CAPITALIZATION' };
const TYPE_LABELS = { GUARANTOR: 'Fiador', INSURANCE: 'Seguro-fiança', SECURITY_DEPOSIT: 'Caução', CAPITALIZATION: 'Título de capitalização', OTHER: 'Outra garantia homologada' };
const REQUIRED = {
  GUARANTOR: ['guarantorPersonId', 'documentFileIds', 'acceptanceFileId', 'acceptedAt', 'endsAt'],
  INSURANCE: ['providerName', 'policyNumber', 'policyFileId', 'value', 'endsAt', 'premiumInstallments', 'renewalDueAt'],
  SECURITY_DEPOSIT: ['value', 'financeEntryId'],
  CAPITALIZATION: ['providerName', 'certificateNumber', 'certificateFileId', 'value', 'endsAt'],
  OTHER: ['homologatedFlowCode'],
};
const FIELD_LABELS = {
  guarantorPersonId: 'pessoa fiadora', documentFileIds: 'documentos do fiador', acceptanceFileId: 'termo de aceite', acceptedAt: 'data do aceite',
  endsAt: 'fim da vigência', providerName: 'seguradora/provider', policyNumber: 'número da apólice', policyFileId: 'arquivo da apólice', value: 'valor',
  premiumInstallments: 'parcelas do prêmio', renewalDueAt: 'data de renovação', financeEntryId: 'recebimento da caução no Financeiro',
  certificateNumber: 'número do título', certificateFileId: 'documento do título', homologatedFlowCode: 'fluxo homologado',
};
const FILE_FIELDS = ['acceptanceFileId', 'policyFileId', 'certificateFileId'];
const UUID_RE = /^[0-9a-f-]{36}$/i;
const bad = (message, code = 'LEGAL_GUARANTEE_VALIDATION') => AppError.badRequest(message, code);

function normalizeGuaranteeType(value) {
  if (!value) return value;
  const upper = String(value).toUpperCase();
  return GUARANTEE_TYPE_ALIASES[upper] || upper;
}

async function readOtherFlows(tenant, transaction) {
  const raw = await getSetting('legal.guarantee_other_flows', tenant, transaction, null);
  try {
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(list) ? list.filter((f) => f && typeof f.code === 'string') : [];
  } catch (err) {
    return []; // configuração ilegível = nenhuma "outra" garantia homologada (fail closed)
  }
}

async function assertCompanyFile(fileId, contract, field, transaction, selfId) {
  if (!UUID_RE.test(String(fileId))) throw bad(`"${field}" deve ser um arquivo enviado ao sistema.`);
  const file = await File.findOne({ where: { id: fileId, companyId: contract.companyId }, attributes: ['id'], transaction });
  if (!file) throw bad(`O arquivo informado em "${field}" não existe nesta empresa.`, 'LEGAL_GUARANTEE_FILE_NOT_FOUND');
  const reuse = await Guarantee.findOne({
    where: { [Op.or]: FILE_FIELDS.map((f) => ({ [f]: fileId })), ...(selfId ? { id: { [Op.ne]: selfId } } : {}) },
    attributes: ['id'],
    transaction,
  });
  if (reuse) throw AppError.conflict('Este arquivo já está em outra garantia.', 'LEGAL_GUARANTEE_FILE_REUSED');
}

async function assertGuarantorPeople(ids, contract, transaction) {
  for (const id of ids) {
    if (!UUID_RE.test(String(id)) || !(await Person.findByPk(id, { attributes: ['id'], transaction }))) {
      throw bad('A pessoa fiadora informada não existe nesta empresa.');
    }
    const party = await ContractParty.findOne({ where: { contractId: contract.id, personId: id, partyRole: { [Op.in]: ['LANDLORD', 'TENANT'] } }, transaction });
    if (party) throw bad('O fiador não pode ser o locador nem o locatário do contrato.', 'LEGAL_GUARANTEE_GUARANTOR_CONFLICT');
  }
}

function assertInstallments(list, annualPremium) {
  if (!Array.isArray(list) || list.length === 0) throw bad('"premiumInstallments" deve ser uma lista de parcelas { number, dueDate, amount }.');
  let cents = 0;
  list.forEach((p, i) => {
    const amount = Number(p && p.amount);
    if (!p || !Number.isInteger(Number(p.number)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.dueDate || '')) || !Number.isFinite(amount) || amount <= 0) {
      throw bad(`Parcela ${i + 1} do prêmio inválida: informe número, vencimento (AAAA-MM-DD) e valor maior que zero.`);
    }
    cents += Math.round(amount * 100);
  });
  if (annualPremium !== undefined && annualPremium !== null && Math.round(Number(annualPremium) * 100) !== cents) {
    throw bad('A soma das parcelas do prêmio não confere com o prêmio anual informado.');
  }
  return list.map((p) => ({ number: Number(p.number), dueDate: p.dueDate, amount: Number(p.amount), status: p.status || 'PENDING', paidAt: p.paidAt || null }));
}

async function assertDepositOrigin(entryId, contract, transaction) {
  const entry = UUID_RE.test(String(entryId)) ? await FinancialEntry.findByPk(entryId, { transaction }) : null;
  const problem = !entry ? 'o lançamento não existe nesta empresa'
    : entry.contractId !== contract.id ? 'o lançamento é de outro contrato'
      : !entry.isThirdPartyFunds || entry.nature !== 'RECEIVABLE' ? 'o lançamento não é um recebimento de dinheiro de terceiros'
        : entry.thirdPartyOriginEntryId ? 'o lançamento é um movimento (devolução/compensação), não o recebimento de origem'
          : ['REVERSED', 'CANCELLED'].includes(entry.status) ? 'o lançamento foi estornado/cancelado' : null;
  if (problem) throw AppError.conflict(`O recebimento da caução não confere: ${problem}.`, 'LEGAL_GUARANTEE_DEPOSIT_ORIGIN_INVALID');
  return entry;
}

/**
 * Confere os dados do tipo que vieram no payload e devolve { fields, missing }. `current` é a garantia já gravada (na
 * atualização), para calcular o que ainda falta.
 */
async function resolveTypeData(guaranteeType, payload, contract, transaction, current = null) {
  const p = payload || {};
  const fields = {};
  const take = (k) => p[k] !== undefined;
  if (take('guarantorPersonId') || take('additionalGuarantorPersonIds')) {
    const extra = take('additionalGuarantorPersonIds') ? p.additionalGuarantorPersonIds : (current && current.additionalGuarantorPersonIds) || [];
    if (!Array.isArray(extra)) throw bad('"additionalGuarantorPersonIds" deve ser uma lista de pessoas.');
    const main = take('guarantorPersonId') ? p.guarantorPersonId : current && current.guarantorPersonId;
    if (guaranteeType === 'GUARANTOR') await assertGuarantorPeople([main, ...extra].filter(Boolean), contract, transaction);
    if (take('additionalGuarantorPersonIds')) fields.additionalGuarantorPersonIds = extra;
  }
  if (take('documentFileIds')) {
    if (!Array.isArray(p.documentFileIds) || p.documentFileIds.length === 0) throw bad('"documentFileIds" deve listar os documentos do fiador.');
    for (const id of p.documentFileIds) {
      if (!UUID_RE.test(String(id)) || !(await File.findOne({ where: { id, companyId: contract.companyId }, attributes: ['id'], transaction }))) {
        throw bad('Um dos documentos do fiador não existe nesta empresa.', 'LEGAL_GUARANTEE_FILE_NOT_FOUND');
      }
    }
    fields.documentFileIds = [...new Set(p.documentFileIds.map(String))];
  }
  for (const f of FILE_FIELDS) {
    if (take(f) && p[f] !== null) { await assertCompanyFile(p[f], contract, f, transaction, current && current.id); fields[f] = p[f]; }
  }
  if (take('acceptedAt')) {
    if (Number.isNaN(new Date(p.acceptedAt).getTime())) throw bad('"acceptedAt" deve ser uma data.');
    fields.acceptedAt = new Date(p.acceptedAt);
  }
  for (const f of ['providerName', 'policyNumber', 'certificateNumber', 'notes']) {
    if (take(f)) fields[f] = p[f] === null ? null : String(p[f]).trim().slice(0, f === 'notes' ? 4000 : 160) || null;
  }
  if (take('policyNumber') && fields.policyNumber) {
    const provider = take('providerName') ? fields.providerName : current && current.providerName;
    const dup = await Guarantee.findOne({
      where: { policyNumber: fields.policyNumber, ...(current ? { id: { [Op.ne]: current.id } } : {}) },
      attributes: ['id', 'providerName'],
      transaction,
    });
    if (dup && String(dup.providerName || '').toLowerCase() === String(provider || '').toLowerCase()) {
      throw AppError.conflict('Já existe garantia com esta apólice.', 'LEGAL_GUARANTEE_POLICY_DUPLICATE');
    }
  }
  if (take('annualPremium')) fields.annualPremium = p.annualPremium;
  if (take('premiumInstallments')) fields.premiumInstallments = assertInstallments(p.premiumInstallments, take('annualPremium') ? p.annualPremium : current && current.annualPremium);
  if (take('renewalDueAt')) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(p.renewalDueAt))) throw bad('"renewalDueAt" deve ser uma data AAAA-MM-DD.');
    fields.renewalDueAt = String(p.renewalDueAt).slice(0, 10);
  }
  if (take('autoRenew')) fields.autoRenew = Boolean(p.autoRenew);
  if (take('redemptionAmount')) fields.redemptionAmount = p.redemptionAmount;
  if (take('financeEntryId')) {
    if (guaranteeType !== 'SECURITY_DEPOSIT') throw bad('Só a caução (SECURITY_DEPOSIT) aponta para um recebimento do Financeiro.');
    const entry = await assertDepositOrigin(p.financeEntryId, contract, transaction);
    const value = take('value') ? Number(p.value) : current && Number(current.value);
    if (value && Math.round(Number(entry.amount) * 100) < Math.round(value * 100)) {
      throw AppError.conflict('O recebimento da caução não confere: o valor recebido é menor que o valor da caução.', 'LEGAL_GUARANTEE_DEPOSIT_ORIGIN_INVALID');
    }
    fields.financeEntryId = entry.id;
    fields.holderPersonId = entry.thirdPartyHolderPersonId || null;
  }
  for (const f of ['balance', 'refundedAmount', 'compensatedAmount', 'availableAmount']) {
    if (take(f)) throw bad('O saldo da caução é controlado pelo Financeiro.', 'LEGAL_GUARANTEE_DEPOSIT_FIELD_NOT_ALLOWED');
  }
  if (take('homologatedFlowCode') || guaranteeType === 'OTHER') {
    const code = take('homologatedFlowCode') ? p.homologatedFlowCode : current && current.homologatedFlowCode;
    if (guaranteeType === 'OTHER') {
      const flow = (await readOtherFlows({ groupId: contract.groupId, companyId: contract.companyId }, transaction)).find((f) => f.code === code);
      if (!flow) throw bad('Esta forma de garantia não foi homologada para esta empresa.', 'LEGAL_GUARANTEE_FLOW_NOT_CONFIGURED');
      const data = take('flowData') ? p.flowData : (current && current.flowData) || {};
      const missingFlow = (flow.requiredFields || []).filter((k) => data === null || typeof data !== 'object' || data[k] === undefined || data[k] === null || data[k] === '');
      if (missingFlow.length) throw bad(`O fluxo "${flow.label || flow.code}" exige: ${missingFlow.join(', ')}.`);
      fields.homologatedFlowCode = code;
      fields.flowData = data;
    }
  }
  const merged = { ...(current ? current.toJSON() : {}), ...p, ...fields };
  const missing = (REQUIRED[guaranteeType] || []).filter((k) => {
    const v = merged[k];
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  });
  return { fields, missing };
}

function missingMessage(guaranteeType, missing) {
  return `Para ativar a garantia do tipo ${TYPE_LABELS[guaranteeType]} informe: ${missing.map((k) => FIELD_LABELS[k] || k).join(', ')}.`;
}

module.exports = { GUARANTEE_TYPES, GUARANTEE_TYPE_ALIASES, TYPE_LABELS, REQUIRED, normalizeGuaranteeType, resolveTypeData, missingMessage, readOtherFlows };
