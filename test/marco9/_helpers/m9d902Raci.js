'use strict';

// Apoio dos testes das decisões do corte (M9-D902; não é teste): põe um papel como R (e ADMIN como A) nas atividades que a API exige do ator.
const env = require('./m9d901Env');

const DECISION_ACTIVITIES = ['SECTOR_ACTIVATION', 'ROLLBACK_EXECUTION', 'GO_NO_GO', 'LAST_DELTA_LOAD'];

/** O papel `roleName` passa a ser R das atividades (A: ADMIN). Sem `activities`, as quatro decisões do corte. */
async function grantRaci(tenant, roleName, activities = DECISION_ACTIVITIES) {
  await env.completeRaci(tenant);
  for (const activity of activities) {
    await env.setRaci(tenant, activity, [{ role: 'ADMIN', raci: 'A' }, { role: roleName, raci: 'R' }]);
  }
}

module.exports = { grantRaci, DECISION_ACTIVITIES };
