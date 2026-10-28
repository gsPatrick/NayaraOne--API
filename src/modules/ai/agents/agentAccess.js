'use strict';

const E = require('./agents.errors');
const repo = require('./agents.repository');
const { normalizeCode } = require('./agents.validation');

function ctxOk(ctx) {
  if (!ctx || !ctx.groupId || !ctx.companyId) throw E.invalid('Contexto de empresa ausente.');
}

function parseVersion(value) {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1) throw E.invalid('Número de versão inválido.');
  return n;
}

/** Versão da PRÓPRIA empresa (a que se pode alterar). Se só o padrão do sistema existe, avisa que ele não se altera. */
async function requireOwn(ctx, rawCode, rawVersion, transaction, { lock = false } = {}) {
  ctxOk(ctx);
  const code = normalizeCode(rawCode);
  const version = parseVersion(rawVersion);
  if (!code) throw E.notFound();
  const own = await repo.findOwn(ctx, code, version, transaction, { lock });
  if (own) return own;
  if (await repo.findSystem(code, version, transaction)) throw E.systemDefault();
  throw E.notFound();
}

module.exports = { ctxOk, parseVersion, requireOwn };
