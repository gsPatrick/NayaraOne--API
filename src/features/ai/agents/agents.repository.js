'use strict';

const { Op } = require('sequelize');
const { AiAgent, AiAgentTool, Permission } = require('../../../models');
const { acquireCodeLock } = require('../readmodels/agentSupport.readmodel');
const { toAgent, toTool } = require('./agents.mapper');

/** Acesso a ai.agents e ai.agent_tools pelos modelos. Sempre dentro da transação do tenant (RLS FORCE decide o que a empresa enxerga). */

const lockCode = (ctx, code, transaction) => acquireCodeLock(ctx.companyId, code, transaction);
const own = (ctx) => ({ companyId: ctx.companyId });
const lockOpt = (transaction, lock) => (lock ? { lock: transaction.LOCK.UPDATE } : {});

async function hydrate(models, transaction) {
  if (!models.length) return [];
  const tools = await AiAgentTool.findAll({ where: { agentId: models.map((m) => m.id) }, order: [['toolName', 'ASC']], transaction });
  const byAgent = new Map();
  for (const t of tools) {
    if (!byAgent.has(t.agentId)) byAgent.set(t.agentId, []);
    byAgent.get(t.agentId).push(toTool(t));
  }
  return models.map((m) => toAgent(m, byAgent.get(m.id) || []));
}

async function hydrateOne(model, transaction) {
  return model ? (await hydrate([model], transaction))[0] : null;
}

/** Versões da empresa e do padrão do sistema para o código; as da empresa primeiro, da mais nova para a mais antiga. */
async function listByCode(ctx, code, transaction) {
  const rows = await AiAgent.findAll({ where: { code, [Op.or]: [own(ctx), { companyId: null }] }, transaction });
  rows.sort((a, b) => (Number(a.companyId === null) - Number(b.companyId === null)) || (b.version - a.version));
  return hydrate(rows, transaction);
}

async function findOwn(ctx, code, version, transaction, { lock = false } = {}) {
  return hydrateOne(await AiAgent.findOne({ where: { code, version, ...own(ctx) }, transaction, ...lockOpt(transaction, lock) }), transaction);
}

async function findSystem(code, version, transaction) {
  return hydrateOne(await AiAgent.findOne({ where: { code, version, companyId: null }, transaction }), transaction);
}

async function latestVersionNumber(ctx, code, transaction) {
  return (await AiAgent.max('version', { where: { code, ...own(ctx) }, transaction })) || 0;
}

async function latestSystem(code, transaction) {
  return hydrateOne(await AiAgent.findOne({ where: { code, companyId: null }, order: [['version', 'DESC']], transaction }), transaction);
}

async function findByIdempotency(ctx, key, transaction) {
  return hydrateOne(await AiAgent.findOne({ where: { ...own(ctx), idempotencyKey: key }, transaction }), transaction);
}

async function insertAgent(ctx, v, transaction) {
  return AiAgent.create({
    groupId: ctx.groupId, companyId: ctx.companyId, code: v.code, version: v.version, status: 'DRAFT', purpose: v.purpose,
    systemPolicy: v.systemPolicy, modelPolicy: v.modelPolicy, dataScopes: v.dataScopes, limits: v.limits, criticality: v.criticality,
    enabled: false, configHash: v.configHash, idempotencyKey: v.idempotencyKey || null, createdFromVersion: v.createdFromVersion ?? null,
    createdBy: ctx.userId || null, updatedBy: ctx.userId || null,
  }, { transaction });
}

async function replaceTools(ctx, agent, tools, transaction) {
  await AiAgentTool.destroy({ where: { agentId: agent.id }, transaction });
  for (const t of tools) {
     
    await AiAgentTool.create({
      groupId: agent.groupId, companyId: agent.companyId, agentId: agent.id, toolName: t.toolName, permissionCode: t.permissionCode,
      riskLevel: t.riskLevel, requiresHumanApproval: t.requiresHumanApproval, enabled: t.enabled, createdBy: ctx.userId || null, updatedBy: ctx.userId || null,
    }, { transaction });
  }
}

const patch = (ctx, id, values, transaction) => AiAgent.update({ ...values, updatedBy: ctx.userId || null }, { where: { id }, transaction });

function updateDraftFields(ctx, id, v, transaction) {
  return patch(ctx, id, {
    purpose: v.purpose, systemPolicy: v.systemPolicy, modelPolicy: v.modelPolicy, dataScopes: v.dataScopes, limits: v.limits,
    criticality: v.criticality, configHash: v.configHash,
  }, transaction);
}

const updateHash = (ctx, id, hash, transaction) => patch(ctx, id, { configHash: hash }, transaction);

async function permissionExists(code, transaction) {
  return Boolean(await Permission.findOne({ where: { code }, attributes: ['id'], transaction }));
}

const markHomologated = (ctx, id, note, transaction) => patch(ctx, id, {
  status: 'HOMOLOGATED', homologatedBy: ctx.userId, homologatedAt: new Date(), homologationNote: note || null,
}, transaction);

const markActive = (ctx, id, transaction) => patch(ctx, id, { status: 'ACTIVE', enabled: true, activatedBy: ctx.userId, activatedAt: new Date() }, transaction);

const markRetired = (ctx, id, transaction) => patch(ctx, id, { status: 'RETIRED', enabled: false, retiredBy: ctx.userId || null, retiredAt: new Date() }, transaction);

/** Versão ACTIVE do código: a da empresa; senão a do sistema. */
async function findActiveFor(ctx, code, transaction) {
  const rows = await AiAgent.findAll({ where: { code, status: 'ACTIVE', [Op.or]: [own(ctx), { companyId: null }] }, transaction });
  rows.sort((a, b) => Number(a.companyId === null) - Number(b.companyId === null));
  return hydrateOne(rows[0], transaction);
}

/** Uma versão ACTIVE e habilitada por código (a da empresa vence a do sistema). */
async function listActive(ctx, transaction) {
  const rows = await AiAgent.findAll({ where: { status: 'ACTIVE', enabled: true, [Op.or]: [own(ctx), { companyId: null }] }, order: [['code', 'ASC']], transaction });
  const chosen = new Map();
  for (const r of rows) if (!chosen.has(r.code) || r.companyId !== null) chosen.set(r.code, r);
  return hydrate([...chosen.values()], transaction);
}

async function findOwnById(ctx, id, transaction) {
  return hydrateOne(await AiAgent.findOne({ where: { id, ...own(ctx) }, transaction }), transaction);
}

/** Ids das versões ACTIVE da empresa para o código, travadas até o fim da transação. */
async function activeOwnRowIds(ctx, code, transaction) {
  const rows = await AiAgent.findAll({ where: { code, status: 'ACTIVE', ...own(ctx) }, attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
  return rows.map((r) => r.id);
}

module.exports = {
  lockCode, listByCode, findOwn, findSystem, latestVersionNumber, latestSystem, findByIdempotency, insertAgent, replaceTools,
  updateDraftFields, updateHash, permissionExists, markHomologated, markActive, markRetired, findActiveFor, listActive, activeOwnRowIds, findOwnById,
};
