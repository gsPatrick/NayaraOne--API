'use strict';

const { ENVIRONMENTS } = require('../finops.constants');
const E = require('./budget.errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/** Valor em centavos inteiros e maior que zero (texto numérico inteiro também vale). Nada de ponto flutuante nem fração de centavo. */
function parseAmount(value) {
  const ok = (typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && /^\d{1,15}$/.test(value.trim()));
  const n = ok ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw E.amountInvalid();
  return n;
}

function parseOwner(value) {
  if (value === undefined || value === null || value === '') throw E.ownerRequired();
  if (!isUuid(value)) throw E.ownerInvalid();
  return value;
}

/** Ambiente e domínio do escopo; sem ambiente vale o da instalação, sem domínio vale PLATFORM. `domains` = domínios aceitos. */
function parseScope(body, { defaultEnvironment, domains }) {
  const environment = String(body.environment || defaultEnvironment).toUpperCase();
  const domain = String(body.domain || 'PLATFORM').trim();
  if (!ENVIRONMENTS.includes(environment)) throw E.scopeInvalid(`Ambiente desconhecido: ${environment}.`, { allowed: ENVIRONMENTS });
  if (!domains.includes(domain)) throw E.scopeInvalid(`Domínio desconhecido: ${domain}.`, { allowed: domains });
  return { environment, domain };
}

module.exports = { parseAmount, parseOwner, parseScope, isUuid };
