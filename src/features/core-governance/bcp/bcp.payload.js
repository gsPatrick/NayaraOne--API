'use strict';

const { findForm } = require('./bcp.forms.constants');

const TEXT_MAX = 2000;
const isText = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= TEXT_MAX;
const digits = (v) => String(v).replace(/\D/g, '');

/** Cada tipo de campo devolve a mensagem do erro ou null. Valores monetários e inteiros só valem como número inteiro (centavos): "1250.00" é recusado. */
const CHECKS = {
  TEXT: (v) => (isText(v) ? null : 'Informe um texto de até 2000 caracteres.'),
  REF: (v) => (isText(v) && v.length <= 100 ? null : 'Informe a referência (até 100 caracteres).'),
  INTEGER: (v) => (Number.isSafeInteger(v) && v >= 0 ? null : 'Informe um número inteiro maior ou igual a zero.'),
  CENTS: (v) => (Number.isSafeInteger(v) && v > 0 ? null : 'Informe o valor em centavos, como número inteiro maior que zero (R$ 1.250,00 = 125000).'),
  DATE: (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v) ? null : 'Informe a data como AAAA-MM-DD.'),
  DATETIME: (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v.replace(' ', 'T'))) ? null : 'Informe a data e a hora (AAAA-MM-DDTHH:MM).'),
  PERSON_DOC: (v) => (typeof v === 'string' && [11, 14].includes(digits(v).length) ? null : 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).'),
  PHONE: (v) => (typeof v === 'string' && digits(v).length >= 10 && digits(v).length <= 13 ? null : 'Informe o telefone com DDD.'),
};

function checkField([key, type, required, options], payload) {
  const value = payload[key];
  if (value === undefined || value === null || value === '') return required ? { field: key, code: 'REQUIRED', message: 'Campo obrigatório.' } : null;
  const message = type === 'ENUM'
    ? (options.includes(value) ? null : `Use um dos valores: ${options.join(', ')}.`)
    : CHECKS[type](value);
  return message ? { field: key, code: 'INVALID', message } : null;
}

/** Valida o payload contra os campos do formulário. Devolve a lista de erros ([] = válido). */
function validatePayload(formType, payload) {
  const form = findForm(formType);
  if (!form) return [{ field: 'formType', code: 'DESCONHECIDO', message: 'Formulário desconhecido.' }];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [{ field: 'payload', code: 'INVALID', message: 'Os dados do formulário devem ser um objeto.' }];
  return form.fields.map((field) => checkField(field, payload)).filter(Boolean);
}

module.exports = { validatePayload };
