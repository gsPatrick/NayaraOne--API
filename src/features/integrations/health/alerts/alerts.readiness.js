'use strict';

const { activeUserIdsWithRole } = require('../../../core-governance/governance.users');
const { registerReadinessCheck } = require('../productionReadiness');
const { readAlertParams } = require('./alerts.params');

/**
 * "Alertas configurados" para liberar um fornecedor em produção (M9-D223 regra 3.3): os avisos têm para quem chegar, isto é, ao menos
 * uma pessoa ativa da empresa num dos papéis de `integration.alert.notify_roles`. O fornecedor em si não muda a regra: os seis alertas
 * valem para toda integração.
 */
async function alertsConfigured(providerCode, ctx, transaction) {
  const params = await readAlertParams(ctx, transaction);
  for (const role of params.notifyRoles) {
    if ((await activeUserIdsWithRole(role, { companyId: ctx.companyId }, transaction)).length) return { ok: true, detail: `avisos para o papel ${role}` };
  }
  return { ok: false, detail: 'nenhuma pessoa ativa nos papéis que recebem os avisos das integrações' };
}

registerReadinessCheck('alerts', alertsConfigured);

module.exports = { alertsConfigured };
