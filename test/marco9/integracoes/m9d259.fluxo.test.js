'use strict';

// Marco 9, M9-D259 — publicação de páginas no site: 202 não confirma, status confirma, o evento de confirmação sai uma vez e só ele marca a página como publicada, o timeout vira UNKNOWN e a
// reconciliação consulta o site antes de repetir, a retirada confirma por status e é idempotente, e o site fora não desfaz o estado interno. Banco descartável (os testes COMMITAM).
process.env.PORT = process.env.M9D259_FLUXO_PORT || '21259';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d259Env');
const { reconcileDispatch } = require('../../../src/features/integrations/dispatch/reconcile');
const { Property } = require('../../../src/models');
const rm = require('../../../src/features/properties/publicReadModel');

const { comTenant, ctxDe, store } = env;
env.forcar = require('../../integrations/dispatch/dispatchHelpers').forcar;
let tenant;
let canal;

before(async () => { tenant = (await env.carregarTenants()).tenant; env.useTempSecretStore(); await new Promise((r) => { setTimeout(r, 300); }); });
beforeEach(async () => { store.reset(); canal = await env.conectar(tenant, { config: { sandbox_publish_delay_ms: 3600000 } }); });
after(async () => { await env.semSite(tenant); await env.sequelize.close(); process.exit(0); });

const chamadas = (op) => store.calls().filter((c) => c.connectionId === canal.conn.id && (!op || c.operation === op));
/** Faz o site mostrar a página como no ar agora (o atraso de publicação do sandbox já passou). */
const noAr = (pageKey) => { store.find(canal.conn.id, pageKey).liveAt = Date.now() - 1; };
/** Publica, entrega ao site (worker) e devolve a página e o envio já lidos do banco. */
async function publicadaEEntregue(imovel) {
  const r = await env.publicar(tenant, imovel.id);
  await env.rodar(tenant);
  return { r, page: await env.pagina(tenant, r.pageId), envio: await env.envio(tenant, r.dispatchId) };
}
const alterarImovel = async (id, title) => {
  await comTenant(tenant, (t) => Property.update({ title }, { where: { id }, transaction: t }));
  await comTenant(tenant, (t) => rm.syncPublicPropertyReadModel(id, ctxDe(tenant), t));
};

test('site_publish_page_202_nao_confirma_ate_status_publicado', async () => {
  const imovel = await env.novoImovel(tenant);
  const { r, page, envio } = await publicadaEEntregue(imovel);
  // O site respondeu 202 (pendente): o envio foi aceito (SUBMITTED), mas a página NÃO está publicada no ERP.
  assert.equal(envio.status, 'SUBMITTED');
  assert.match(envio.external_resource_id, /^pub-/);
  assert.equal(page.status, 'PENDING');
  assert.equal(page.site_sync_status, 'PENDING_SYNC');
  assert.equal((await env.eventosDoEnvio(tenant, r.dispatchId, 'integration.dispatch.confirmed')).length, 0);
  await env.consumir(tenant);
  assert.equal((await env.pagina(tenant, r.pageId)).status, 'PENDING', 'nenhuma reação marca a página como publicada sem confirmação');
  // Consulta ainda não devida: o relógio da rodada não passou da espera; consulta devida com o site ainda pendente: segue SUBMITTED.
  await env.rodar(tenant, { now: env.depois(5) });
  assert.equal(chamadas('getPageStatus').length, 0, 'a primeira consulta só vale depois da espera configurada');
  await env.rodar(tenant, { now: env.depois(60) });
  assert.equal(chamadas('getPageStatus').length, 1);
  assert.equal((await env.envio(tenant, r.dispatchId)).status, 'SUBMITTED');
  assert.equal((await env.pagina(tenant, r.pageId)).status_checks, 1);
  // O site confirma por status: o envio vai a CONFIRMED UMA vez e só então a página vira PUBLISHED.
  noAr(page.page_key);
  await env.rodar(tenant, { now: env.depois(1200) });
  const depois = await env.envio(tenant, r.dispatchId);
  assert.equal(depois.status, 'CONFIRMED');
  assert.equal((await env.eventosDoEnvio(tenant, r.dispatchId, 'integration.dispatch.confirmed')).length, 1, 'integration.dispatch.confirmed uma vez');
  assert.equal((await env.pagina(tenant, r.pageId)).status, 'PENDING', 'o envio confirmou, mas a página só muda pelo evento');
  await env.consumir(tenant);
  await env.consumir(tenant);
  const final = await env.pagina(tenant, r.pageId);
  assert.deepEqual([final.status, final.site_sync_status, final.published_hash], ['PUBLISHED', 'SYNCED', final.content_hash]);
  assert.ok(final.published_at);
  await env.rodar(tenant, { now: env.depois(9000) });
  assert.equal((await env.eventosDoEnvio(tenant, r.dispatchId, 'integration.dispatch.confirmed')).length, 1, 'rodar de novo não repete o evento');
});

test('site_publish_200_do_site_com_pagina_no_ar_na_resposta_tambem_nao_confirma', async () => {
  await env.configurar(tenant, canal.conn.id, { sandbox_publish_delay_ms: 0, sandbox_immediate_live: true });
  const imovel = await env.novoImovel(tenant);
  const { r, envio, page } = await publicadaEEntregue(imovel);
  assert.equal(envio.external_status, 'PUBLISHED', 'a resposta do site já dizia que estava no ar');
  assert.equal(envio.status, 'SUBMITTED', 'mas a resposta nunca confirma');
  assert.equal(page.status, 'PENDING');
  await env.rodar(tenant, { now: env.depois(60) });
  assert.equal((await env.envio(tenant, r.dispatchId)).status, 'CONFIRMED', 'só a consulta de status confirma');
});

test('site_publish_page_idempotente_mesma_chave_nao_duplica', async () => {
  const imovel = await env.novoImovel(tenant);
  const a = await env.publicar(tenant, imovel.id);
  const b = await env.publicar(tenant, imovel.id);
  assert.equal(b.noop, true);
  assert.equal(b.dispatchId, a.dispatchId, 'o mesmo conteúdo e a mesma página: o mesmo envio');
  await env.rodar(tenant);
  const c = await env.publicar(tenant, imovel.id);
  assert.equal(c.dispatchId, a.dispatchId, 'com o envio já aceito pelo site também não cria outro');
  assert.equal(store.pagesOf(canal.conn.id).length, 1);
  assert.equal(store.pagesOf(canal.conn.id)[0].publishCount, 1, 'o site recebeu UMA publicação');
  const n = await env.sql(tenant, "SELECT count(*)::int AS n FROM integration.dispatches WHERE aggregate_type = 'SitePage' AND aggregate_id = :id", { id: a.pageId });
  assert.equal(n[0].n, 1);
  // Já no ar e sincronizada: pedir de novo a mesma versão não faz nada.
  noAr((await env.pagina(tenant, a.pageId)).page_key);
  await env.rodar(tenant, { now: env.depois(60) });
  await env.consumir(tenant);
  assert.equal((await env.publicar(tenant, imovel.id)).noop, true);
  // Conteúdo novo do read model é outra versão: envio novo para a MESMA página.
  await alterarImovel(imovel.id, 'Apartamento reformado no Batel');
  const d = await env.publicar(tenant, imovel.id);
  assert.notEqual(d.dispatchId, a.dispatchId);
  assert.equal(d.pageId, a.pageId);
  assert.notEqual(d.contentHash, a.contentHash);
  assert.equal((await env.pagina(tenant, a.pageId)).status, 'PUBLISHED', 'enquanto a versão nova não chega ao site a página segue publicada');
});

test('site_publish_timeout_vira_unknown_e_reconcilia_por_get_page_status', async () => {
  await env.configurar(tenant, canal.conn.id, { sandbox_publish_delay_ms: 3600000, sandbox_fault: 'TIMEOUT_AFTER_SEND' });
  const imovel = await env.novoImovel(tenant);
  const r = await env.publicar(tenant, imovel.id);
  await env.rodar(tenant);
  const incerto = await env.envio(tenant, r.dispatchId);
  assert.equal(incerto.status, 'UNKNOWN', 'o site recebeu, a resposta não voltou: resultado incerto, nunca presumido');
  assert.equal(chamadas('publishPage').length, 1);
  assert.equal(chamadas('getPageStatus').length, 0);
  // A reconciliação consulta o site pelo pageKey ANTES de repetir qualquer coisa.
  const rec = await reconcileDispatch(ctxDe(tenant), r.dispatchId, { now: env.depois(86400) });
  assert.ok(rec.status);
  assert.ok(chamadas('getPageStatus').length >= 1, 'consultou o status da página no site');
  assert.equal(chamadas('publishPage').length, 1, 'e não repetiu a publicação');
  const achado = await env.envio(tenant, r.dispatchId);
  assert.equal(achado.status, 'SUBMITTED', 'o site tem a página em andamento: o envio volta a SUBMITTED, esperando o status final');
  assert.equal(achado.external_resource_id, store.find(canal.conn.id, (await env.pagina(tenant, r.pageId)).page_key).publicationId);
  noAr((await env.pagina(tenant, r.pageId)).page_key);
  await env.rodar(tenant, { now: env.depois(9000) });
  assert.equal((await env.envio(tenant, r.dispatchId)).status, 'CONFIRMED');
  await env.consumir(tenant);
  assert.equal((await env.pagina(tenant, r.pageId)).status, 'PUBLISHED');
  assert.equal(chamadas('publishPage').length, 1);
});

test('site_unpublish_page_confirma_por_status_e_e_idempotente', async () => {
  await env.configurar(tenant, canal.conn.id, { sandbox_publish_delay_ms: 0 });
  const imovel = await env.novoImovel(tenant);
  const { r, page } = await publicadaEEntregue(imovel);
  await env.rodar(tenant, { now: env.depois(60) });
  await env.consumir(tenant);
  assert.equal((await env.pagina(tenant, r.pageId)).status, 'PUBLISHED');
  // Retirada: a página vai a UNPUBLISHING e o site responde removida, mas só o status confirma.
  const u = await env.despublicar(tenant, r.pageId);
  assert.equal(u.status, 'UNPUBLISHING');
  assert.equal((await env.despublicar(tenant, r.pageId)).dispatchId, u.dispatchId, 'repetir durante a retirada não cria outro envio');
  await env.rodar(tenant);
  const envio = await env.envio(tenant, u.dispatchId);
  assert.equal(envio.status, 'SUBMITTED', 'a resposta do site à retirada não confirma');
  assert.equal((await env.pagina(tenant, r.pageId)).status, 'UNPUBLISHING');
  await env.rodar(tenant, { now: env.depois(600) });
  assert.equal((await env.envio(tenant, u.dispatchId)).status, 'CONFIRMED');
  await env.consumir(tenant);
  const fim = await env.pagina(tenant, r.pageId);
  assert.deepEqual([fim.status, fim.site_sync_status], ['UNPUBLISHED', 'SYNCED']);
  assert.ok(fim.unpublished_at);
  assert.equal((await env.despublicar(tenant, r.pageId)).noop, true, 'página já retirada: nada a fazer');
  assert.equal((await env.eventosDoEnvio(tenant, u.dispatchId, 'integration.dispatch.confirmed')).length, 1);
  // Página que o site não conhece (perdeu o registro): a remoção é idempotente, responde removida e a consulta 404 é a própria confirmação.
  const outro = await env.novoImovel(tenant);
  const o = await publicadaEEntregue(outro);
  store.reset();
  const ur = await env.despublicar(tenant, o.r.pageId);
  await env.rodar(tenant);
  await env.rodar(tenant, { now: env.depois(600) });
  assert.equal((await env.envio(tenant, ur.dispatchId)).status, 'CONFIRMED');
  await env.consumir(tenant);
  assert.equal((await env.pagina(tenant, o.r.pageId)).status, 'UNPUBLISHED');
  assert.ok(page.page_key);
});

test('site_unpublish_de_pagina_que_nunca_saiu_nao_chama_o_site', async () => {
  const imovel = await env.novoImovel(tenant);
  const r = await env.publicar(tenant, imovel.id);
  const u = await env.despublicar(tenant, r.pageId);
  assert.equal(u.status, 'UNPUBLISHED');
  assert.equal((await env.envio(tenant, r.dispatchId)).status, 'CANCELLED', 'o envio que esperava na fila foi cancelado');
  await env.rodar(tenant);
  assert.equal(chamadas().length, 0, 'o site nem soube da página');
});

test('site_fora_mantem_pagina_publicada_internamente_e_reprocessa', async () => {
  await env.configurar(tenant, canal.conn.id, { sandbox_publish_delay_ms: 0 });
  const imovel = await env.novoImovel(tenant);
  const { r } = await publicadaEEntregue(imovel);
  await env.rodar(tenant, { now: env.depois(60) });
  await env.consumir(tenant);
  const antes = await env.pagina(tenant, r.pageId);
  assert.deepEqual([antes.status, antes.site_sync_status], ['PUBLISHED', 'SYNCED']);
  // O site cai (503) e o conteúdo muda: a página segue PUBLISHED no ERP, só a sincronização fica pendente.
  await env.configurar(tenant, canal.conn.id, { sandbox_publish_delay_ms: 0, sandbox_fault: '503' });
  await alterarImovel(imovel.id, 'Apartamento com vista para o parque');
  const nova = await env.publicar(tenant, imovel.id);
  await env.rodar(tenant);
  const durante = await env.pagina(tenant, r.pageId);
  assert.equal(durante.status, 'PUBLISHED', 'o estado interno não foi desfeito');
  assert.equal(durante.site_sync_status, 'PENDING_SYNC');
  assert.equal(durante.published_hash, antes.published_hash, 'a versão no ar ainda é a anterior');
  assert.notEqual(durante.content_hash, antes.published_hash);
  const retry = await env.envio(tenant, nova.dispatchId);
  assert.equal(retry.status, 'RETRY_WAIT', 'o envio foi para a política de nova tentativa');
  assert.ok(retry.next_attempt_at);
  // O site volta: o envio é reprocessado (mesma chave), aceito, confirmado por status e a página sincroniza.
  await env.configurar(tenant, canal.conn.id, { sandbox_publish_delay_ms: 0 });
  await env.forcar(tenant, nova.dispatchId, "next_attempt_at = now() - interval '1 second'");
  await env.rodar(tenant);
  assert.equal((await env.envio(tenant, nova.dispatchId)).status, 'SUBMITTED');
  await env.rodar(tenant, { now: env.depois(600) });
  assert.equal((await env.envio(tenant, nova.dispatchId)).status, 'CONFIRMED');
  await env.consumir(tenant);
  const fim = await env.pagina(tenant, r.pageId);
  assert.deepEqual([fim.status, fim.site_sync_status, fim.published_hash], ['PUBLISHED', 'SYNCED', fim.content_hash]);
  assert.notEqual(fim.published_hash, antes.published_hash);
  assert.equal(chamadas('publishPage').length, 2, 'duas versões publicadas, nenhuma duplicada pela nova tentativa');
});
