'use strict';

const crypto = require('node:crypto');

/**
 * Máscaras do registro de classificação (M9-D915 §3.2). Função pura (a chave do TOKENIZE vem do ambiente). Nenhuma detecção de documento por expressão regular: o tipo do
 * dado vem do padrão de máscara do registro, do nome do campo ou do formato do próprio valor (contagem de dígitos e de separadores), para a biblioteca única de redaction
 * continuar dona das expressões. Formatos: CPF só com os 2 últimos dígitos, CNPJ idem, e-mail com a 1a letra e o domínio, telefone com os 4 últimos, conta com os 4 últimos (exemplos nos testes m9d915).
 */
const isDigit = (ch) => ch >= '0' && ch <= '9';
const digitsOf = (text) => [...text].filter(isDigit).join('');
const has = (text, ...parts) => parts.some((part) => text.includes(part));

function kindOf(field, pattern, text) {
  const name = String(field || '').toLowerCase();
  const hint = String(pattern || '');
  const digits = digitsOf(text);
  if (text.includes('@')) return 'EMAIL';
  if ((hint.includes('/') || has(name, 'cnpj')) && digits.length === 14) return 'CNPJ';
  if ((hint.startsWith('***.') || has(name, 'cpf', 'tax_id', 'taxid')) && digits.length === 11) return 'CPF';
  if (has(name, 'phone', 'telefone', 'celular', 'whatsapp', 'mobile') && digits.length >= 10 && digits.length <= 13) return 'PHONE';
  if (has(name, 'account', 'conta', 'agency', 'agencia', 'iban')) return 'ACCOUNT';
  if (digits.length === 14 && text.length === 18 && text[2] === '.') return 'CNPJ';
  if (digits.length === 11 && text.length === 14 && text[3] === '.') return 'CPF';
  if (has(name, 'pix') && text.startsWith('+') && digits.length >= 10) return 'PHONE';
  if (has(name, 'pix') && digits.length === 14) return 'CNPJ';
  if (has(name, 'pix') && digits.length === 11) return 'CPF';
  return 'GENERIC';
}

function partialEmail(text) {
  const at = text.lastIndexOf('@');
  const local = text.slice(0, at);
  return `${local ? local[0] : ''}***${text.slice(at)}`;
}

function partial(text, field, pattern, full) {
  const kind = kindOf(field, pattern, text);
  const digits = digitsOf(text);
  if (kind === 'EMAIL') return partialEmail(text);
  if (kind === 'CPF') return `***.***.***-${digits.slice(-2)}`;
  if (kind === 'CNPJ') return `**.***.***/****-${digits.slice(-2)}`;
  if (kind === 'PHONE') return `(**) *****-${digits.slice(-4)}`;
  const base = digits.length >= 4 ? digits : text;
  return base.length > 4 ? `****${base.slice(-4)}` : full;
}

/** Chave da empresa derivada de DLP_TOKEN_KEY; sem a chave do ambiente, null (o TOKENIZE cai na máscara total: falha fechada). */
function tokenKeyFor(companyId) {
  const base = process.env.DLP_TOKEN_KEY;
  if (!base || !companyId) return null;
  return crypto.createHmac('sha256', base).update(`company:${companyId}`).digest();
}

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

function tokenize(text, companyId, full) {
  const key = tokenKeyFor(companyId);
  return key ? `tok_${crypto.createHmac('sha256', key).update(text).digest('hex').slice(0, 16)}` : full;
}

/**
 * Valor mascarado por `masking` (NONE, PARTIAL, FULL, HASH, TOKENIZE). `ctx`: { field, maskPattern, companyId, maskText }. Vazio devolve o que veio; valor que não é texto nem
 * número (objeto, data) só tem máscara total (não há como mostrar um pedaço dele).
 */
function applyMasking(value, masking, ctx) {
  const full = ctx.maskText;
  if (value === null || value === undefined || value === '') return value;
  if (masking === 'NONE') return value;
  if (masking === 'FULL') return full;
  if (typeof value !== 'string' && typeof value !== 'number') return full;
  const text = String(value);
  if (masking === 'HASH') return hash(text);
  if (masking === 'TOKENIZE') return tokenize(text, ctx.companyId, full);
  return partial(text, ctx.field, ctx.maskPattern, full);
}

module.exports = { applyMasking, kindOf, tokenKeyFor };
