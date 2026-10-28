'use strict';

const { PUBLIC_FIELDS_DEFAULTS, PUBLIC_FIELDS_ALLOWLIST_KEY, PUBLIC_FIELDS_FEATURES_KEY, parseList } = require('./publicFields.settings');
const { mktError } = require('../marketing.errors');
const { SOURCES } = require('../../../shared/redaction');

/**
 * M9-D403 — sanitizePublicFields(payload, policy, options): função PURA e determinística (não muta a entrada, sem relógio nem
 * rede). Tudo que sai da empresa para o mundo passa por aqui (MKT-002/003):
 *  1. remove toda chave fora da allowlist;
 *  2. aplica a política de endereço (reduz ou apaga logradouro, número e bairro) e recompõe `enderecoPublico`;
 *  3. remove qualquer chave cujo nome contenha termo interno (ocorrência, documento, matrícula, cpf, cnpj, proprietário...);
 *  4. varre os textos livres e redige CPF, CNPJ, e-mail, telefone e número de matrícula com [REDIGIDO];
 *  5. devolve removedKeys e redactedPatterns para o checks_json da versão do conteúdo.
 * As chaves proibidas do passo 3 são regra do livro (não configuráveis: afrouxá-las abriria vazamento); a allowlist e as
 * características permitidas vêm da configuração da empresa (options).
 */
const REDACTION_MARKER = '[REDIGIDO]';
const ADDRESS_POLICIES = Object.freeze(['COMPLETO', 'RUA_SEM_NUMERO', 'SO_BAIRRO', 'OCULTO']);
const DEFAULT_ADDRESS_POLICY = 'SO_BAIRRO';
const HIDDEN_ADDRESS_TEXT = 'Endereço sob consulta';

const FORBIDDEN_KEY_TERMS = Object.freeze([
  'ocorrencia', 'occurrence', 'internal', 'interno', 'documento', 'document', 'matricula', 'cpf', 'cnpj', 'owner',
  'proprietario', 'observacaointerna',
]);

/** Padrões na ordem de aplicação (o mais específico primeiro, para um CNPJ não ser lido como CPF). */
const PII_PATTERNS = Object.freeze([
  { name: 'CNPJ', re: new RegExp(`(?<!\\d)${SOURCES.cnpjLoose}(?!\\d)`, 'g') },
  { name: 'CPF', re: new RegExp(`(?<!\\d)${SOURCES.cpfLoose}(?!\\d)`, 'g') },
  { name: 'EMAIL', re: new RegExp(SOURCES.email, 'g') },
  { name: 'TELEFONE', re: new RegExp(`${SOURCES.phone}|${SOURCES.localPhone}`, 'g') },
  { name: 'MATRICULA', re: /(matr[íi]cula(?:\s+(?:n[º°o.]*|n[úu]mero))?\s*[:#-]?\s*)(?=[\w./-]*\d)[\w./-]{3,}/gi, keep: 1 },
]);

/** Campos que carregam identificadores e datas, nunca texto livre: não passam pela varredura de PII. */
const NO_SCAN_KEYS = new Set(['publicId', 'fotosAutorizadas', 'publicadoEm', 'uf']);

function normalizeKey(key) {
  return String(key).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isForbiddenKey(key) {
  const flat = normalizeKey(key);
  return FORBIDDEN_KEY_TERMS.some((term) => flat.includes(term));
}

/** Política ausente = SO_BAIRRO (padrão conservador); valor desconhecido = OCULTO (falha fechada). */
function resolveAddressPolicy(policy) {
  if (policy === undefined || policy === null || policy === '') return DEFAULT_ADDRESS_POLICY;
  const normalized = String(policy).toUpperCase();
  return ADDRESS_POLICIES.includes(normalized) ? normalized : 'OCULTO';
}

function redactText(text, hits) {
  let out = text;
  for (const { name, re, keep } of PII_PATTERNS) {
    out = out.replace(re, (...args) => {
      hits[name] = (hits[name] || 0) + 1;
      return keep ? `${args[keep]}${REDACTION_MARKER}` : REDACTION_MARKER;
    });
  }
  return out;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Remove (e registra) do nó os campos de endereço que a política não permite. */
function applyAddressPolicy(node, policy, path, removed) {
  const drop = { COMPLETO: [], RUA_SEM_NUMERO: ['numeroEndereco'], SO_BAIRRO: ['logradouro', 'numeroEndereco'], OCULTO: ['logradouro', 'numeroEndereco', 'bairro'] }[policy];
  for (const key of drop) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      delete node[key];
      removed.add(path ? `${path}.${key}` : key);
    }
  }
}

/** Texto público do endereço derivado SÓ do que a política deixou no nó. */
function buildPublicAddress(node, policy) {
  if (policy === 'OCULTO') return HIDDEN_ADDRESS_TEXT;
  const street = [node.logradouro, node.numeroEndereco].filter((v) => v !== undefined && v !== null && String(v).trim() !== '').join(', ');
  const place = [node.cidade, node.uf].filter((v) => v !== undefined && v !== null && String(v).trim() !== '').join('/');
  const text = [street, node.bairro, place].filter((v) => v && String(v).trim() !== '').join(' - ');
  return text || null;
}

function sanitizeNode(value, ctx, path) {
  if (typeof value === 'string') return redactText(value, ctx.hits);
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeNode(item, ctx, `${path}[${index}]`));
  }
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value)) {
    const keyPath = path ? `${path}.${key}` : key;
    if (isForbiddenKey(key) || !ctx.allow.has(key)) {
      ctx.removed.add(keyPath);
    } else if (NO_SCAN_KEYS.has(key)) {
      out[key] = Array.isArray(value[key]) ? [...value[key]] : value[key];
    } else if (key === 'enderecoPublico') {
      continue; // recomposto abaixo, sempre a partir do que a política deixou
    } else if (key === 'features' && Array.isArray(value[key])) {
      out[key] = value[key].filter((feature) => {
        const keep = typeof feature === 'string' && ctx.features.has(feature.trim().toLowerCase());
        if (!keep) ctx.removed.add(`${keyPath}[${String(feature)}]`);
        return keep;
      });
    } else {
      out[key] = sanitizeNode(value[key], ctx, keyPath);
    }
  }
  applyAddressPolicy(out, ctx.policy, path, ctx.removed);
  const hasAddress = ['logradouro', 'numeroEndereco', 'bairro', 'cidade', 'uf'].some((k) => k in out)
    || Object.prototype.hasOwnProperty.call(value, 'enderecoPublico');
  if (hasAddress && ctx.allow.has('enderecoPublico')) {
    const text = buildPublicAddress(out, ctx.policy);
    if (text) out.enderecoPublico = redactText(text, ctx.hits);
  }
  return out;
}

/**
 * @param {object} payload       dado bruto (nunca é alterado)
 * @param {string} [policy]      COMPLETO | RUA_SEM_NUMERO | SO_BAIRRO | OCULTO (ausente = SO_BAIRRO)
 * @param {object} [options]     { allowlist: string[], featuresPermitidas: string[] } (padrão: o do catálogo)
 * @returns {{payload, policy, removedKeys: string[], redactedPatterns: string[], redactedCount: number}}
 */
function sanitizePublicFields(payload, policy, options = {}) {
  const resolved = resolveAddressPolicy(policy);
  const allowlist = options.allowlist || parseList(PUBLIC_FIELDS_DEFAULTS[PUBLIC_FIELDS_ALLOWLIST_KEY]);
  const features = options.featuresPermitidas || parseList(PUBLIC_FIELDS_DEFAULTS[PUBLIC_FIELDS_FEATURES_KEY]);
  const ctx = {
    policy: resolved,
    allow: new Set(allowlist),
    features: new Set(features.map((f) => f.toLowerCase())),
    removed: new Set(),
    hits: {},
  };
  const clean = isPlainObject(payload) ? sanitizeNode(payload, ctx, '') : {};
  const patterns = Object.keys(ctx.hits).sort();
  return {
    payload: clean,
    policy: resolved,
    removedKeys: [...ctx.removed].sort(),
    redactedPatterns: patterns,
    redactedCount: patterns.reduce((sum, name) => sum + ctx.hits[name], 0),
  };
}

/**
 * Campos mínimos do tipo de conteúdo (cada tipo declara os seus em M9-D409). Um item "a|b" aceita qualquer um dos dois.
 * Sem eles: 422 MKT_PUBLIC_FIELDS_INSUFFICIENT (o conteúdo vai para FACT_CHECK_FAILED).
 */
function missingMinimumFields(payload, requiredFields) {
  const filled = (v) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '') && !(Array.isArray(v) && v.length === 0);
  return (requiredFields || []).filter((rule) => !String(rule).split('|').some((name) => filled(payload && payload[name.trim()])));
}

function assertMinimumPublicFields(payload, requiredFields) {
  const missing = missingMinimumFields(payload, requiredFields);
  if (missing.length > 0) {
    throw mktError(422, 'MKT_PUBLIC_FIELDS_INSUFFICIENT', 'Faltam dados publicáveis para este tipo de conteúdo.', { missing });
  }
}

module.exports = {
  REDACTION_MARKER,
  ADDRESS_POLICIES,
  DEFAULT_ADDRESS_POLICY,
  HIDDEN_ADDRESS_TEXT,
  FORBIDDEN_KEY_TERMS,
  resolveAddressPolicy,
  sanitizePublicFields,
  missingMinimumFields,
  assertMinimumPublicFields,
};
