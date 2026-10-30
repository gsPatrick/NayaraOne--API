'use strict';

// Apoio dos testes das páginas do site (M9-D259): connection do site-sandbox com canal e segredo do webhook, imóvel publicável, publicação pelo serviço, rodadas do worker de envios,
// consulta de status na rodada, eventos assinados do site e leitura da página, dos envios e dos eventos de confirmação. Roda em banco descartável (os testes COMMITAM).
// Quem usa define process.env.PORT ANTES de requerer este arquivo (ele sobe o app de teste).
const env = require('./m9d212Env');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');
const { runDispatchCycle } = require('../../../src/features/integrations/dispatch/worker');
const { runEventConsumers } = require('../../../src/engines/events/consumers');
const { OutboxEvent } = require('../../../src/models');
const site = require('../../../src/features/integrations/site');
const store = require('../../../src/features/integrations/providers/site/sandbox/site.sandbox.store');
const { criarImovel } = require('./intReadModel');

const { comTenant, sql, uniqueSuffix, ctxDe } = env;

/** Canal ATIVO do site-sandbox da empresa (os outros ativos do site ficam pausados), com o segredo do webhook no cofre e a configuração do sandbox em `config`. */
async function conectar(tenant, { config } = {}) {
  await sql(tenant, "UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code = 'site-sandbox' AND status = 'ACTIVE'", { c: tenant.companyId });
  const canal = await env.criarCanal(tenant, { provider: 'site-sandbox' });
  if (config) await configurar(tenant, canal.conn.id, config);
  await comTenant(tenant, (t) => transitionConnection(canal.conn.id, 'ACTIVE', ctxDe(tenant), t));
  return canal;
}

/** Troca a configuração do sandbox da connection (falha injetada, atraso de publicação, resposta já "no ar"). */
const configurar = (tenant, connectionId, config) => sql(tenant, 'UPDATE integration.connections SET config_json = CAST(:cfg AS jsonb) WHERE id = :id', { id: connectionId, cfg: JSON.stringify(config) });

/** Tira de cena as connections do site da empresa (a família fica sem connection ativa). */
const semSite = (tenant) => sql(tenant, "UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code = 'site-sandbox' AND status IN ('ACTIVE', 'PAUSED', 'AUTH_FAILED')", { c: tenant.companyId });

const novoImovel = (tenant, over = {}) => criarImovel(tenant, { addressVisibility: 'APPROXIMATE', ...over });
const publicar = (tenant, propertyId, extra = {}) => comTenant(tenant, (t) => site.publishSitePage(ctxDe(tenant), { propertyId, ...extra }, t));
const despublicar = (tenant, pageId) => comTenant(tenant, (t) => site.unpublishSitePage(ctxDe(tenant), { pageId }, t));

/** Rodadas do worker de envios até a fila vencida esvaziar (outros testes do mesmo banco deixam envios na fila). `now` adianta o relógio da rodada (consulta de status devida). */
async function rodar(tenant, { now } = {}) {
  let total = { claimed: 0, sent: 0, failed: 0 };
  for (let i = 0; i < 30; i += 1) {
    const r = await runDispatchCycle(ctxDe(tenant), now ? { now } : {});
    total = { claimed: total.claimed + r.claimed, sent: total.sent + r.sent, failed: total.failed + r.failed };
    if (r.claimed === 0) break;
  }
  return total;
}

/** Instante depois da espera da consulta de status (a primeira vale 30 s por padrão): `segundos` à frente de agora. */
const depois = (segundos) => new Date(Date.now() + segundos * 1000);

const pagina = async (tenant, id) => (await sql(tenant, 'SELECT * FROM integration.site_pages WHERE id = :id', { id }))[0];
const envio = async (tenant, id) => (await sql(tenant, 'SELECT * FROM integration.dispatches WHERE id = :id', { id }))[0];
const eventosDoEnvio = (tenant, dispatchId, tipo) => sql(tenant, "SELECT * FROM integration.outbox_events WHERE company_id = :c AND event_type = :t AND payload_json->>'dispatchId' = :d", { c: tenant.companyId, t: tipo, d: dispatchId });

/** Roda os consumidores (reações do domínio) dos eventos de confirmação e de falha do envio, como o despachante do outbox. */
async function consumir(tenant) {
  await comTenant(tenant, async (t) => {
    for (const tipo of ['integration.dispatch.confirmed', 'integration.dispatch.failed']) {
      const rows = await OutboxEvent.findAll({ where: { companyId: tenant.companyId, eventType: tipo }, order: [['created_at', 'ASC']], transaction: t });
      for (const e of rows) await runEventConsumers(e, t);
    }
  });
}

/** Evento do site (formato do sandbox). `status`: pending, live, removed, error. */
const evento = (pageKey, publicationId, status, extra = {}) => ({ id: `evt-site-${uniqueSuffix()}`, type: 'page.status', api_version: 'v1', page: { key: pageKey, publicationId, status, ...extra } });
const rodarIntake = (tenant) => env.rodar(tenant);

module.exports = {
  ...env, conectar, configurar, semSite, novoImovel, publicar, despublicar, rodar, depois, pagina, envio, eventosDoEnvio, consumir, evento, rodarIntake, site, store,
};
