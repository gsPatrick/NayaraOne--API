'use strict';

// M9-D038 — "Toda minuta sai marcada 'RASCUNHO — requer revisão jurídica humana'". Minuta = tarefa minuta_juridica, ou pedido com um dos
// termos de ia.nay_juridica.termos_minuta. A marca vai no início da resposta e não se repete.
const { getSetting } = require('../../../settings/settings.service');
const { termsOf, norm } = require('../scope/scope.evaluate');
const { JURIDICA_SETTING_DEFAULTS: D } = require('./juridica.settings');
const { DRAFT_MARK } = require('./juridica.policy');

const MINUTA_TASK = 'minuta_juridica';

async function decorateDraft(answer, { taskType, input, ctx, transaction }) {
  if (String(answer).includes(DRAFT_MARK)) return answer;
  const terms = termsOf(await getSetting('ia.nay_juridica.termos_minuta', ctx, transaction, D['ia.nay_juridica.termos_minuta']), D['ia.nay_juridica.termos_minuta']);
  const isDraft = String(taskType || '').toLowerCase() === MINUTA_TASK || terms.some((t) => norm(input).includes(t));
  return isDraft ? `${DRAFT_MARK}\n\n${answer}` : answer;
}

module.exports = { decorateDraft };
