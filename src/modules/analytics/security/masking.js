'use strict';

/**
 * M9-D700 (3.4) — mascaramento dos campos RESTRICTED. Vale para TODOS os usuários, em detalhe (drill-down), exportação e
 * ferramentas da NAY; nenhuma permissão o desliga. Formatos do livro: CPF `***.456.789-**`, conta `****1234`,
 * e-mail `j***@dominio.com`, telefone `(11) *****-4321`, parte de processo `J. S.`.
 * Dois níveis: pelo NOME do campo (lista fixa + nomes extras do administrador) e pelo VALOR (CPF, CNPJ e e-mail formatados
 * em qualquer campo de texto). O resultado nunca devolve o original; chave RESTRITA sem formato próprio vira "[RESTRITO]".
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

// Regras por nome de campo (sem acento/maiúscula/separador). A primeira que casar vale.
const KEY_RULES = [
  [/cpf$/, maskCpf],
  [/cnpj$/, maskCnpj],
  [/(email|mail)$/, maskEmail],
  [/(phone|telefone|celular|whatsapp|mobile)$|^fone$/, maskPhone],
  [/^(bank)?(account|conta)(number|numero|bancaria)?$|^iban$|^pixkey$|^chavepix$|^agencia$/, maskAccount],
  [/^(party|parte)(name|nome)?$|^(nomeparte|partyname)$/, maskPartyName],
  [/^(document|documento)(number|numero)?$|^(rg|cnh|passport|passaporte)$/, () => REDACTED],
  [/(salary|salario|remuneracao|remuneration|prolabore|holerite|payroll)$/, () => REDACTED],
];
// M9-D246: a detecção de documento e e-mail mora na biblioteca única de redaction; aqui só o formato da máscara é próprio.
const CPF_VALUE = new RegExp(SOURCES.cpfFormatted, 'g');
const CNPJ_VALUE = new RegExp(SOURCES.cnpjFormatted, 'g');
const EMAIL_VALUE = new RegExp(SOURCES.email, 'g');

const normKey = (k) => String(k).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

/** "nenhum" ou lista separada por vírgula/ponto e vírgula -> Set de nomes normalizados. */
function parseExtraFields(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || t === 'nenhum') return new Set();
  return new Set(t.split(/[,;]/).map(normKey).filter(Boolean));
}

function maskString(s) {
  return s.replace(CPF_VALUE, (m) => maskCpf(m)).replace(CNPJ_VALUE, (m) => maskCnpj(m)).replace(EMAIL_VALUE, (m) => maskEmail(m));
}

function maskValue(key, value, extra, state) {
  const nk = normKey(key);
  if (value !== null && typeof value === 'object') return walk(value, extra, state);
  if (value === null || value === undefined) return value;
  const rule = KEY_RULES.find(([re]) => re.test(nk));
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
