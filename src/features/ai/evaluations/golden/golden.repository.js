'use strict';

const { Op } = require('sequelize');
const { AiGoldenCase, AiGoldenCandidate } = require('../../../../models');

/** Acesso a ai.golden_cases pelo modelo. Sempre na transação do tenant: a RLS FORCE mostra os casos da empresa e os do sistema. */
const scope = (ctx) => ({ [Op.or]: [{ companyId: ctx.companyId }, { companyId: null }] });

const toCase = (m) => {
  const c = typeof m.get === 'function' ? m.get({ plain: true }) : m;
  return {
    id: c.id, scope: c.companyId ? 'COMPANY' : 'SYSTEM', agentCode: c.agentCode, caseKey: c.caseKey, category: c.category, input: c.input, fixtures: c.fixtures,
    expected: c.expected, mustNot: c.mustNot, version: c.version, status: c.status, sourceCandidateId: c.sourceCandidateId, createdBy: c.createdBy,
    createdAt: c.created_at ? new Date(c.created_at).toISOString() : null, retiredBy: c.retiredBy, retiredAt: c.retiredAt ? new Date(c.retiredAt).toISOString() : null,
  };
};

/** Casos ACTIVE do agente: os da empresa e os do sistema; o da empresa com a mesma chave vence o do sistema. */
async function activeFor(ctx, agentCode, transaction) {
  const rows = await AiGoldenCase.findAll({ where: { agentCode, status: 'ACTIVE', ...scope(ctx) }, order: [['case_key', 'ASC']], transaction });
  const byKey = new Map();
  for (const r of rows) if (!byKey.has(r.caseKey) || r.companyId) byKey.set(r.caseKey, r);
  return [...byKey.values()].map(toCase);
}

const listFor = async (ctx, agentCode, transaction) => (await AiGoldenCase.findAll({
  where: { agentCode, ...scope(ctx) }, order: [['case_key', 'ASC'], ['version', 'ASC']], transaction,
})).map(toCase);

const findOwnActive = (ctx, agentCode, caseKey, transaction, { lock = false } = {}) => AiGoldenCase.findOne({
  where: { agentCode, caseKey, status: 'ACTIVE', companyId: ctx.companyId }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
});

const latestVersion = async (ctx, agentCode, caseKey, transaction) => (await AiGoldenCase.max('version', { where: { agentCode, caseKey, companyId: ctx.companyId }, transaction })) || 0;

const countActiveOwn = (ctx, agentCode, transaction) => AiGoldenCase.count({ where: { agentCode, status: 'ACTIVE', companyId: ctx.companyId }, transaction });

const insertCase = (ctx, data, transaction) => AiGoldenCase.create({
  groupId: ctx.groupId, companyId: ctx.companyId, agentCode: data.agentCode, caseKey: data.caseKey, category: data.category, input: data.input,
  fixtures: data.fixtures, expected: data.expected, mustNot: data.mustNot, version: data.version, status: 'ACTIVE',
  sourceCandidateId: data.sourceCandidateId || null, createdBy: ctx.userId || null,
}, { transaction });

/** Autores (pessoas) dos casos ativos da empresa para o agente: quem os alterou não homologa a versão. */
async function activeAuthors(ctx, agentCode, transaction) {
  const rows = await AiGoldenCase.findAll({ where: { agentCode, status: 'ACTIVE', companyId: ctx.companyId }, attributes: ['createdBy'], transaction });
  return new Set(rows.map((r) => r.createdBy).filter(Boolean));
}

/** Quem aposentou casos da empresa para o agente (também é alteração do dataset). */
async function retiredAuthors(ctx, agentCode, transaction) {
  const rows = await AiGoldenCase.findAll({ where: { agentCode, status: 'RETIRED', companyId: ctx.companyId, retiredBy: { [Op.ne]: null } }, attributes: ['retiredBy'], transaction });
  return new Set(rows.map((r) => r.retiredBy));
}

const findBySource = (candidateId, transaction) => AiGoldenCase.findOne({ where: { sourceCandidateId: candidateId }, attributes: ['id'], transaction });

const findCandidate = (ctx, id, transaction) => AiGoldenCandidate.findOne({ where: { id, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });

module.exports = { toCase, activeFor, listFor, findOwnActive, latestVersion, countActiveOwn, insertCase, activeAuthors, retiredAuthors, findBySource, findCandidate };
