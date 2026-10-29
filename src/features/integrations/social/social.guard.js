'use strict';

const { AGGREGATE, OPERATION } = require('./social.publish');
const { parseContentRef } = require('./social.payload');
const { assertPublishable } = require('./social.gate');

const FAIL_CLASS = 'VALIDATION';
const recusa = (code, message) => ({ fail: { class: FAIL_CLASS, code, message } });

const isSocialPost = (dispatch) => dispatch.operation === OPERATION && dispatch.aggregateType === AGGREGATE;

/**
 * Verificação do worker ANTES de chamar a rede (M9-D239 3.2 itens 1 e 5): um post agendado espera horas ou dias, e nesse tempo o conteúdo
 * pode ter sido editado, ter a aprovação invalidada, a política de publicação automática desligada ou o kill switch ligado. O worker
 * reconfere tudo com a mesma porta da hora de agendar:
 *  - kill switch: o envio ESPERA (sem gastar tentativa) e sai quando for reativado;
 *  - conteúdo editado depois da aprovação, aprovação perdida ou política automática desligada: o envio fecha em FAILED com o código do
 *    livro (sem nova tentativa) e o domínio recebe `integration.dispatch.failed`;
 *  - versão diferente da que foi aprovada para este envio: também fecha como alterado depois da aprovação.
 */
async function socialPreflight({ ctx, dispatch, params, now, transaction }) {
  if (!isSocialPost(dispatch)) return null;
  const ref = parseContentRef((dispatch.payloadSnapshot || {}).contentRef);
  if (!ref) return recusa('INTEGRATION_SOCIAL_CONTENT_CHANGED_AFTER_APPROVAL', 'O envio não traz a referência do conteúdo aprovado.');
  try {
    const content = await assertPublishable(ctx, { itemId: ref.itemId, mode: ref.mode }, transaction);
    if (content.version_id !== ref.versionId || content.approved_hash !== ref.approvedHash) {
      return recusa('INTEGRATION_SOCIAL_CONTENT_CHANGED_AFTER_APPROVAL', 'O conteúdo mudou após a aprovação; aprove novamente.');
    }
    return null;
  } catch (err) {
    if (err.code === 'INTEGRATION_SOCIAL_KILL_SWITCH_ACTIVE') return { until: new Date(now.getTime() + params.blockedRecheckS * 1000), reason: 'MARKETING_KILL_SWITCH' };
    if (String(err.code || '').startsWith('INTEGRATION_SOCIAL_') || err.code === 'INTEGRATION_PROPERTY_NOT_PUBLISHABLE' || err.code === 'MKT_SOURCE_STALE') return recusa(err.code, err.message);
    throw err;
  }
}

module.exports = { socialPreflight, isSocialPost };
