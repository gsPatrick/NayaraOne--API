'use strict';

const { hashOf } = require('../tools/toolCallSanitizer');
const { readEntitySnapshot } = require('../readmodels/entitySnapshot.readmodel');
const { registerSnapshotChecker } = require('../recommendations');

const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Lê o estado atual das entidades-alvo (`refs`: [{ arg, entity, id }]) e devolve o retrato com seu hash canônico. */
async function captureSnapshot(refs, transaction) {
  const out = [];
  for (const ref of refs) out.push({ arg: ref.arg, entity: ref.entity, id: ref.id, state: await readEntitySnapshot(ref.entity, ref.id, transaction) });
  const snapshot = { refs: out };
  return { snapshot, snapshotHash: hashOf(snapshot) };
}

/** Entidades-alvo declaradas na definição da tool (`entityRefs`) que aparecem nos argumentos. */
function refsOf(def, args) {
  return (def.entityRefs || []).filter((r) => isUuid(args && args[r.arg])).map((r) => ({ arg: r.arg, entity: r.entity, id: args[r.arg] }));
}

/**
 * Porta do snapshot da M9-D007: devolve o hash do estado ATUAL das entidades da proposta. Proposta sem retrato (sem entidade-alvo)
 * confere o retrato vazio, que nunca muda.
 */
async function currentSnapshotHash(recommendation, _ctx, transaction) {
  const stored = recommendation.proposedAction && recommendation.proposedAction.snapshot;
  const refs = stored && Array.isArray(stored.refs) ? stored.refs.filter((r) => r && isUuid(r.id) && typeof r.entity === 'string') : [];
  return (await captureSnapshot(refs, transaction)).snapshotHash;
}

registerSnapshotChecker(currentSnapshotHash);

module.exports = { captureSnapshot, refsOf, currentSnapshotHash };
