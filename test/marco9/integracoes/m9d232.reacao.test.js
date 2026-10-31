'use strict';

// Marco 9, M9-D232 + M9-D220 — o anúncio de portal muda o próprio estado só por evento interno do envio, enfileira na transação do domínio, compensa por novo envio e não é
// alterado pela falha ou pela ausência de resposta do portal. Banco descartável.
process.env.PORT = process.env.M9D232_REACAO_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = require('../_helpers/m9d232Env');
const reacao = require('../_helpers/reacaoD220');
const { programavel, erroHttp } = require('../_helpers/m9d214Scripted');
const { instalarTemporario, restaurarAdaptadores } = require('../_helpers/m9d250Env');
const portal = require('../../../src/features/integrations/portal');
const store = require('../../../src/features/integrations/providers/portal/sandbox/portal.sandbox.store');
const { PortalAdapter } = require('../../../src/features/integrations/providers/portal/portal.port');
const { confirmDispatch } = require('../../../src/features/integrations/dispatch/worker/worker.confirm');
const { transitionDispatch } = require('../../../src/features/integrations/dispatch');
const { processClaimed } = require('../../../src/features/integrations/dispatch/worker');

const { sequelize, comTenant } = env;
let tenant;
let zap;
before(async () => { tenant = await env.carregar(); [zap] = await env.tresPortais(['portal-zap-sandbox']); });
afterEach(() => { restaurarAdaptadores(); store.setDown(zap.id, false); });
after(async () => { await sequelize.close(); process.exit(0); });

const publicar = (propertyId) => comTenant(tenant, (t) => portal.publishToPortals(env.ctxDe(tenant), { propertyId, connectionIds: [zap.id] }, t));
const vinculo = async (propertyId) => (await env.vinculos(propertyId))[0];
const confirmar = (dispatchId, externalResourceId) => comTenant(tenant, (t) => confirmDispatch(env.ctxDe(tenant), dispatchId, { source: 'STATUS_QUERY', status: 'PUBLISHED', externalResourceId }, t));
const mudancas = (propertyId) => reacao.contar(env, "SELECT count(*)::int AS n FROM integration.outbox_events WHERE company_id = :c AND event_type = 'properties.portal_listing.status_changed' AND aggregate_id = :p", { p: propertyId });

test('portal_d220_confirmacao_so_por_evento_interno_e_idempotente', async () => {
  const imovel = await env.criarImovel(tenant);
  const r = await publicar(imovel.id);
  await env.entregar(r.items[0].dispatchId);
  assert.equal((await vinculo(imovel.id)).status, 'PUBLISHING', 'a resposta 200 do portal não publica o anúncio');
  const [envio] = await env.envios((await vinculo(imovel.id)).id);
  await confirmar(envio.id, envio.external_resource_id);
  assert.equal((await vinculo(imovel.id)).status, 'PUBLISHING', 'confirmar o envio não muda o anúncio antes do evento ser consumido');
  const antes = await mudancas(imovel.id);
  await reacao.consumirDuasVezes(env, 'integration.dispatch.confirmed', envio.id);
  const v = await vinculo(imovel.id);
  assert.equal(v.status, 'PUBLISHED');
  assert.equal(v.external_listing_id, envio.external_resource_id);
  assert.equal(await reacao.reacoesAuditadas(env, 'integrations.portal.dispatch_confirmed', v.id), 1, 'duas entregas do mesmo evento, uma reação');
  assert.equal(await mudancas(imovel.id), antes + 1, 'o evento properties.portal_listing.status_changed sai uma vez');
});

test('portal_d220_falha_do_portal_vai_a_error_sem_perder_o_imovel_e_republica', async () => {
  const Portal = programavel(PortalAdapter, 'portal-zap-sandbox', ['publishListing', 'updateListing', 'unpublishListing', 'getListingStatus']);
  Portal.S.aoChamar = async (op) => { if (op === 'publishListing') throw erroHttp(422); };
  instalarTemporario(Portal);
  const imovel = await env.criarImovel(tenant);
  const r = await publicar(imovel.id);
  await env.entregar(r.items[0].dispatchId);
  const falho = (await env.envios((await vinculo(imovel.id)).id))[0];
  assert.equal(falho.status, 'FAILED');
  assert.equal((await vinculo(imovel.id)).status, 'PUBLISHING', 'o estado só muda quando o evento é consumido');
  await reacao.consumirDuasVezes(env, 'integration.dispatch.failed', falho.id);
  const v = await vinculo(imovel.id);
  assert.equal(v.status, 'ERROR');
  assert.match(v.last_error, /O portal não aceitou o anúncio/);
  assert.equal(await reacao.reacoesAuditadas(env, 'integrations.portal.dispatch_failed', v.id), 1);
  const [{ publication_status: pub }] = await env.ler('SELECT publication_status FROM real_estate.properties WHERE id = :p', { p: imovel.id });
  assert.notEqual(pub, 'ERROR', 'o imóvel não é revertido pela falha do portal');
  // O corretor corrige e publica de novo, com o mesmo conteúdo: sai um envio NOVO (a chave ganha sufixo depois de envio recusado por inteiro).
  restaurarAdaptadores();
  const de_novo = await publicar(imovel.id);
  assert.notEqual(de_novo.items[0].dispatchId, falho.id);
  assert.equal(de_novo.items[0].noop, false);
  assert.equal((await env.envios(v.id)).length, 2);
});

test('portal_d220_fornecedor_fora_ou_sem_resposta_nao_muda_o_anuncio', async () => {
  const imovel = await env.criarImovel(tenant);
  const r = await publicar(imovel.id);
  store.setDown(zap.id, true);
  await env.entregar(r.items[0].dispatchId);
  const envio = (await env.envios((await vinculo(imovel.id)).id))[0];
  assert.ok(['RETRY_WAIT', 'UNKNOWN', 'SENDING'].includes(envio.status), envio.status);
  assert.equal(await reacao.eventoDoEnvio(env, 'integration.dispatch.failed', envio.id), null, 'portal fora do ar não é falha definitiva');
  assert.equal((await vinculo(imovel.id)).status, 'PUBLISHING');
  assert.equal((await vinculo(imovel.id)).external_listing_id, null);
});

test('portal_d220_compensacao_cria_novo_envio_de_remocao_sem_tocar_no_original', async () => {
  const imovel = await env.criarImovel(tenant);
  const r = await publicar(imovel.id);
  const envioId = r.items[0].dispatchId;
  // A publicação já saiu para o portal (em voo) quando a remoção do imóvel é pedida: o anúncio ainda não tem id externo e é dado como removido.
  await comTenant(tenant, (t) => transitionDispatch(env.ctxDe(tenant), envioId, 'SENDING', {}, { motivo: 'QA-M9 em voo' }, t));
  await comTenant(tenant, (t) => portal.unpublishFromPortals(env.ctxDe(tenant), { propertyId: imovel.id }, t));
  assert.equal((await vinculo(imovel.id)).status, 'UNPUBLISHED');
  await processClaimed(env.ctxDe(tenant), envioId);
  const original = (await env.envios((await vinculo(imovel.id)).id))[0];
  assert.ok(original.external_resource_id, 'o portal aceitou a publicação em voo');
  await confirmar(envioId, original.external_resource_id);
  await reacao.consumirDuasVezes(env, 'integration.dispatch.confirmed', envioId);
  const envios = await env.envios((await vinculo(imovel.id)).id);
  assert.deepEqual(envios.map((e) => e.operation), ['publishListing', 'unpublishListing'], 'a compensação é um NOVO envio de remoção');
  assert.equal(envios[1].idempotency_key, `compensate:${envioId}`);
  assert.equal(envios[0].status, 'CONFIRMED', 'o envio original é preservado');
  assert.equal(envios[0].external_resource_id, original.external_resource_id);
  assert.equal((await vinculo(imovel.id)).status, 'UNPUBLISHED', 'o anúncio não volta a PUBLISHING');
});

test('portal_d220_pedido_nasce_e_morre_com_a_transacao_do_dominio', async () => {
  const imovel = await env.criarImovel(tenant);
  await assert.rejects(comTenant(tenant, async (t) => {
    await portal.publishToPortals(env.ctxDe(tenant), { propertyId: imovel.id, connectionIds: [zap.id] }, t);
    throw new Error('QA-M9 rollback do domínio');
  }), /rollback do domínio/);
  assert.equal((await env.vinculos(imovel.id)).length, 0, 'sem commit do domínio não há anúncio');
  assert.equal(await reacao.contar(env, "SELECT count(*)::int AS n FROM integration.dispatches WHERE company_id = :c AND operation = 'publishListing' AND payload_snapshot::text LIKE :p", { p: `%${imovel.id}%` }), 0, 'sem commit do domínio não há envio');
});

test('portal_d220_modulo_nao_chama_fornecedor_direto', () => {
  const dir = path.join(__dirname, '../../../src/features/integrations/portal');
  const src = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'portal.boot.js').map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  for (const [f, texto] of src) {
    assert.equal(/providers\/portal\/sandbox|\.publishListing\(|\.updateListing\(|\.unpublishListing\(/.test(texto), false, `${f} chama o portal por fora do Dispatch Service`);
  }
  assert.ok(src.some(([, t]) => /registerDomainReaction/.test(t)) && src.some(([, t]) => /compensateDispatch/.test(t)));
});
