'use strict';

const { mktError } = require('./marketing.errors');
const { isStepActive } = require('../core-governance/finops/degradation/state');

/**
 * Degradação por custo no Marketing (M9-D863 §3.2, passo PAUSE_MARKETING_CAMPAIGNS): com o passo aplicado, NOVOS agendamentos (campanha DRAFT -> SCHEDULED e
 * publicação de conteúdo) são recusados com 409 MKT_SCHEDULING_PAUSED_BY_COST. O que já foi agendado ou publicado segue como está; o passo termina com o período.
 */
async function assertSchedulingNotPaused(tenant, transaction) {
  if (await isStepActive('PAUSE_MARKETING_CAMPAIGNS', tenant, transaction)) {
    throw mktError(409, 'MKT_SCHEDULING_PAUSED_BY_COST', 'Novos agendamentos de Marketing estão pausados pelo limite de custo do mês.');
  }
}

module.exports = { assertSchedulingNotPaused };
