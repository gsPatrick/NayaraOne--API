'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /[^\s@]+@[^\s@]+/;
const CPF_FORMATADO = /\d{3}\.\d{3}\.\d{3}-\d{2}/;
const CNPJ_FORMATADO = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/;
const SO_DIGITOS_DE_DOCUMENTO = /^(\d{11}|\d{14})$/;
const AMOUNT = /^-?\d+(\.\d{1,6})?$/;
const PCT = /^\d+(\.\d{1,2})?$/;
const HASH = /^[0-9a-f]{64}$/i;
const EXCERPT_MAX = 120;
const MISSING = Symbol('missing');

/**
 * Código com cara de dado pessoal: e-mail, CPF ou CNPJ formatado, ou o valor INTEIRO sendo 11 ou 14 dígitos. O evento é recusado em
 * vez de enviado. (Um número de 11 dígitos no meio de um identificador gerado não é CPF: não pode derrubar a operação.)
 */
const looksPersonal = (text) => EMAIL.test(text) || CPF_FORMATADO.test(text) || CNPJ_FORMATADO.test(text) || SO_DIGITOS_DE_DOCUMENTO.test(text);

/** Trecho curto já redigido pela M9-D021: por garantia, o que ainda parecer dado pessoal vira máscara (não derruba a operação). */
const maskPersonal = (text) => text.replace(/[^\s@]+@[^\s@]+/g, '[REDIGIDO]').replace(/\d{3}\.\d{3}\.\d{3}-\d{2}/g, '[REDIGIDO]')
  .replace(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g, '[REDIGIDO]').replace(/\d{11,}/g, '[REDIGIDO]');

/** Código curto: troca o que não é letra, número ou _.:-/ por "_" e limita a 128. Texto com cara de dado pessoal é recusado antes. */
function toCode(raw) {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw; // ex.: versão numérica da lista de padrões
  if (typeof value !== 'string') return MISSING;
  const text = value.trim();
  if (!text || looksPersonal(text)) return MISSING;
  const code = text.replace(/[^A-Za-z0-9_.:\-/]/g, '_').slice(0, 128);
  return /^[A-Za-z0-9]/.test(code) ? code : `_${code}`.slice(0, 128);
}

const isIso = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));

/** Cada tipo devolve o valor limpo ou MISSING. `nullable` aceita null/ausente (grava null). */
const BASE = Object.freeze({
  uuid: (v) => (typeof v === 'string' && UUID.test(v) ? v : MISSING),
  code: toCode,
  int: (v) => (Number.isInteger(v) && v >= 0 ? v : MISSING),
  amount: (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v.toFixed(6);
    return typeof v === 'string' && AMOUNT.test(v) ? v : MISSING;
  },
  pct: (v) => (typeof v === 'string' && PCT.test(v) ? v : MISSING),
  iso: (v) => {
    const text = v instanceof Date ? v.toISOString() : v;
    return isIso(text) ? new Date(text).toISOString() : MISSING;
  },
  score: (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : MISSING),
  hash: (v) => (typeof v === 'string' && HASH.test(v) ? v : MISSING),
  excerpt: (v) => (typeof v === 'string' ? maskPersonal(v).slice(0, EXCERPT_MAX) : MISSING),
  codes: (v) => {
    if (!Array.isArray(v) || v.length > 20) return MISSING;
    const out = v.map(toCode);
    return out.includes(MISSING) ? MISSING : out;
  },
});

/** "nullableX" aceita ausente ou nulo; "X" é obrigatório. */
function check(type, value) {
  const nullable = type.startsWith('nullable');
  const name = nullable ? type[8].toLowerCase() + type.slice(9) : type;
  if (nullable && (value === null || value === undefined)) return null;
  return BASE[name](value);
}

module.exports = { check, MISSING, looksPersonal, EXCERPT_MAX };
