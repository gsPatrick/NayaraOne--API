'use strict';

const { sequelize } = require('../../../models');
const { recordUnknownWebhook } = require('../errors');
const logger = require('../../../utils/logger');

const CHANNEL_RE = /^[A-Za-z0-9_-]{24,48}$/;
const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/**
 * Resolve a connection do canal (M9-D211 passo 3) pela função SECURITY DEFINER integration.resolve_webhook_connection: sem empresa na sessão, só leitura,
 * connection DISABLED não volta. Devolve { connectionId, groupId, companyId, status, environment } ou null (canal inexistente, formato inválido ou desligado).
 */
async function resolveChannel(provider, channel) {
  const p = String(provider || '').toLowerCase();
  if (!PROVIDER_RE.test(p) || !CHANNEL_RE.test(String(channel || ''))) return null;
  const [rows] = await sequelize.query('SELECT * FROM integration.resolve_webhook_connection(:provider, :channel)', { replacements: { provider: p, channel: String(channel) } });
  const r = rows[0];
  return r ? { connectionId: r.connection_id, groupId: r.group_id, companyId: r.company_id, status: r.status, environment: r.environment } : null;
}

/** Canal ou fornecedor desconhecido (M9-D207 3.3): só um contador por hora e fornecedor, sem corpo, cabeçalho nem origem. Nunca muda a resposta ao chamador. */
async function noteUnknownChannel(provider) {
  try {
    await sequelize.transaction((transaction) => recordUnknownWebhook(String(provider || '').slice(0, 48), transaction));
  } catch (err) {
    logger.warn({ err: err.message }, 'webhook.unknownChannel.record.failed');
  }
}

/** Transação no contexto da empresa dona do canal (group e company da sessão para o RLS). */
async function withTenant(conn, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: conn.groupId, c: conn.companyId }, transaction });
    return fn(transaction);
  });
}

module.exports = { resolveChannel, noteUnknownChannel, withTenant, CHANNEL_RE };
