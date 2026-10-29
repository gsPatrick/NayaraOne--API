'use strict';

// Apoio dos testes de métricas e alertas das integrações (M9-D224): dados de saúde montados direto no banco, ciclo de alertas e leitura de alertas e notificações.
const m = require('./m9d223Env');
const { criar } = require('../../integrations/dispatch/dispatchHelpers');
const { runAlertCycle } = require('../../../src/features/integrations/health/alerts');

const { sequelize, comTenant } = m;

/** Cria N envios PENDING na connection (só para ter a quem ligar as tentativas) e devolve os ids. */
async function envios(tenant, connectionId, n, snapshot = { to: '+5541999990000', text: 'x' }) {
  const ids = [];
  for (let i = 0; i < n; i += 1) ids.push((await criar(tenant, connectionId, `qa-m9-d224-${Date.now()}-${Math.random().toString(36).slice(2)}-${i}`, { operation: 'sendText', criticalityOp: 'SAFE', snapshot })).dispatch.id);
  return ids;
}

/** Insere tentativas de chamada: [{ dispatchId, no, outcome, errorClass, latencyMs, rateLimited, quota: {limit, remaining}, minAtras }]. */
async function tentativas(tenant, connection, lista, agora = new Date()) {
  await comTenant(tenant, async (t) => {
    for (const a of lista) {
      const inicio = new Date(agora.getTime() - (a.minAtras ?? 1) * 60000);
      await sequelize.query(
        `INSERT INTO integration.dispatch_attempts (group_id, company_id, dispatch_id, connection_id, provider_code, attempt_no, started_at, finished_at, outcome, error_class, http_status, latency_ms, rate_limited, quota_limit, quota_remaining)
         VALUES (:g, :c, :d, :conn, :p, :no, :ini, :ini, :out, :cls, NULL, :lat, :rl, :ql, :qr)`,
        {
          replacements: {
            g: tenant.groupId, c: tenant.companyId, d: a.dispatchId, conn: connection.id, p: connection.providerCode, no: a.no ?? 1, ini: inicio, out: a.outcome ?? 'SUCCESS',
            cls: a.errorClass ?? null, lat: a.latencyMs ?? 100, rl: a.rateLimited === true, ql: a.quota?.limit ?? null, qr: a.quota?.remaining ?? null,
          },
          transaction: t,
        },
      );
    }
  });
}

/** Linha de webhook na caixa de entrada da connection, no estado pedido. */
async function inbox(tenant, connection, status, n = 1) {
  await comTenant(tenant, async (t) => {
    for (let i = 0; i < n; i += 1) {
      await sequelize.query(
        `INSERT INTO integration.webhook_inbox (group_id, company_id, connection_id, provider_code, external_event_id, signature_valid, payload_hash, status)
         VALUES (:g, :c, :conn, :p, :ev, true, :h, :s)`,
        { replacements: { g: tenant.groupId, c: tenant.companyId, conn: connection.id, p: connection.providerCode, ev: `qa-m9-d224-${Date.now()}-${Math.random().toString(36).slice(2)}`, h: 'a'.repeat(64), s: status }, transaction: t },
      );
    }
  });
}

/** Encerra os alertas abertos que outros testes deixaram, para cada teste contar só os seus. */
const limparAlertas = (tenant) => comTenant(tenant, (t) => sequelize.query(
  "UPDATE integration.alerts SET status = 'RESOLVED', resolved_at = now(), resolution = 'CONNECTION_CHANGED' WHERE company_id = :c AND status = 'OPEN'", { replacements: { c: tenant.companyId }, transaction: t },
));

const ciclo = (tenant, now = new Date()) => runAlertCycle({ groupId: tenant.groupId, companyId: tenant.companyId }, { now });

const alertas = (tenant, connectionId, tipo) => comTenant(tenant, async (t) => (await sequelize.query(
  'SELECT * FROM integration.alerts WHERE connection_id = :id AND (CAST(:tipo AS text) IS NULL OR alert_type = :tipo) ORDER BY opened_at, created_at', { replacements: { id: connectionId, tipo: tipo ?? null }, transaction: t },
))[0]);

/** Notificações da empresa criadas depois de `desde` cujo texto contém `trecho`. */
const notificacoes = (tenant, desde, trecho) => comTenant(tenant, async (t) => (await sequelize.query(
  "SELECT * FROM core.notifications WHERE company_id = :c AND created_at >= :d AND (title || ' ' || COALESCE(body, '')) LIKE :t ORDER BY created_at", { replacements: { c: tenant.companyId, d: desde, t: `%${trecho}%` }, transaction: t },
))[0]);

/** Altera a linha da connection (cenário): `set` é um trecho SQL. */
const mudarConexao = (tenant, id, set) => comTenant(tenant, (t) => sequelize.query(`UPDATE integration.connections SET ${set} WHERE id = :id`, { replacements: { id }, transaction: t }));

module.exports = { ...m, envios, tentativas, inbox, limparAlertas, ciclo, alertas, notificacoes, mudarConexao };
