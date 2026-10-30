'use strict';

const crypto = require('node:crypto');
const { IntegrationConnection } = require('../../../models');
const logger = require('../../../utils/logger');
const { runSyncCycle } = require('../../integrations/sync');
const { tenantTx } = require('../../integrations/dispatch/worker/tenantTx');
const { invoke } = require('../../integrations/registry/adapterInvoke');
const adapterRegistry = require('../../integrations/registry/adapterRegistry');
const { recordError } = require('../../integrations/errors');
const { readBankParams } = require('./bank.params');
const { STREAM, PROVIDER_CODES } = require('./bank.constants');
const { normalizeEntry, insertEntries } = require('./bank.statement.store');
const { ensureBankAdaptersRegistered } = require('./bank.boot');

/**
 * Extrato como STREAM de sincronização (M9-D237 3.1, M9-D208): `bank.statement`, um cursor por connection do banco. O cursor é o token que o banco devolve (`nextCursor`); se
 * o processo cair no meio, a rodada seguinte retoma dali, e o lease impede dois workers no mesmo extrato. Cada lançamento entra uma só vez (UNIQUE connection_id + entry_id).
 */
function sourceFor({ ctx, connectionId, pageSize }) {
  return {
    async fetchPage({ cursorValue }) {
      return tenantTx(ctx, async (transaction) => {
        const connection = await IntegrationConnection.findOne({ where: { id: connectionId, companyId: ctx.companyId }, transaction });
        const adapter = await adapterRegistry.resolve(connection, ctx, transaction);
        let bruta = null;
        await invoke(adapter, 'getStatement', { ...(cursorValue ? { cursor: cursorValue } : {}), pageSize }, { tenant: ctx, transaction, onResponse: (r) => { bruta = r; } });
        const lista = (bruta && (bruta.transactions || (bruta.raw && bruta.raw.transactions))) || [];
        const proximo = (bruta && (bruta.nextCursor ?? (bruta.raw && bruta.raw.nextCursor))) || null;
        const items = lista.map(normalizeEntry);
        const invalidos = items.filter((i) => i === null).length;
        if (invalidos) {
          await recordError(ctx, {
            providerCode: connection.providerCode, connectionId, source: 'SYNC', errorClass: 'VALIDATION', errorCode: 'INTEGRATION_BANK_STATEMENT_ENTRY_INVALID', severity: 'MEDIUM',
            message: 'Lançamentos do extrato sem identificador ou com valor ilegível foram ignorados.', operation: 'getStatement', payload: { invalidos }, allowlist: ['invalidos'],
          }, transaction);
        }
        return { items: items.filter(Boolean), nextCursor: proximo, done: !proximo };
      });
    },
    async applyItems(items, { transaction }) { return insertEntries(ctx, connectionId, items, transaction); },
  };
}

/** Lê o extrato de cada banco ativo da empresa. Devolve { connections, imported }. */
async function sweepStatements({ group, company, onlyConnectionId }) {
  ensureBankAdaptersRegistered();
  const ctx = { groupId: group.id, companyId: company.id, userId: null };
  const { statementPageSize } = await tenantTx(ctx, (t) => readBankParams(ctx, t));
  const conexoes = await tenantTx(ctx, (transaction) => IntegrationConnection.findAll({
    where: { companyId: ctx.companyId, status: 'ACTIVE', providerCode: Object.values(PROVIDER_CODES), ...(onlyConnectionId ? { id: onlyConnectionId } : {}) }, attributes: ['id', 'providerCode'], transaction,
  }));
  const total = { connections: conexoes.length, imported: 0 };
  for (const conexao of conexoes) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await runSyncCycle({ connectionId: conexao.id, stream: STREAM, cursorKind: 'TOKEN', workerId: `bank-statement-${crypto.randomUUID()}` }, ctx, sourceFor({ ctx, connectionId: conexao.id, pageSize: statementPageSize }));
      total.imported += r.itemsWritten || 0;
    } catch (err) {
      logger.warn({ providerCode: conexao.providerCode, err: err.message, code: err.code }, 'Extrato bancário: a leitura não pôde rodar.');
    }
  }
  return total;
}

module.exports = { sweepStatements };
