'use strict';

const { IntegrationConnection } = require('../../../../models');
const { tenantTx } = require('../../dispatch/worker/tenantTx');
const { pollInboundEmail } = require('./inbound.poll');

/** Connections de e-mail ATIVAS da empresa que recebem por leitura periódica: `config_json.inboundMode = 'POLL'` (as que recebem por webhook não são lidas). */
async function pollingConnections(ctx) {
  const todas = await tenantTx(ctx, (transaction) => IntegrationConnection.findAll({ where: { companyId: ctx.companyId, status: 'ACTIVE' }, attributes: ['id', 'providerCode', 'configJson'], transaction }));
  return todas.filter((c) => c.configJson && c.configJson.inboundMode === 'POLL');
}

/** Lê as mensagens novas de cada connection de e-mail em modo POLL da empresa. Devolve { connections, received, errors }. */
async function pollAllInboundEmail({ group, company }) {
  const ctx = { groupId: group.id, companyId: company.id, userId: null };
  const conexoes = await pollingConnections(ctx);
  const totais = { connections: conexoes.length, received: 0, errors: 0 };
  for (const c of conexoes) {
    try {
      const r = await pollInboundEmail({ group, company, connectionId: c.id });
      totais.received += r.received;
      if (r.status === 'FAILED' || r.status === 'STALLED') totais.errors += 1;
    } catch { totais.errors += 1; }
  }
  return totais;
}

module.exports = { pollAllInboundEmail, pollingConnections };
