'use strict';

const crypto = require('crypto');
const AppError = require('../../utils/AppError');

// Normalização/validação de formato de documento (CPF/CNPJ) — reutilizada por person.service.js
// (taxIdNormalized da própria Person) e personDocuments.service.js.

const DOCUMENT_TYPE_PATTERNS = {
  CPF: /^\d{11}$/,
  CNPJ: /^\d{14}$/,
};

// PII_HASH_SECRET: segredo usado para o HMAC de tax_id_normalized_hash (busca exata sem expor
// o CPF/CNPJ em claro — regra de segurança explícita do Caderno). Sem fallback: exigido
// explicitamente em toda instância (dev inclusive), nunca um valor previsível embutido no código.
function requirePiiHashSecret() {
  const value = process.env.PII_HASH_SECRET;
  if (!value) {
    throw AppError.internal(
      'Variável de ambiente obrigatória ausente: PII_HASH_SECRET.',
      'PII_HASH_CONFIG_MISSING'
    );
  }
  return value;
}

function onlyDigits(value) {
  return typeof value === 'string' ? value.replace(/\D/g, '') : value;
}

function validateDocumentFormat(documentType, documentNumber) {
  if (!documentNumber) return;
  const normalizedType = String(documentType || '').toUpperCase();
  const pattern = DOCUMENT_TYPE_PATTERNS[normalizedType];
  if (!pattern) return; // Outros tipos (RG, CIN, CNH, IR, HOLERITE etc.) não têm formato fixo validado aqui.
  const digits = onlyDigits(documentNumber);
  if (!pattern.test(digits)) {
    throw AppError.badRequest(
      `Documento do tipo ${normalizedType} inválido: esperado ${normalizedType === 'CPF' ? '11' : '14'} dígitos numéricos.`,
      'PERSON_DOCUMENT_INVALID_FORMAT'
    );
  }
}

/**
 * hashTaxId — HMAC-SHA256 do CPF/CNPJ normalizado (dígitos), usado para popular
 * tax_id_normalized_hash e permitir busca exata sem expor o documento em claro. Retorna
 * `null` quando não há valor a normalizar.
 */
function hashTaxId(taxIdDigits) {
  if (!taxIdDigits) return null;
  return crypto.createHmac('sha256', requirePiiHashSecret()).update(taxIdDigits).digest('hex');
}

/** isValidTaxIdDigits — CPF (11) ou CNPJ (14) com os dígitos verificadores corretos; sequência repetida é inválida. */
function isValidTaxIdDigits(digits) {
  if (typeof digits !== 'string' || /^(\d)\1+$/.test(digits)) return false;
  const check = (base, weights) => {
    const sum = base.split('').reduce((acc, d, i) => acc + Number(d) * weights[i], 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  if (digits.length === 11) {
    const d1 = check(digits.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
    const d2 = check(digits.slice(0, 9) + d1, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    return digits.endsWith(`${d1}${d2}`);
  }
  if (digits.length === 14) {
    const d1 = check(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    const d2 = check(digits.slice(0, 12) + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    return digits.endsWith(`${d1}${d2}`);
  }
  return false;
}

module.exports = { DOCUMENT_TYPE_PATTERNS, onlyDigits, validateDocumentFormat, hashTaxId, isValidTaxIdDigits };
