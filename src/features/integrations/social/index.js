'use strict';

/**
 * Redes sociais (Marco 9, M9-D239): publicação de conteúdo aprovado, uma connection (com o segredo no cofre) por rede, erro isolado por
 * rede e post que nunca duplica. Ao carregar, registra a verificação do worker (conteúdo ainda aprovado e sem kill switch) e os dados
 * que a reconciliação entrega ao adapter. Fachada da API pública.
 */
const { registerPreflight } = require('../dispatch/worker/worker.hooks');
const { registerReconcileEnricher } = require('../dispatch/reconcile/reconcile.enrichers');
const { publishToSocial } = require('./social.publish');
const { rescheduleSocialPost } = require('./social.reschedule');
const { assertPublishable } = require('./social.gate');
const { socialPreflight } = require('./social.guard');
const { socialReconcileEnricher } = require('./social.reconcile');
const { registerKillSwitchCheck, isKillSwitchActive } = require('./social.killswitch');
const { socialIdempotencyKey, slotOf, IMMEDIATE_SLOT } = require('./social.key');
const { readSocialParams, PADROES } = require('./social.params');
const { formatContentRef, parseContentRef } = require('./social.payload');

registerPreflight(socialPreflight);
registerReconcileEnricher('SOCIAL', socialReconcileEnricher);

module.exports = {
  publishToSocial, rescheduleSocialPost, assertPublishable, socialPreflight, socialIdempotencyKey, slotOf, IMMEDIATE_SLOT, readSocialParams, SOCIAL_PADROES: PADROES,
  registerKillSwitchCheck, isKillSwitchActive, formatContentRef, parseContentRef,
};
