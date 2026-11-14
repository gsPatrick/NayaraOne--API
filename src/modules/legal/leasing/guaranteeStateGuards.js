'use strict';

const AppError = require('../../../utils/AppError');
const { REQUIRED, missingMessage } = require('./guaranteeTypeData');

/**
 * Travas de estado da garantia (fechamento M5, livro §9 e JUR-006 "Fiador, seguro, caução e demais garantias têm
 * vigência/status próprios"; "contrato não perde histórico quando a garantia é substituída").
 *  - Garantia substituída é histórico: não se altera nem se apaga (o banco também recusa, migration 20260101015600).
 *  - Fiador, seguro-fiança e título de capitalização nascem com fim de vigência e nunca o perdem.
 *  - Garantia ACTIVE não perde, por atualização, nenhum dado que o tipo exige (o estado final é conferido inteiro, não
 *    só os campos que vieram no corpo).
 */
const TYPES_REQUIRING_VALIDITY = ['GUARANTOR', 'INSURANCE', 'CAPITALIZATION'];

function assertNotReplaced(guarantee) {
  if (guarantee.replacedByGuaranteeId) {
    throw AppError.conflict(
      'Esta garantia foi substituída e faz parte do histórico do contrato: não pode ser alterada nem excluída.',
      'LEGAL_GUARANTEE_REPLACED_IMMUTABLE',
      { replacedByGuaranteeId: guarantee.replacedByGuaranteeId }
    );
  }
}

const isMissing = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Campos exigidos pelo tipo que faltam num retrato (objeto simples) da garantia. */
function missingIn(guaranteeType, snapshot) {
  return (REQUIRED[guaranteeType] || []).filter((k) => isMissing(snapshot[k]));
}

/**
 * Confere o estado final da atualização: `before` é o retrato antes, `after` o retrato que vai ser gravado, `askedStatus`
 * o status pedido no corpo (ou undefined), `typeFieldsTouched` se o corpo trouxe dado do tipo e `endsAtTouched` se trouxe a vigência.
 */
function assertFinalGuaranteeState(guaranteeType, before, after, { askedStatus, typeFieldsTouched, endsAtTouched } = {}) {
  if (TYPES_REQUIRING_VALIDITY.includes(guaranteeType) && isMissing(after.endsAt) && (endsAtTouched || !isMissing(before.endsAt))) {
    throw AppError.badRequest(
      `O fim da vigência ("endsAt") é obrigatório para garantia do tipo "${guaranteeType}" e não pode ser apagado (Caderno, seção 9).`,
      'LEGAL_GUARANTEE_VALIDITY_REQUIRED'
    );
  }
  if (after.status !== 'ACTIVE') return;
  const missingAfter = missingIn(guaranteeType, after);
  if (!missingAfter.length) return;
  const missingBefore = new Set(missingIn(guaranteeType, before));
  const removed = missingAfter.filter((k) => !missingBefore.has(k));
  // Ativar (ou mexer nos dados do tipo de uma ativa) exige tudo; e uma ativa nunca perde o que tinha, venha o campo que vier.
  if (askedStatus === 'ACTIVE' || typeFieldsTouched) {
    throw AppError.badRequest(missingMessage(guaranteeType, missingAfter), 'LEGAL_GUARANTEE_VALIDATION', { missing: missingAfter });
  }
  if (removed.length) {
    throw AppError.badRequest(
      `Garantia ativa não pode ficar sem dado obrigatório do tipo. ${missingMessage(guaranteeType, removed)}`,
      'LEGAL_GUARANTEE_ACTIVE_DATA_REQUIRED',
      { missing: removed }
    );
  }
}

module.exports = { TYPES_REQUIRING_VALIDITY, assertNotReplaced, assertFinalGuaranteeState };
