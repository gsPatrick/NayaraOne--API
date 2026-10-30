'use strict';

const { success } = require('../../utils/httpResponse');
const { tenantFromAuth } = require('./marketing.module');
const { parseChange } = require('./killswitch.input');
const errors = require('./killswitch.errors');
const { changeKillSwitch } = require('./killswitch.change');

/** POST /marketing/kill-switch (M9-D425): aciona ou reativa um escopo. Permissão e MFA da reativação vêm da rota; o corpo é validado e aplicado na mesma transação do tenant. */
async function change(req, res) {
  const tenant = tenantFromAuth(req);
  const data = await req.withTenantTransaction(async (transaction) => {
    const input = await parseChange(req.body, tenant, transaction);
    return changeKillSwitch({ tenant, actorUserId: req.auth.userId, input, transaction });
  });
  return success(res, { data });
}

/** Resposta da rota de simulação quando o corpo não diz qual ação simular. */
async function impactFallback() {
  throw errors.inputInvalid({ field: 'action', allowed: ['activate', 'restore'] });
}

module.exports = { change, impactFallback };
