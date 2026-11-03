'use strict';

const AppError = require('../../../utils/AppError');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Limite da coluna NUMERIC(14,2).
const MAX_MONEY = 999999999999.99;

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * parseMoney — valor monetário vindo de fora: número finito, normalizado a 2 casas e dentro do limite
 * da coluna. `allowNegative` vale para ajustes. Devolve o valor já arredondado (é ele que vai ao emissor,
 * ao hash e ao banco: os três nunca divergem).
 */
function parseMoney(value, label, code, { allowNegative = false } = {}) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    throw AppError.badRequest(`${label} é obrigatório e deve ser um número.`, code);
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw AppError.badRequest(`${label} deve ser um número válido.`, code);
  const rounded = round2(n);
  if (!allowNegative && rounded <= 0) throw AppError.badRequest(`${label} deve ser maior que zero.`, code);
  if (Math.abs(rounded) > MAX_MONEY) throw AppError.badRequest(`${label} excede o limite de R$ 999.999.999.999,99.`, code);
  return rounded;
}

/** parsePeriod — AAAA-MM com mês de 01 a 12; devolve o intervalo em horário de Brasília (UTC-3). */
function parsePeriod(period, code) {
  const text = typeof period === 'string' ? period.trim() : '';
  const match = /^(\d{4})-(\d{2})$/.exec(text);
  const year = match ? Number(match[1]) : 0;
  const month = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12 || year < 2000 || year > 2100) {
    throw AppError.badRequest('O campo "referencePeriod" deve estar no formato AAAA-MM, com mês de 01 a 12.', code);
  }
  return {
    period: text,
    year,
    month,
    start: new Date(Date.UTC(year, month - 1, 1, 3)),
    end: new Date(Date.UTC(year, month, 1, 3)),
  };
}

/** brasiliaDate — data (AAAA-MM-DD) em Brasília. */
function brasiliaDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Dígitos verificadores de CPF (11) e CNPJ (14). */
function isValidCpf(digits) {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Number(digits[i]) * (len + 1 - i);
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  return calc(9) === Number(digits[9]) && calc(10) === Number(digits[10]);
}

function isValidCnpj(digits) {
  if (!/^\d{14}$/.test(digits) || /^(\d)\1{13}$/.test(digits)) return false;
  const calc = (len) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Number(digits[i]) * weights[i];
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  return calc(12) === Number(digits[12]) && calc(13) === Number(digits[13]);
}

function isValidTaxId(digits) {
  return digits.length === 11 ? isValidCpf(digits) : digits.length === 14 ? isValidCnpj(digits) : false;
}

/** Nome de arquivo seguro para o cabeçalho Content-Disposition (sem aspas, quebras de linha nem barras). */
function safeFileName(name, fallback = 'arquivo') {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(name ?? '').replace(/[\r\n"\\/;:*?<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  return cleaned || fallback;
}

/** onlyString — parâmetro de consulta só vale como texto simples (nunca lista/objeto). */
function onlyString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = { UUID_RE, MAX_MONEY, round2, isUuid, parseMoney, parsePeriod, brasiliaDate, isValidTaxId, isValidCpf, isValidCnpj, safeFileName, onlyString };
