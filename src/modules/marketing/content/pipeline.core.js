'use strict';

const repo = require('./pipeline.repository');
const { sha256, canonicalJson } = require('./sourceStamp');
const { assertTransition } = require('./pipeline.states');
const { contentNotFound, stepRequired } = require('./pipeline.errors');

/** Posição de cada estado no fluxo feliz: serve para saber se um passo já ficou para trás (replay). */
const RANK = Object.freeze({
  DRAFT: 0, FACT_CHECKED: 1, BRANDED: 2, COMPLIANCE_CHECKED: 3, PENDING_APPROVAL: 4, APPROVED: 5, SCHEDULED: 6, PUBLISHING: 7, PUBLISHED: 8, FAILED: 7,
});

/**
 * Definição de cada passo: o estado de onde sai, o de chegada em caso de sucesso, e o passo anterior que precisa ter gravado `ok`.
 * `facts` não muda status (é a leitura dos fatos, gravada na criação).
 */
const STEPS = Object.freeze({
  factual: { from: 'DRAFT', to: 'FACT_CHECKED', prereq: 'facts' },
  branding: { from: 'FACT_CHECKED', to: 'BRANDED', prereq: 'factual' },
  compliance: { from: 'BRANDED', to: 'COMPLIANCE_CHECKED', prereq: 'branding' },
  approval: { from: 'COMPLIANCE_CHECKED', to: 'PENDING_APPROVAL', prereq: 'compliance' },
  schedule: { from: 'APPROVED', to: 'SCHEDULED', prereq: 'approval' },
});

const readCheck = (version, step) => (version && version.checks_json ? version.checks_json[step] || null : null);
const checkOk = (version, step) => Boolean(readCheck(version, step) && readCheck(version, step).ok);

function newCheck(ok, detalhes, inputHash, now) {
  return { ok: Boolean(ok), at: (now || new Date()).toISOString(), detalhes: { ...detalhes, inputHash } };
}

async function loadLocked(itemId, transaction) {
  const item = await repo.lockItem(itemId, transaction);
  if (!item) throw contentNotFound();
  const version = item.current_version_id ? await repo.findVersion(item.current_version_id, transaction) : null;
  return { item, version };
}

const hashInput = (step, version, input) => sha256(canonicalJson({ step, content: version ? version.content_hash : null, input: input || null }));

function resultOf(item, version, check, replay, extra) {
  return { itemId: item.id, status: item.status, versionId: version.id, step: check, replay, ...extra };
}

/**
 * Executa um passo do pipeline com o item travado (FOR UPDATE): (1) passo já concluído com a mesma entrada, ou já ultrapassado,
 * devolve o resultado gravado (replay; é o que a segunda execução simultânea recebe); (2) passo anterior sem `ok`:
 * MKT_PIPELINE_STEP_REQUIRED; (3) estado de saída errado: MKT_CONTENT_INVALID_TRANSITION. O handler devolve { ok, detalhes, to,
 * newVersion? } e este executor grava o resultado em checks_json e muda o status, tudo na transação do chamador.
 */
async function executeStep(name, { tenant, actor, itemId, input, now }, transaction, handler) {
  const def = STEPS[name];
  const { item, version } = await loadLocked(itemId, transaction);
  const inputHash = hashInput(name, version, input);
  const recorded = readCheck(version, name);
  const past = (RANK[item.status] !== undefined && RANK[item.status] >= RANK[def.to]);
  if (recorded && recorded.ok && (recorded.detalhes.inputHash === inputHash || past)) return resultOf(item, version, recorded, true);
  if (!checkOk(version, def.prereq)) throw stepRequired({ step: name, required: def.prereq, status: item.status });
  if (item.status !== def.from) assertTransition(item.status, def.to);
  if (item.status !== def.from) throw stepRequired({ step: name, status: item.status, expected: def.from });

  const outcome = await handler({ item, version, tenant, actor, transaction, now });
  if (outcome.abort) {
    const fresh = await repo.lockItem(item.id, transaction);
    return { itemId: item.id, status: fresh.status, versionId: version.id, step: null, replay: false, ...outcome.abort };
  }
  const target = outcome.to || def.to;
  assertTransition(item.status, target);
  const check = newCheck(outcome.ok, outcome.detalhes, inputHash, now);
  const saved = outcome.newVersion || version;
  await repo.writeCheck(saved.id, name, check, actor, transaction);
  await repo.setStatus(item.id, target, actor, transaction);
  return resultOf({ ...item, status: target }, saved, check, false, outcome.extra);
}

module.exports = { RANK, STEPS, readCheck, checkOk, newCheck, loadLocked, hashInput, executeStep };
