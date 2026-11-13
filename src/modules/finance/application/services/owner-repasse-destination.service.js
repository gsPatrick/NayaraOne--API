'use strict';

const { assertEvidenceForCriticalChange, recordFieldChangeEvidence, repasseEntity } = require('../../../../features/core-governance/data-quality/evidence');

/**
 * Conta de destino do repasse na aprovação (M9-D807, REPASSE.bankAccountId). Repasse que ainda não tem conta recebe a informada; repasse
 * que já tem conta e recebe OUTRA no corpo está trocando o destino do dinheiro do proprietário: exige origem e comprovante
 * (`changeEvidence`), validados antes de qualquer gravação. Devolve a conta a usar e o `record` que grava a evidência depois do save.
 */
async function resolveRepasseDestination(repasse, payload, actorUserId, transaction) {
  const fixed = repasse.bankAccountId || null;
  const asked = (payload && payload.bankAccountId) || null;
  const bankAccountId = asked || fixed;
  if (!fixed || !asked || asked === fixed) return { bankAccountId, record: async () => null };
  const entity = repasseEntity(repasse, { bankAccountId: fixed });
  const assertion = await assertEvidenceForCriticalChange(entity, { bankAccountId: asked }, payload.changeEvidence, { transaction, actorUserId });
  return { bankAccountId, record: () => recordFieldChangeEvidence(entity, assertion, { transaction, actorUserId }) };
}

module.exports = { resolveRepasseDestination };
