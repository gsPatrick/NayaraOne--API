'use strict';

const digits = (v) => String(v).replace(/\D/g, '');
const isText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** Cada tipo de campo devolve a mensagem do erro ou null. Valores monetários e inteiros só valem como número inteiro (centavos): "1250.00" é recusado. */
const CHECKS = {
  TEXT: (v, s) => (isText(v, s.maxLength || 2000) ? null : `Informe um texto de até ${s.maxLength || 2000} caracteres.`),
  REF: (v, s) => (isText(v, s.maxLength || 100) ? null : `Informe a referência (até ${s.maxLength || 100} caracteres).`),
  INTEGER: (v) => (Number.isSafeInteger(v) && v >= 0 ? null : 'Informe um número inteiro maior ou igual a zero.'),
  CENTS: (v) => (Number.isSafeInteger(v) && v > 0 ? null : 'Informe o valor em centavos, como número inteiro maior que zero (R$ 1.250,00 = 125000).'),
  DATE: (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v) ? null : 'Informe a data como AAAA-MM-DD.'),
  DATETIME: (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v.replace(' ', 'T'))) ? null : 'Informe a data e a hora (AAAA-MM-DDTHH:MM).'),
  PERSON_DOC: (v) => (typeof v === 'string' && [11, 14].includes(digits(v).length) ? null : 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).'),
  PHONE: (v) => (typeof v === 'string' && digits(v).length >= 10 && digits(v).length <= 13 ? null : 'Informe o telefone com DDD.'),
  ENUM: (v, s) => (Array.isArray(s.enum) && s.enum.includes(v) ? null : `Use um dos valores: ${(s.enum || []).join(', ')}.`),
};

function checkField(key, schema, required, payload) {
  const value = payload[key];
  if (value === undefined || value === null || value === '') return required ? { field: key, code: 'REQUIRED', message: 'Campo obrigatório.' } : null;
  const check = CHECKS[schema['x-bcpType']];
  const message = check ? check(value, schema) : 'Tipo de campo desconhecido no modelo.';
  return message ? { field: key, code: 'INVALID', message } : null;
}

/**
 * Valida o payload contra o `payload_schema` do modelo semeado em governance.bcp_form_templates (M9-D834 §3.4; `template` vem de formTemplates.repository). O tipo de cada campo
 * está em `x-bcpType`. Devolve a lista de erros ([] = válido).
 */
function validatePayload(template, payload) {
  if (!template || !template.payloadSchema) return [{ field: 'formType', code: 'DESCONHECIDO', message: 'Formulário desconhecido.' }];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [{ field: 'payload', code: 'INVALID', message: 'Os dados do formulário devem ser um objeto.' }];
  const { properties, required = [] } = template.payloadSchema;
  return Object.entries(properties).map(([key, schema]) => checkField(key, schema, required.includes(key), payload)).filter(Boolean);
}

module.exports = { validatePayload };
