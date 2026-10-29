'use strict';

const { CODE_RE } = require('../agents/agents.constants');
const { loadPermissionCatalog } = require('../readmodels/permissionCatalog.readmodel');
const E = require('./serviceIdentities.errors');
const { MAX_PERMISSIONS, isReadOnlyPermission } = require('./serviceIdentities.constants');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function ctxOk(ctx) {
  if (!ctx || !ctx.groupId || !ctx.companyId) throw E.invalid('Contexto de empresa ausente.');
  if (!Array.isArray(ctx.permissions) || !ctx.permissions.includes('ai:admin')) throw E.denied();
}

/** Lista de permissões: texto, sem repetição, só de leitura e existente em core.permissions. */
async function parsePermissions(valor) {
  if (!Array.isArray(valor) || valor.length > MAX_PERMISSIONS) throw E.invalid('Informe a lista de permissões de leitura da identidade.');
  const lista = [];
  for (const item of valor) {
    if (typeof item !== 'string') throw E.invalid();
    const code = item.trim();
    if (!isReadOnlyPermission(code)) throw E.invalid();
    if (!lista.includes(code)) lista.push(code);
  }
  const catalogo = new Set(await loadPermissionCatalog());
  const faltando = lista.filter((c) => !catalogo.has(c));
  if (faltando.length) throw E.invalid('Esta permissão não existe no catálogo de permissões.', { permissions: faltando });
  return lista;
}

async function parseCreate(body) {
  if (!isObject(body)) throw E.invalid('Corpo inválido.');
  const agentCode = typeof body.agentCode === 'string' ? body.agentCode.trim().toUpperCase() : '';
  if (!CODE_RE.test(agentCode)) throw E.invalid('Código do agente inválido.');
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw E.invalid('O campo "enabled" deve ser verdadeiro ou falso.');
  return { agentCode, permissions: await parsePermissions(body.permissions), enabled: body.enabled !== false };
}

async function parseUpdate(body) {
  if (!isObject(body)) throw E.invalid('Corpo inválido.');
  const out = {};
  if (body.permissions !== undefined) out.permissions = await parsePermissions(body.permissions);
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw E.invalid('O campo "enabled" deve ser verdadeiro ou falso.');
    out.enabled = body.enabled;
  }
  if (!Object.keys(out).length) throw E.invalid('Informe o que alterar: permissions ou enabled.');
  return out;
}

const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

module.exports = { ctxOk, parseCreate, parseUpdate, isUuid };
