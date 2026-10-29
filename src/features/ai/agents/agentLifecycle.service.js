'use strict';

const { getSetting } = require('../../../features/settings/settings.service');
const E = require('./agents.errors');
const repo = require('./agents.repository');
const { auditAgent } = require('./agentAudit');
const { requireOwn } = require('./agentAccess');
const { normalizeCode } = require('./agents.validation');
const { assertGreenEvaluation, assertHumanHomologatedEvaluation } = require('./evaluationGate');
const { assertNotGoldenAuthor } = require('../evaluations/golden/goldenAuthors');

const SEGREGATION_KEY = 'ia.agente.segregacao_funcoes';

/** Ciclo de vida da versão (M9-D004): DRAFT > HOMOLOGATED > ACTIVE > RETIRED. Repetir o mesmo passo devolve o estado atual (idempotente). */

async function segregationOn(ctx, transaction) {
  return (await getSetting(SEGREGATION_KEY, ctx, transaction, true)) !== false;
}

async function openForChange(ctx, rawCode, rawVersion, transaction) {
  const code = normalizeCode(rawCode);
  if (code) await repo.lockCode(ctx, code, transaction);
  return requireOwn(ctx, rawCode, rawVersion, transaction, { lock: true });
}

async function reload(ctx, current, transaction) {
  return repo.findOwn(ctx, current.code, current.version, transaction);
}

/** Homologação humana (ai:evaluate): exige avaliação verde (configurável) e pessoa diferente de quem criou a versão (configurável). */
async function homologate(ctx, rawCode, rawVersion, { note } = {}, transaction) {
  const current = await openForChange(ctx, rawCode, rawVersion, transaction);
  if (current.status === 'HOMOLOGATED') return { ...current, replay: true };
  if (current.status !== 'DRAFT') throw E.badTransition(current.status, 'HOMOLOGATED');
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 1000)) throw E.invalid('A nota de homologação deve ser um texto de até 1000 caracteres.');
  if (!ctx.userId) throw E.invalid('A homologação precisa de uma pessoa identificada.');
  if ((await segregationOn(ctx, transaction)) && current.createdBy && current.createdBy === ctx.userId) {
    throw E.segregation('Quem criou a versão não pode homologá-la; peça a outra pessoa com permissão de avaliação.');
  }
  if (await segregationOn(ctx, transaction)) await assertNotGoldenAuthor(ctx, current, transaction);
  await assertGreenEvaluation(ctx, current, transaction);
  await repo.markHomologated(ctx, current.id, note, transaction);
  const updated = await reload(ctx, current, transaction);
  await auditAgent(ctx, 'ai.agent.version.homologated', updated, current, `Versão ${current.version} do agente ${current.code} homologada.`, transaction);
  return updated;
}

/** Ativação (ai:admin): só versão homologada; a ativa anterior é aposentada na mesma transação; quem homologou não ativa (configurável). */
async function activate(ctx, rawCode, rawVersion, transaction) {
  const current = await openForChange(ctx, rawCode, rawVersion, transaction);
  if (current.status === 'ACTIVE') return { ...current, replay: true };
  if (current.status === 'DRAFT') throw E.notHomologated();
  if (current.status !== 'HOMOLOGATED') throw E.badTransition(current.status, 'ACTIVE');
  if (!ctx.userId) throw E.invalid('A ativação precisa de uma pessoa identificada.');
  if ((await segregationOn(ctx, transaction)) && current.homologatedBy === ctx.userId) {
    throw E.segregation('Quem homologou a versão não pode ativá-la; peça a outra pessoa com permissão de administração.');
  }
  await assertHumanHomologatedEvaluation(ctx, current, transaction);
  for (const id of await repo.activeOwnRowIds(ctx, current.code, transaction)) {
    const before = await repo.findOwnById(ctx, id, transaction);
    await repo.markRetired(ctx, id, transaction);
    const retired = await repo.findOwn(ctx, before.code, before.version, transaction);
    await auditAgent(ctx, 'ai.agent.version.retired', retired, before, `Versão ${before.version} do agente ${before.code} aposentada pela ativação da versão ${current.version}.`, transaction);
  }
  await repo.markActive(ctx, current.id, transaction);
  const updated = await reload(ctx, current, transaction);
  await auditAgent(ctx, 'ai.agent.version.activated', updated, current, `Versão ${current.version} do agente ${current.code} ativada.`, transaction);
  return updated;
}

/** Aposenta uma versão (DRAFT, HOMOLOGATED ou ACTIVE). Aposentar a ativa deixa o agente sem versão ativa (409 AI_AGENT_DISABLED no run). */
async function retire(ctx, rawCode, rawVersion, transaction) {
  const current = await openForChange(ctx, rawCode, rawVersion, transaction);
  if (current.status === 'RETIRED') return { ...current, replay: true };
  await repo.markRetired(ctx, current.id, transaction);
  const updated = await reload(ctx, current, transaction);
  await auditAgent(ctx, 'ai.agent.version.retired', updated, current, `Versão ${current.version} do agente ${current.code} aposentada.`, transaction);
  return updated;
}

module.exports = { homologate, activate, retire, SEGREGATION_KEY };
