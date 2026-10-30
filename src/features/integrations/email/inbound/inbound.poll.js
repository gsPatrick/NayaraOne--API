'use strict';

const crypto = require('node:crypto');
const { IntegrationConnection } = require('../../../../models');
const { runSyncCycle } = require('../../sync');
const { tenantTx } = require('../../dispatch/worker/tenantTx');
const adapterRegistry = require('../../registry/adapterRegistry');
const { invoke } = require('../../registry/adapterInvoke');
const { ingestInboundEmail } = require('./inbound.ingest');

const STREAM = 'email.inbound';

/** Fonte do ciclo retomável (M9-D208): o adapter devolve a página de mensagens novas a partir do cursor (`receiveInbound` em modo leitura); cada mensagem entra no MESMO pipeline do webhook. */
function sourceFor({ ctx, connectionId, totals }) {
  return {
    async fetchPage({ cursorValue, pageSize }) {
      return tenantTx(ctx, async (transaction) => {
        const connection = await IntegrationConnection.findByPk(connectionId, { transaction });
        const adapter = await adapterRegistry.resolve(connection, ctx, transaction);
        let bruta = null;
        await invoke(adapter, 'receiveInbound', { payload: { mode: 'poll', cursor: cursorValue || null, pageSize } }, { tenant: ctx, transaction, onResponse: (x) => { bruta = x; } });
        const itens = bruta && Array.isArray(bruta.items) ? bruta.items : [];
        return { items: itens, nextCursor: bruta && bruta.nextCursor ? String(bruta.nextCursor) : null, done: !bruta || bruta.done !== false };
      });
    },
    async applyItems(itens, { transaction }) {
      const connection = await IntegrationConnection.findByPk(connectionId, { transaction });
      let novos = 0;
      for (const item of itens) {
         
        const r = await ingestInboundEmail(ctx, { connection, message: item }, transaction);
        totals.received += 1;
        if (!r.duplicate) novos += 1;
      }
      return novos;
    },
  };
}

/** Lê as mensagens novas de UMA connection de e-mail (cursor retomável, lease). Devolve { status, received, written }. */
async function pollInboundEmail({ group, company, connectionId }) {
  const ctx = { groupId: group.id, companyId: company.id, userId: null };
  const totals = { received: 0 };
  const r = await runSyncCycle({ connectionId, stream: STREAM, cursorKind: 'TOKEN', workerId: `email-inbound-${crypto.randomUUID()}` }, ctx, sourceFor({ ctx, connectionId, totals }));
  return { status: r.status, received: totals.received, written: r.itemsWritten };
}

module.exports = { pollInboundEmail, STREAM };
