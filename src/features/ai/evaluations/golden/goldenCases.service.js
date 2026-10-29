'use strict';

const E = require('./golden.errors');
const V = require('./golden.validation');
const K = require('./golden.constants');
const repo = require('./golden.repository');
const { recordChange } = require('./golden.events');
const { getSetting } = require('../../../settings/settings.service');
const { REGRESSION_KEYS: R, REGRESSION_SETTING_DEFAULTS: D } = require('../../regression/regression.settings');
const agentRepo = require('../../agents/agents.repository');

const ctxOk = (ctx) => { if (!ctx || !ctx.groupId || !ctx.companyId) throw E.invalid('Contexto de empresa ausente.'); };

async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    throw E.fromDbError(err) || err;
  }
}

/** Grava a versão seguinte do caso (a anterior ACTIVE da empresa é aposentada antes, na mesma transação). */
async function writeNextVersion(ctx, data, reasonPrefix, transaction) {
  const previous = await repo.findOwnActive(ctx, data.agentCode, data.caseKey, transaction, { lock: true });
  if (previous) {
    const before = repo.toCase(previous);
    previous.status = 'RETIRED';
    previous.retiredBy = ctx.userId || null;
    previous.retiredAt = new Date();
    await previous.save({ transaction });
    await recordChange(ctx, { action: 'ai.golden_case.retired', eventType: K.EVENTS.retired, before, after: repo.toCase(previous), reason: `Caso ${data.caseKey} do agente ${data.agentCode} aposentado pela versão seguinte.` }, transaction);
  } else {
    const max = await getSetting(R.maxCasesPerAgent, ctx, transaction, D[R.maxCasesPerAgent]);
    if ((await repo.countActiveOwn(ctx, data.agentCode, transaction)) >= max) throw E.limit();
  }
  const version = (await repo.latestVersion(ctx, data.agentCode, data.caseKey, transaction)) + 1;
  const row = await repo.insertCase(ctx, { ...data, version }, transaction);
  const created = repo.toCase(row);
  await recordChange(ctx, { action: 'ai.golden_case.created', eventType: K.EVENTS.created, before: null, after: created, reason: `${reasonPrefix} ${data.caseKey} (versão ${version}) do agente ${data.agentCode}.` }, transaction);
  return created;
}

/**
 * Cria o caso (ou a versão seguinte, se a chave já existe na empresa). O golden é do agente: a empresa precisa ter alguma versão
 * dele. Dados sempre sintéticos (D027). Quem altera o golden não homologa a versão (ver segregação em regression/goldenAuthors).
 */
async function saveCase(ctx, rawAgentCode, body, transaction) {
  ctxOk(ctx);
  const agentCode = V.parseAgentCode(rawAgentCode);
  const data = { agentCode, ...V.parseCaseBody(body) };
  return guarded(async () => {
    if (!(await agentRepo.listByCode(ctx, agentCode, transaction)).length) throw E.invalid('Agente não encontrado.');
    return writeNextVersion(ctx, data, 'Caso de teste', transaction);
  });
}

/** Aposenta o caso ACTIVE da empresa (o histórico fica; o caso do sistema não se aposenta pela empresa). */
async function retireCase(ctx, rawAgentCode, caseKey, transaction) {
  ctxOk(ctx);
  const agentCode = V.parseAgentCode(rawAgentCode);
  return guarded(async () => {
    const row = await repo.findOwnActive(ctx, agentCode, String(caseKey || ''), transaction, { lock: true });
    if (!row) throw E.notFound();
    const before = repo.toCase(row);
    row.status = 'RETIRED';
    row.retiredBy = ctx.userId || null;
    row.retiredAt = new Date();
    await row.save({ transaction });
    const after = repo.toCase(row);
    await recordChange(ctx, { action: 'ai.golden_case.retired', eventType: K.EVENTS.retired, before, after, reason: `Caso ${caseKey} do agente ${agentCode} aposentado.` }, transaction);
    return after;
  });
}

const listCases = async (ctx, rawAgentCode, { history = false } = {}, transaction) => {
  ctxOk(ctx);
  const agentCode = V.parseAgentCode(rawAgentCode);
  return history ? repo.listFor(ctx, agentCode, transaction) : repo.activeFor(ctx, agentCode, transaction);
};

/**
 * Candidato APROVADO por uma pessoa (D032) vira caso do dataset por aqui, e só por aqui: a pessoa informa o conteúdo sintético
 * (o candidato guarda só a origem). Um candidato vira no máximo um caso; o caso guarda o candidato de origem.
 */
async function promoteCandidate(ctx, candidateId, body, transaction) {
  ctxOk(ctx);
  if (!ctx.userId || ctx.serviceIdentity === true) throw E.invalid('Só uma pessoa leva um candidato ao golden dataset.');
  return guarded(async () => {
    const candidate = await repo.findCandidate(ctx, candidateId, transaction);
    if (!candidate) throw E.notFound();
    if (candidate.status !== 'APPROVED') throw E.candidateNotApproved();
    if (await repo.findBySource(candidate.id, transaction)) throw E.state('Este candidato já virou caso do golden dataset.');
    const agentCode = V.parseAgentCode((body && body.agentCode) || candidate.agentCode);
    const data = { agentCode, ...V.parseCaseBody(body), sourceCandidateId: candidate.id };
    if (!(await agentRepo.listByCode(ctx, agentCode, transaction)).length) throw E.invalid('Agente não encontrado.');
    return writeNextVersion(ctx, data, 'Caso vindo do candidato aprovado', transaction);
  });
}

module.exports = { saveCase, retireCase, listCases, promoteCandidate };
