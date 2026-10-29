'use strict';

const registry = require('../../registry/registry.service');
const { transitionConnection } = require('../../registry/connections.transition');
const { IntegrationConnection } = require('../../../../models');
const actions = require('./drill.actions');

/**
 * Cenários do ensaio (M9-D226 3.3 item 5). Cada um tem `derrubar` (o que tira o fornecedor do ar) e `recuperar` (o que o devolve), ambos sobre a connection de
 * laboratório; `reason` é o gatilho que a contingência deve registrar.
 *  - provider-down: o fornecedor falha até o circuito abrir; volta fechando o circuito;
 *  - timeout: o fornecedor não responde (resposta incerta, classe UNKNOWN) até o circuito abrir; volta fechando o circuito;
 *  - rate-limit (429): o limite de uso do fornecedor NÃO é falha dele: o circuito não abre e a contingência não é ativada (`activates: false`);
 *  - auth-failed: a credencial é recusada (AUTH_FAILED); volta pelo teste de conexão verde (ACTIVE);
 *  - paused: a integração é pausada; volta ao ser reativada.
 */
const SCENARIOS = Object.freeze({
  'provider-down': {
    reason: 'CIRCUIT_OPEN',
    derrubar: async (ctx, connection) => { const r = await actions.failUntilCircuitOpens(ctx, connection.id); return { ok: r.opened, detail: `${r.failures} falhas seguidas` }; },
    recuperar: async (ctx, connection) => { await actions.closeCircuit(ctx, connection.id); return { ok: true, detail: 'circuito fechado' }; },
  },
  timeout: {
    reason: 'CIRCUIT_OPEN',
    derrubar: async (ctx, connection) => { const r = await actions.failUntilCircuitOpens(ctx, connection.id, 'UNKNOWN'); return { ok: r.opened, detail: `${r.failures} respostas incertas seguidas` }; },
    recuperar: async (ctx, connection) => { await actions.closeCircuit(ctx, connection.id); return { ok: true, detail: 'circuito fechado' }; },
  },
  'rate-limit': {
    activates: false,
    derrubar: async (ctx, connection) => { const r = await actions.rateLimitStorm(ctx, connection.id); return { ok: !r.opened, detail: `${r.calls} respostas 429 seguidas: o circuito continua fechado` }; },
    recuperar: async () => ({ ok: true, detail: 'nada a recuperar' }),
  },
  'auth-failed': {
    reason: 'AUTH_FAILED',
    derrubar: async (ctx, connection) => { await actions.withCtx(ctx, (t) => registry.transitionConnection(connection.id, 'AUTH_FAILED', ctx, t, { system: true })); return { ok: true, detail: 'credencial recusada' }; },
    recuperar: async (ctx, connection) => { await actions.withCtx(ctx, (t) => transitionConnection(connection.id, 'ACTIVE', ctx, t, { testConnectionOk: true })); return { ok: true, detail: 'teste de conexão verde' }; },
  },
  paused: {
    reason: 'PAUSED',
    derrubar: async (ctx, connection) => { await actions.withCtx(ctx, (t) => registry.transitionConnection(connection.id, 'PAUSED', ctx, t)); return { ok: true, detail: 'integração pausada' }; },
    recuperar: async (ctx, connection) => { await actions.withCtx(ctx, (t) => registry.transitionConnection(connection.id, 'ACTIVE', ctx, t)); return { ok: true, detail: 'integração reativada' }; },
  },
});

const reload = (ctx, id) => actions.withCtx(ctx, (t) => IntegrationConnection.findByPk(id, { transaction: t }));

module.exports = { SCENARIOS, reload };
