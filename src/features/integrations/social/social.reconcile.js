'use strict';

const { readSocialParams } = require('./social.params');
const { isSocialPost } = require('./social.guard');

/**
 * Dados que a reconciliação do post entrega ao adapter (M9-D239 3.2 item 4c): a janela de dias (`integration.social.post_dedup_window_days`,
 * padrão 7) e o texto aprovado, para a rede comparar com a listagem recente de posts da conta quando a busca pela chave não basta.
 */
async function socialReconcileEnricher({ ctx, dispatch, transaction }) {
  if (!isSocialPost(dispatch)) return {};
  const params = await readSocialParams(ctx, transaction);
  return { windowDays: params.postDedupWindowDays, text: (dispatch.payloadSnapshot || {}).text };
}

module.exports = { socialReconcileEnricher };
