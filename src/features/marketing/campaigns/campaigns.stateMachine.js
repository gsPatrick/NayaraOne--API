'use strict';

const { invalidTransition, campaignFinal, campaignNotEditable } = require('./campaigns.errors');

/**
 * Estados da campanha (M9-D412): DRAFT -> SCHEDULED -> RUNNING -> ENDED; ENDED é final. Pausar ou parar uma campanha em andamento
 * é o kill switch por campanha (M9-D425): não muda o status. Qualquer outro par: 409 MKT_CAMPAIGN_INVALID_TRANSITION.
 */
const ALLOWED = Object.freeze({ DRAFT: ['SCHEDULED'], SCHEDULED: ['RUNNING'], RUNNING: ['ENDED'], ENDED: [] });

function assertTransition(from, to) {
  if (!(ALLOWED[from] || []).includes(to)) throw invalidTransition(from, to);
}

/** Só rascunho é editável pela chamada de criação/completar: ENDED mantém MKT_CAMPAIGN_FINAL; SCHEDULED e RUNNING, NOT_EDITABLE. */
function assertEditable(status) {
  if (status === 'DRAFT') return;
  if (status === 'ENDED') throw campaignFinal();
  throw campaignNotEditable(status);
}

module.exports = { ALLOWED, assertTransition, assertEditable };
