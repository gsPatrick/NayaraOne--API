'use strict';

const { rx, onlyDigits, luhnValid, cpfValid, cnpjValid } = require('./patterns');

const REDACTED = '[REDACTED]';

/** Máscaras do perfil de log (M9-D246 3.1 b). */
function maskCpf(value) {
  const d = onlyDigits(value);
  return /\D/.test(value) ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : `***${d.slice(3, 9)}**`;
}

function maskCnpj(value) {
  const d = onlyDigits(value);
  return /\D/.test(value) ? `**.***.***/${d.slice(8, 12)}-**` : `********${d.slice(8, 12)}**`;
}

function maskEmail(value) {
  const at = value.lastIndexOf('@');
  return `${value[0]}***${value.slice(at)}`;
}

/** Telefone: mantém só os 2 últimos dígitos. */
function maskPhone(value) {
  const total = onlyDigits(value).length;
  let seen = 0;
  return value.replace(/\d/g, (digit) => { seen += 1; return seen > total - 2 ? digit : '*'; });
}

/** Cada regra: expressão, validador opcional e a troca. Ordem importa (o mais específico primeiro). */
const SECRET_RULES = [
  () => [rx('pem'), null, REDACTED],
  () => [rx('jwt'), null, REDACTED],
  () => [rx('bearer', 'gi'), null, REDACTED],
  () => [rx('connectionPassword', 'gi'), null, (m, a, _p, c) => `${a}${REDACTED}${c}`],
  () => [rx('assignment', 'gi'), null, (m, k, sep) => `${k}${sep}${REDACTED}`],
  // "token SECRET-CANARY-7f3a": palavra de credencial seguida de valor com cara de segredo (dígito, hífen ou sublinhado).
  () => [rx('keywordValue', 'gi'), (m) => /[\d_-]/.test(m.replace(/^\S+\s+/, '')), (m, k, sep) => `${k}${sep}${REDACTED}`],
  () => [rx('awsKey'), null, REDACTED],
  () => [rx('providerKey'), null, REDACTED],
  () => [rx('slackToken'), null, REDACTED],
  () => [rx('githubToken'), null, REDACTED],
  () => [rx('openAiKey', 'gi'), null, REDACTED],
];

const PII_RULES = [
  () => [rx('cnpjFormatted'), null, maskCnpj],
  () => [rx('cnpjBare'), cnpjValid, maskCnpj],
  () => [rx('cpfFormatted'), null, maskCpf],
  () => [rx('cpfBare'), cpfValid, maskCpf],
  () => [rx('cardCandidate'), luhnValid, REDACTED],
  () => [rx('email'), null, maskEmail],
  () => [rx('phone'), null, maskPhone],
];

function apply(text, rules) {
  let out = text;
  for (const make of rules) {
    const [re, validate, swap] = make();
    out = out.replace(re, (...args) => {
      const match = args[0];
      if (validate && !validate(match)) return match;
      return typeof swap === 'function' ? swap(...args) : swap;
    });
  }
  return out;
}

/**
 * redactText(texto, { secretsOnly }) — perfil de log: segredos viram `[REDACTED]`; documentos, e-mail e telefone
 * são mascarados. `secretsOnly` (auditoria, resposta de erro) mantém os dados pessoais e remove só segredo.
 */
function redactText(text, { secretsOnly = false } = {}) {
  if (typeof text !== 'string' || text.length === 0) return text;
  const semSegredo = apply(text, SECRET_RULES);
  return secretsOnly ? semSegredo : apply(semSegredo, PII_RULES);
}

module.exports = { redactText, maskCpf, maskCnpj, maskEmail, maskPhone, REDACTED };
