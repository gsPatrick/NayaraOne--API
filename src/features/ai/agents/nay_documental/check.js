'use strict';

const { norm } = require('../scope/scope.evaluate');
const { parseNumberText } = require('../../orchestrator/numbers/decimalText');
const { isValidTaxIdDigits, onlyDigits } = require('../../../people/personDocumentFormat.service');
const { parseVocabulary } = require('./vocabulary');

/**
 * Checagem de consistência (M9-D040) sobre a extração proposta: campo obrigatório do tipo ausente, formato inválido (CPF/CNPJ, data,
 * valor), datas incoerentes ou documento vencido, campo de baixa confiança e divergência contra o que a pessoa informou como esperado.
 * APONTA, NUNCA CORRIGE: nenhum valor é alterado e nada é gravado. Campos obrigatórios por tipo: parâmetro `ia.documental.campos_obrigatorios`.
 */
const finding = (code, field, severity, message, found = null, expected = null) => ({ code, field, severity, message, found, expected });
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === '';
const toTime = (v) => new Date(v).getTime();

function formatFindings(byName) {
  const out = [];
  if (!isEmpty(byName.taxId)) {
    const digits = onlyDigits(String(byName.taxId));
    if (!isValidTaxIdDigits(digits)) out.push(finding('INVALID_TAX_ID', 'taxId', 'HIGH', 'O CPF/CNPJ lido não é válido (formato ou dígitos verificadores).', byName.taxId));
  }
  for (const f of ['issuedAt', 'expiresAt']) {
    if (!isEmpty(byName[f]) && Number.isNaN(toTime(byName[f]))) out.push(finding('INVALID_DATE', f, 'HIGH', `A data de ${f === 'issuedAt' ? 'emissão' : 'validade'} lida não é uma data válida.`, byName[f]));
  }
  for (const f of ['income', 'valor_total']) {
    if (!isEmpty(byName[f]) && (parseNumberText(String(byName[f]).replace(/^R\$\s*/, '')) === null)) out.push(finding('INVALID_AMOUNT', f, 'HIGH', 'O valor lido não é um número válido.', byName[f]));
  }
  return out;
}

function dateFindings(byName, now) {
  const out = [];
  const issued = toTime(byName.issuedAt);
  const expires = toTime(byName.expiresAt);
  if (!isEmpty(byName.issuedAt) && !isEmpty(byName.expiresAt) && issued > expires) out.push(finding('INCONSISTENT_DATES', 'expiresAt', 'HIGH', 'A validade é anterior à emissão.', byName.expiresAt, byName.issuedAt));
  if (!isEmpty(byName.expiresAt) && !Number.isNaN(expires) && expires < now.getTime()) out.push(finding('EXPIRED_DOCUMENT', 'expiresAt', 'MEDIUM', 'O documento está vencido.', byName.expiresAt));
  return out;
}

function sameValue(field, found, expected) {
  if (field === 'taxId' || field === 'documentNumber') return onlyDigits(String(found)) === onlyDigits(String(expected));
  const a = parseNumberText(String(found));
  const b = parseNumberText(String(expected));
  if (a !== null && b !== null && /(valor|total|income|renda)/i.test(field)) return a === b;
  return norm(found) === norm(expected);
}

function checkConsistency(extraction, { requiredFieldsRaw, expected, now = new Date() }) {
  const byName = Object.fromEntries(extraction.fields.map((f) => [f.name, f.value]));
  const findings = [];
  if (extraction.status === 'ILLEGIBLE') findings.push(finding('ILLEGIBLE', null, 'HIGH', 'Documento ilegível: não há campos para checar.'));
  const required = parseVocabulary(requiredFieldsRaw, { normalizeItems: false }).get(String(extraction.documentType).toUpperCase()) || [];
  if (extraction.status !== 'ILLEGIBLE') {
    for (const f of required) if (isEmpty(byName[f])) findings.push(finding('MISSING_FIELD', f, 'HIGH', `Campo obrigatório ausente: ${f}.`));
    findings.push(...formatFindings(byName), ...dateFindings(byName, now));
    extraction.fields.filter((f) => f.confidence < extraction.minConfidence)
      .forEach((f) => findings.push(finding('LOW_CONFIDENCE_FIELD', f.name, 'LOW', 'Campo lido com confiança baixa: confira no documento.', f.value)));
    for (const [field, want] of Object.entries(expected || {})) {
      if (isEmpty(want) || isEmpty(byName[field])) continue;
      if (!sameValue(field, byName[field], want)) findings.push(finding('DIVERGENT_FIELD', field, 'HIGH', 'O valor lido no documento diverge do informado.', byName[field], String(want)));
    }
  }
  return { ok: findings.length === 0, findings, corrected: false };
}

module.exports = { checkConsistency };
