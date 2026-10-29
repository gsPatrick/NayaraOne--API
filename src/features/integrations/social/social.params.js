'use strict';

const { getSetting } = require('../../settings/settings.service');

/** Padrões do livro (M9-D239 3.2): janela de 7 dias para achar o post duplicado e publicação automática desligada. */
const PADROES = Object.freeze({ postDedupWindowDays: 7, autoPublishEnabled: false });

async function readSocialParams(ctx, transaction) {
  const [janela, auto] = await Promise.all([
    getSetting('integration.social.post_dedup_window_days', ctx, transaction, PADROES.postDedupWindowDays),
    getSetting('integration.social.auto_publish_enabled', ctx, transaction, PADROES.autoPublishEnabled),
  ]);
  return {
    postDedupWindowDays: Number.isInteger(janela) && janela >= 1 ? janela : PADROES.postDedupWindowDays,
    autoPublishEnabled: auto === true,
  };
}

module.exports = { PADROES, readSocialParams };
