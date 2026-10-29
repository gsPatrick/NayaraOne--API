'use strict';

const E = require('./agents.errors');
const repo = require('./agents.repository');
const { computeConfigHash } = require('./agentConfigHash');
const { auditAgent } = require('./agentAudit');
const { ctxOk, requireOwn } = require('./agentAccess');
const { assertAgentPairEvaluated } = require('../regression/regression.gate');
const { withoutPolicy } = require('./agents.mapper');
const {
  validateCode, normalizeCode, validateAgentFields, validateTools, validateIdempotencyKey, validatePurpose,
} = require('./agents.validation');

/** Versões de agente (M9-D004): criar, editar o DRAFT, trocar a allowlist e consultar. O ciclo de estados é de agentLifecycle.service.js. */

async function assertPermissionsExist(tools, transaction) {
  for (const t of tools) {
    if (!(await repo.permissionExists(t.permissionCode, transaction))) {
      throw E.toolInvalid(`A permissão "${t.permissionCode}" da ferramenta ${t.toolName} não existe no catálogo.`, { tool: t.toolName });
    }
  }
}

async function pickBase(ctx, code, copyFrom, transaction) {
  if (copyFrom !== undefined && copyFrom !== null) {
    if (!Number.isInteger(copyFrom) || copyFrom < 1) throw E.invalid('copyFromVersion deve ser um inteiro positivo.');
    const base = (await repo.findOwn(ctx, code, copyFrom, transaction)) || (await repo.findSystem(code, copyFrom, transaction));
    if (!base) throw E.notFound();
    return base;
  }
  const own = await repo.listByCode(ctx, code, transaction);
  const proprias = own.filter((a) => a.companyId);
  if (proprias.length) return proprias[0];
  return repo.latestSystem(code, transaction);
}

const CAMPOS = ['purpose', 'systemPolicy', 'modelPolicy', 'dataScopes', 'limits', 'criticality'];

function mergeFields(base, overrides) {
  const fromBase = base ? Object.fromEntries(CAMPOS.map((k) => [k, base[k]])) : { systemPolicy: '', modelPolicy: {}, dataScopes: [], limits: {} };
  const merged = { ...fromBase, ...overrides };
  merged.purpose = validatePurpose(merged.purpose);
  if (!merged.criticality) throw E.invalid('Informe a criticidade do agente (CRITICAL ou NON_CRITICAL).');
  return merged;
}

/** Cria a próxima versão da empresa em DRAFT, copiando a mais recente (ou a indicada, ou o padrão do sistema) e aplicando o payload. */
async function createVersion(ctx, rawCode, payload, transaction) {
  ctxOk(ctx);
  const code = validateCode(rawCode);
  const body = payload || {};
  const idempotencyKey = validateIdempotencyKey(body.idempotencyKey);
  const overrides = validateAgentFields(body);
  await repo.lockCode(ctx, code, transaction);
  if (idempotencyKey) {
    const previous = await repo.findByIdempotency(ctx, idempotencyKey, transaction);
    if (previous) return { ...previous, replay: true };
  }
  const base = await pickBase(ctx, code, body.copyFromVersion, transaction);
  const fields = mergeFields(base, overrides);
  // Trocar provider ou modelo em relação à versão de origem exige a regressão do novo par (M9-D033) antes de gravar.
  await assertAgentPairEvaluated(ctx, code, base ? base.modelPolicy : fields.modelPolicy, fields.modelPolicy, transaction);
  const tools = body.tools !== undefined ? validateTools(body.tools) : (base ? base.tools.map((t) => ({ ...t })) : []);
  await assertPermissionsExist(tools, transaction);
  const version = (await repo.latestVersionNumber(ctx, code, transaction)) + 1;
  const configHash = computeConfigHash({ code, ...fields, tools });
  const row = await repo.insertAgent(ctx, {
    code, version, ...fields, configHash, idempotencyKey, createdFromVersion: base ? base.version : null,
  }, transaction);
  await repo.replaceTools(ctx, row, tools, transaction);
  const created = await repo.findOwn(ctx, code, version, transaction);
  await auditAgent(ctx, 'ai.agent.version.created', created, null, `Nova versão ${version} do agente ${code}${base ? ` a partir da versão ${base.version} (${base.companyId ? 'da empresa' : 'padrão do sistema'})` : ''}.`, transaction);
  return created;
}

/** Edita campos de uma versão em DRAFT; fora de DRAFT é 409 AI_AGENT_IMMUTABLE (o banco repete a regra por gatilho). */
async function updateDraft(ctx, rawCode, rawVersion, patch, transaction) {
  ctxOk(ctx);
  const code = normalizeCode(rawCode);
  if (code) await repo.lockCode(ctx, code, transaction);
  const current = await requireOwn(ctx, rawCode, rawVersion, transaction, { lock: true });
  if (current.status !== 'DRAFT') throw E.immutable();
  const overrides = validateAgentFields(patch || {});
  if (!Object.keys(overrides).length) return current;
  const fields = { ...Object.fromEntries(CAMPOS.map((k) => [k, current[k]])), ...overrides };
  await assertAgentPairEvaluated(ctx, current.code, current.modelPolicy, fields.modelPolicy, transaction);
  const configHash = computeConfigHash({ code: current.code, ...fields, tools: current.tools });
  await repo.updateDraftFields(ctx, current.id, { ...fields, configHash }, transaction);
  const updated = await repo.findOwn(ctx, current.code, current.version, transaction);
  await auditAgent(ctx, 'ai.agent.version.updated', updated, current, `Versão ${current.version} do agente ${current.code} editada em DRAFT.`, transaction);
  return updated;
}

/** Troca a allowlist inteira de uma versão em DRAFT (permission_code vem da definição enviada e deve existir no catálogo). */
async function setTools(ctx, rawCode, rawVersion, rawTools, transaction) {
  ctxOk(ctx);
  const code = normalizeCode(rawCode);
  if (code) await repo.lockCode(ctx, code, transaction);
  const current = await requireOwn(ctx, rawCode, rawVersion, transaction, { lock: true });
  if (current.status !== 'DRAFT') throw E.immutable();
  const tools = validateTools(rawTools);
  await assertPermissionsExist(tools, transaction);
  await repo.replaceTools(ctx, { id: current.id, group_id: current.groupId, company_id: current.companyId }, tools, transaction);
  await repo.updateHash(ctx, current.id, computeConfigHash({ ...current, tools }), transaction);
  const updated = await repo.findOwn(ctx, current.code, current.version, transaction);
  await auditAgent(ctx, 'ai.agent.tools.replaced', updated, current, `Allowlist da versão ${current.version} do agente ${current.code} trocada.`, transaction);
  return updated;
}

async function listVersions(ctx, rawCode, transaction) {
  ctxOk(ctx);
  const code = normalizeCode(rawCode);
  return code ? repo.listByCode(ctx, code, transaction) : [];
}

/** Versão da empresa; se a empresa não tem, o padrão do sistema com o mesmo número. */
async function getVersion(ctx, rawCode, rawVersion, transaction) {
  ctxOk(ctx);
  const code = normalizeCode(rawCode);
  const version = Number(rawVersion);
  if (!code || !Number.isInteger(version) || version < 1) throw E.notFound();
  const found = (await repo.findOwn(ctx, code, version, transaction)) || (await repo.findSystem(code, version, transaction));
  if (!found) throw E.notFound();
  return found;
}

/** Agentes em uso (uma versão ACTIVE e habilitada por código) para quem tem só ai:use; sem o texto da política. */
async function listActiveAgents(ctx, transaction) {
  ctxOk(ctx);
  return (await repo.listActive(ctx, transaction)).map(withoutPolicy);
}

module.exports = { createVersion, updateDraft, setTools, listVersions, getVersion, listActiveAgents };
