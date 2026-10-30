'use strict';

const { getSetting } = require('../../settings/settings.service');

/**
 * Padrões do livro (M9-D232 3.4 e M9-D233 3.1): leitura do status a cada 15 minutos e página de 50 anúncios; despublicação consultada 60 minutos depois do pedido, reenviada a cada
 * 30 minutos (a regra inferida do contexto: 30 min mantém o anúncio indevido no ar o mínimo sem martelar o portal) até 8 vezes.
 */
const PADROES = Object.freeze({ reconcileIntervalMin: 15, syncPageSize: 50, unpublishConfirmDeadlineMin: 60, unpublishRetryIntervalMin: 30, unpublishMaxAttempts: 8 });

const inteiro = (v, padrao, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : padrao);

async function readPortalParams(ctx, transaction) {
  const [intervalo, pagina, prazo, cadencia, maximo] = await Promise.all([
    getSetting('integration.portal.reconcile_interval_min', ctx, transaction, PADROES.reconcileIntervalMin),
    getSetting('integration.portal.sync_page_size', ctx, transaction, PADROES.syncPageSize),
    getSetting('integration.portal.unpublish_confirm_deadline_min', ctx, transaction, PADROES.unpublishConfirmDeadlineMin),
    getSetting('integration.portal.unpublish_retry_interval_min', ctx, transaction, PADROES.unpublishRetryIntervalMin),
    getSetting('integration.portal.unpublish_max_attempts', ctx, transaction, PADROES.unpublishMaxAttempts),
  ]);
  return {
    reconcileIntervalMin: inteiro(intervalo, PADROES.reconcileIntervalMin, 1, 1440),
    syncPageSize: inteiro(pagina, PADROES.syncPageSize, 5, 500),
    unpublishConfirmDeadlineMin: inteiro(prazo, PADROES.unpublishConfirmDeadlineMin, 1, 10080),
    unpublishRetryIntervalMin: inteiro(cadencia, PADROES.unpublishRetryIntervalMin, 1, 1440),
    unpublishMaxAttempts: inteiro(maximo, PADROES.unpublishMaxAttempts, 1, 50),
  };
}

module.exports = { PADROES, readPortalParams };
