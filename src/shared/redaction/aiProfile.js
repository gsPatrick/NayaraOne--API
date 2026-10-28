'use strict';

const { rx, luhnValid, cpfValid, cnpjValid } = require('./patterns');
const { isSensitiveKey } = require('./keys');

/**
 * Perfil `ai` da biblioteca única de redaction (M9-D027). A NAY troca cada dado pessoal ou segredo por `[REDIGIDO:tipo]`
 * antes de qualquer texto sair para um provider de modelo, entrar em log, resumo, argumento de tool ou trecho de fonte.
 * Não há detecção própria aqui: só as expressões de ./patterns, com a mesma validação (dígito verificador, Luhn).
 *
 * `placeholderFor(tipo, valor, { reversible })` decide o texto da troca; o padrão é `[REDIGIDO:tipo]`. O mapa do run
 * (src/features/ai/security/redactionMap.js) usa esse gancho para dar nomes distintos a valores distintos e permitir a
 * re-hidratação em memória. Segredo (reversible=false) nunca chega ao mapa.
 */
const PLACEHOLDER_TYPES = Object.freeze([
  'cpf', 'cnpj', 'rg', 'email', 'telefone', 'cep', 'endereco', 'cartao', 'conta', 'agencia', 'pix', 'boleto', 'token', 'senha', 'segredo', 'restrito',
]);
const SECRET_TYPES = Object.freeze(['token', 'senha', 'segredo', 'restrito']);

const defaultPlaceholder = (tipo) => `[REDIGIDO:${tipo}]`;
const SENHA = /senha|passw|segredo|secret/i;

/**
 * Cada regra: [padrão, flags, validador, tipo, grupoDoValor]. `grupoDoValor` > 0: o texto antes dele (rótulo) é mantido e só
 * o valor é trocado. `tipo` pode ser função da correspondência.
 */
const RULES = [
  ['pem', 'g', null, 'token', 0],
  ['jwt', 'g', null, 'token', 0],
  ['bearer', 'gi', null, 'token', 0],
  ['connectionPassword', 'gi', null, 'senha', 2],
  ['assignment', 'gi', null, (m) => (SENHA.test(m[1]) ? 'senha' : 'token'), 3],
  ['keywordValue', 'gi', (m) => /[\d_-]/.test(m[3]), (m) => (SENHA.test(m[1]) ? 'senha' : 'token'), 3],
  ['awsKey', 'g', null, 'token', 0],
  ['providerKey', 'g', null, 'token', 0],
  ['slackToken', 'g', null, 'token', 0],
  ['githubToken', 'g', null, 'token', 0],
  ['openAiKey', 'gi', null, 'token', 0],
  ['pixLabeled', 'gi', (m) => /[\d@]/.test(m[2]), 'pix', 2],
  ['boletoFormatted', 'g', null, 'boleto', 0],
  ['boletoDigits', 'g', null, 'boleto', 0],
  ['cnpjFormatted', 'g', (m) => cnpjValid(m[0]), 'cnpj', 0],
  ['cnpjBare', 'g', (m) => cnpjValid(m[0]), 'cnpj', 0],
  ['cpfFormatted', 'g', (m) => cpfValid(m[0]), 'cpf', 0],
  ['cpfBare', 'g', (m) => cpfValid(m[0]), 'cpf', 0],
  ['cardCandidate', 'g', (m) => luhnValid(m[0]), 'cartao', 0],
  ['rgLabeled', 'gi', null, 'rg', 2],
  ['rgFormatted', 'g', null, 'rg', 0],
  ['agencyLabeled', 'gi', null, 'agencia', 2],
  ['accountLabeled', 'gi', null, 'conta', 2],
  ['addressPattern', 'gi', null, 'endereco', 0],
  ['cepFormatted', 'g', null, 'cep', 0],
  ['cepLabeled', 'gi', null, 'cep', 2],
  ['email', 'g', null, 'email', 0],
  ['phone', 'g', null, 'telefone', 0],
];

function applyRule(texto, [nome, flags, validate, tipo, grupo], placeholderFor) {
  return texto.replace(rx(nome, flags), (...args) => {
    const groups = args.slice(0, args.findIndex((a) => typeof a === 'number'));
    if (validate && !validate(groups)) return groups[0];
    const t = typeof tipo === 'function' ? tipo(groups) : tipo;
    const valor = groups[grupo];
    const troca = placeholderFor(t, valor, { reversible: !SECRET_TYPES.includes(t) });
    if (grupo === 0) return troca;
    return groups[0].replace(valor, () => troca);
  });
}

/** redactForAi(texto, { placeholderFor }) — troca dado pessoal e segredo por `[REDIGIDO:tipo]`; o resto do texto fica igual. */
function redactForAi(texto, { placeholderFor = defaultPlaceholder } = {}) {
  if (typeof texto !== 'string' || texto.length === 0) return texto;
  return RULES.reduce((acc, regra) => applyRule(acc, regra, placeholderFor), texto);
}

const MAX_DEPTH = 12;

/** redactDeepForAi(valor, opções) — cópia do valor sem dado pessoal/segredo: chave sensível vira `[REDIGIDO:segredo]`; número com cara de documento também. */
function redactDeepForAi(valor, options = {}, depth = 0) {
  if (valor === null || valor === undefined) return valor;
  if (typeof valor === 'string') return redactForAi(valor, options);
  if (typeof valor === 'number' || typeof valor === 'bigint') {
    const s = String(valor);
    const r = redactForAi(s, options);
    return r === s ? valor : r;
  }
  if (typeof valor !== 'object') return typeof valor === 'function' ? undefined : valor;
  if (Buffer.isBuffer(valor)) return `[Buffer ${valor.length} bytes]`;
  if (depth >= MAX_DEPTH) return '[Circular]';
  if (valor instanceof Date) return valor.toISOString();
  if (typeof valor.toJSON === 'function') return redactDeepForAi(valor.toJSON(), options, depth + 1);
  if (Array.isArray(valor)) return valor.map((item) => redactDeepForAi(item, options, depth + 1));
  const out = {};
  for (const [chave, interno] of Object.entries(valor)) {
    out[chave] = isSensitiveKey(chave) && interno !== null && interno !== undefined
      ? (options.placeholderFor || defaultPlaceholder)('segredo', String(interno), { reversible: false })
      : redactDeepForAi(interno, options, depth + 1);
  }
  return out;
}

module.exports = { redactForAi, redactDeepForAi, PLACEHOLDER_TYPES, SECRET_TYPES };
