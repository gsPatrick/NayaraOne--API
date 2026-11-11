'use strict';

const AppError = require('../../utils/AppError');
const { optionalString, assertUserInCompany, assertContractInCompany, assertPropertyInCompany } = require('./legalInput');

/**
 * Entrada do processo jurídico (criação e atualização): achados do pentest M5 — responsável/escalonamento de OUTRA
 * empresa era gravado (201) e objeto no lugar de texto/uuid podia virar 500. Aqui: responsável e escalonamento só com
 * vínculo ATIVO na empresa do processo (422 LEGAL_CASE_USER_NOT_IN_TENANT); contrato e imóvel só da mesma empresa;
 * textos só texto; status de uma lista fechada.
 */
const CODE = 'LEGAL_CASE_VALIDATION';
const USER_CODE = 'LEGAL_CASE_USER_NOT_IN_TENANT';
const CASE_STATUSES = ['OPEN', 'SUSPENDED', 'CLOSED', 'ARCHIVED', 'CANCELLED'];

function assertTextFields(payload) {
  for (const [field, max] of [['caseNumber', 120], ['summary', 10000], ['court', 160], ['caseClass', 120]]) {
    if (payload[field] !== undefined) optionalString(payload[field], field, CODE, max);
  }
  if (payload.phase !== undefined && payload.phase !== null && typeof payload.phase !== 'string') {
    throw AppError.badRequest('"phase" deve ser um texto.', CODE);
  }
}

function normalizeStatus(value) {
  if (value === undefined) return undefined;
  const status = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!CASE_STATUSES.includes(status)) throw AppError.badRequest(`"status" deve ser um de: ${CASE_STATUSES.join(', ')}.`, CODE);
  return status;
}

/** Valida e normaliza as referências; só devolve as chaves que vieram no payload. */
async function validateCaseInput(payload, tenant, transaction) {
  assertTextFields(payload);
  const out = {};
  if (payload.responsibleUserId !== undefined) out.responsibleUserId = await assertUserInCompany(payload.responsibleUserId, tenant, 'responsibleUserId', USER_CODE, transaction);
  if (payload.escalationUserId !== undefined) out.escalationUserId = await assertUserInCompany(payload.escalationUserId, tenant, 'escalationUserId', USER_CODE, transaction);
  if (payload.contractId !== undefined) out.contractId = await assertContractInCompany(payload.contractId, tenant.companyId, 'contractId', CODE, transaction);
  if (payload.propertyId !== undefined) out.propertyId = await assertPropertyInCompany(payload.propertyId, tenant.companyId, 'propertyId', CODE, transaction);
  if (payload.caseNumber !== undefined) out.caseNumber = optionalString(payload.caseNumber, 'caseNumber', CODE, 120);
  if (payload.summary !== undefined) out.summary = optionalString(payload.summary, 'summary', CODE, 10000);
  if (payload.status !== undefined) out.status = normalizeStatus(payload.status);
  return out;
}

module.exports = { validateCaseInput, CASE_STATUSES };
