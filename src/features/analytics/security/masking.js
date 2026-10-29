'use strict';

/**
 * M9-D700 (3.4) — mascaramento dos campos RESTRICTED. Vale para TODOS os usuários, em detalhe (drill-down), exportação e
 * ferramentas da NAY; nenhuma permissão o desliga. Formatos do livro: CPF `***.456.789-**`, conta `****1234`,
 * e-mail `j***@dominio.com`, telefone `(11) *****-4321`, parte de processo `J. S.`.
 * Dois níveis: pelo NOME do campo (palavras do nome, não nome exato; mais os nomes extras do administrador) e pelo VALOR
 * (CPF, CNPJ, e-mail e telefone em qualquer texto, com ou sem pontuação; sem pontuação só com dígito verificador válido). O resultado nunca devolve o original; chave RESTRITA sem formato próprio vira "[RESTRITO]".
 */
const { SOURCES } = require('../../../shared/redaction');

const REDACTED = '[RESTRITO]';
const digits = (v) => String(v ?? '').replace(/\D/g, '');

function maskCpf(v) {
  const d = digits(v);
  if (d.length !== 11) return REDACTED;
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}

function maskCnpj(v) {
  const d = digits(v);
  if (d.length !== 14) return REDACTED;
  return `**.***.***/${d.slice(8, 12)}-**`;
}

function maskAccount(v) {
  const d = digits(v);
  return d.length > 4 ? `****${d.slice(-4)}` : '****';
}

function maskEmail(v) {
  const s = String(v ?? '');
  const at = s.lastIndexOf('@');
  if (at < 1) return REDACTED;
  return `${s[0]}***${s.slice(at)}`;
}

function maskPhone(v) {
  let d = digits(v);
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length < 10) return REDACTED;
  return `(${d.slice(0, 2)}) *****-${d.slice(-4)}`;
}

const PARTICLES = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
function maskPartyName(v) {
  const parts = String(v ?? '').trim().split(/\s+/).filter((w) => w && !PARTICLES.has(w.toLowerCase()));
  if (!parts.length) return REDACTED;
  return parts.map((w) => `${w[0].toUpperCase()}.`).join(' ');
}

// Regras por TOKEN do nome do campo (camelCase, snake_case, kebab e acento separam as palavras): "cpfCliente",
// "customer_phone_number", "numeroConta" e "nome_da_parte" casam; "nome", "valor" e "chave" seguem livres.
// Casa se algum token CONTÉM o radical (cpf/cnpj/mail) ou é igual a uma palavra da lista. A primeira regra que casar vale.
const has = (tokens, words) => tokens.some((t) => words.includes(t));
const contains = (tokens, stems) => tokens.some((t) => stems.some((st) => t.includes(st)));
const KEY_RULES = [
  [(t) => contains(t, ['cpf']), maskCpf],
  [(t) => contains(t, ['cnpj']), maskCnpj],
  [(t) => contains(t, ['email', 'mail']), maskEmail],
  [(t) => has(t, ['phone', 'telefone', 'celular', 'whatsapp', 'mobile', 'fone', 'tel']), maskPhone],
  [(t) => has(t, ['conta', 'account', 'agencia', 'iban', 'pix']), maskAccount],
  [(t) => has(t, ['parte', 'partes', 'party', 'parties']), maskPartyName],
  [(t) => has(t, ['documento', 'document', 'rg', 'cnh', 'passport', 'passaporte']), () => REDACTED],
  [(t) => has(t, ['salary', 'salario', 'remuneracao', 'remuneration', 'prolabore', 'labore', 'holerite', 'payroll']), () => REDACTED],
];
// Sufixos que indicam metadado do campo (identificador, tipo, contagem), não o dado sensível em si.
const NEUTRAL_LAST = new Set(['id', 'ids', 'uuid', 'type', 'tipo', 'status', 'count', 'qtd', 'total', 'flag', 'at', 'em', 'ok']);

function keyTokens(k) {
  return String(k)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());
}
function keyRule(key) {
  const tokens = keyTokens(key);
  if (!tokens.length) return null;
  const rule = KEY_RULES.find(([test]) => test(tokens));
  if (!rule) return null;
  const sensitiveByStem = contains(tokens, ['cpf', 'cnpj', 'mail']);
  if (!sensitiveByStem && NEUTRAL_LAST.has(tokens[tokens.length - 1]) && tokens.length > 1) return null;
  return rule;
}
// M9-D246: a detecção de documento e e-mail mora na biblioteca única de redaction; aqui só o formato da máscara é próprio.
const CPF_VALUE = new RegExp(SOURCES.cpfFormatted, 'g');
const CNPJ_VALUE = new RegExp(SOURCES.cnpjFormatted, 'g');
const EMAIL_VALUE = new RegExp(SOURCES.email, 'g');
// Sem pontuação: só vale com dígito verificador correto (evita mascarar número qualquer de 11/14 dígitos).
const CPF_BARE = /(?<![\d.\-/])\d{11}(?![\d]|[.\-/]\d)/g;
const CNPJ_BARE = /(?<![\d.\-/])\d{14}(?![\d]|[.\-/]\d)/g;
// Telefone brasileiro em texto livre: com DDD entre parênteses, com +55, ou celular de 11 dígitos (DDD + 9).
const PHONE_VALUE = /(?:\+55[\s-]?)?\(\d{2}\)[\s-]?9?\d{4}[-\s]?\d{4}(?!\d)|\+55[\s-]?\d{2}[\s-]?9?\d{4}[-\s]?\d{4}(?!\d)|(?<![\d.\-/])\d{2}9\d{8}(?!\d)/g;

function validCpf(d) {
  if (/^(\d)\1+$/.test(d)) return false;
  for (const n of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += Number(d[i]) * (n + 1 - i);
    if (((sum * 10) % 11) % 10 !== Number(d[n])) return false;
  }
  return true;
}
function validCnpj(d) {
  if (/^(\d)\1+$/.test(d)) return false;
  for (const n of [12, 13]) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += Number(d[i]) * (((n - 1 - i) % 8) + 2);
    const r = sum % 11;
    if ((r < 2 ? 0 : 11 - r) !== Number(d[n])) return false;
  }
  return true;
}

const normKey = (k) => String(k).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

/** "nenhum" ou lista separada por vírgula/ponto e vírgula -> Set de nomes normalizados. */
function parseExtraFields(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || t === 'nenhum') return new Set();
  return new Set(t.split(/[,;]/).map(normKey).filter(Boolean));
}

function maskString(s) {
  return s
    .replace(CPF_VALUE, (m) => maskCpf(m)).replace(CNPJ_VALUE, (m) => maskCnpj(m))
    .replace(CNPJ_BARE, (m) => (validCnpj(m) ? maskCnpj(m) : m)).replace(CPF_BARE, (m) => (validCpf(m) ? maskCpf(m) : m))
    .replace(EMAIL_VALUE, (m) => maskEmail(m)).replace(PHONE_VALUE, (m) => maskPhone(m));
}

function maskValue(key, value, extra, state) {
  const nk = normKey(key);
  if (value !== null && typeof value === 'object') return walk(value, extra, state);
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  const rule = keyRule(key);
  if (rule) { state.count += 1; return rule[1](value); }
  if (extra.has(nk)) { state.count += 1; return REDACTED; }
  if (typeof value === 'string') {
    const masked = maskString(value);
    if (masked !== value) state.count += 1;
    return masked;
  }
  return value;
}

function walk(node, extra, state) {
  if (Array.isArray(node)) return node.map((item) => (item !== null && typeof item === 'object' ? walk(item, extra, state) : maskValue('', item, extra, state)));
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = maskValue(k, v, extra, state);
  return out;
}

/** Devolve { data, maskedCount } sem alterar a entrada. `extraFields` = Set de parseExtraFields. */
function maskRestricted(data, extraFields = new Set()) {
  const state = { count: 0 };
  if (data === null || typeof data !== 'object') return { data: maskValue('', data, extraFields, state), maskedCount: state.count };
  return { data: walk(data, extraFields, state), maskedCount: state.count };
}

module.exports = { REDACTED, maskCpf, maskCnpj, maskAccount, maskEmail, maskPhone, maskPartyName, parseExtraFields, maskRestricted };
