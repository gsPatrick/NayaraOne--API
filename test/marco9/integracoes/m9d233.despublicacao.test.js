'use strict';

// Marco 9, M9-D233 — despublicação com confirmação e reconciliação: a resposta 200 do portal não remove o anúncio, o job reenvia a cada 30 min depois do prazo de 60, até 8 vezes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d232Env');
const portal = require('../../../src/features/integrations/portal');
const store = require('../../../src/features/integrations/providers/portal/sandbox/portal.sandbox.store');

const { sequelize, comTenant } = env;
let tenant;
let zap; let viva; let olx;
before(async () => { tenant = await env.carregar(); [zap, viva, olx] = await env.tresPortais(); });
after(async () => { await sequelize.close(); });

const MIN = 60 * 1000;
const publicar = (propertyId, connectionIds) => comTenant(tenant, (t) => portal.publishToPortals(env.ctxDe(tenant), { propertyId, connectionIds }, t));
const sincronizar = () => portal.syncListingStatuses({ group: env.grupo, company: env.empresa });
const despublicar = (propertyId, connectionIds) => comTenant(tenant, (t) => portal.unpublishFromPortals(env.ctxDe(tenant), { propertyId, connectionIds }, t));
const reconciliar = (now) => portal.reconcileUnpublishing({ group: env.grupo, company: env.empresa, now });
const remocoes = (listingId) => env.ler("SELECT * FROM integration.dispatches WHERE company_id = :c AND aggregate_type = 'PortalListing' AND aggregate_id = :l AND operation = 'unpublishListing' ORDER BY created_at", { l: listingId });
const vinculo = async (propertyId, con) => (await env.vinculos(propertyId)).find((v) => v.connection_id === con.id);

/** Imóvel publicado e confirmado nos portais pedidos (envio entregue e status lido). */
async function publicado(connections) {
  connections.forEach((c) => { store.ignoreUnpublishNext(c.id, 0); store.setDown(c.id, false); }); // o estado simulado do portal é compartilhado entre os testes
  const imovel = await env.criarImovel(tenant);
  const r = await publicar(imovel.id, connections.map((c) => c.id));
  for (const i of r.items) await env.entregar(i.dispatchId); // eslint-disable-line no-await-in-loop
  await sincronizar();
  return imovel;
}
const entregarAbertos = async (listingId) => {
  for (const d of await remocoes(listingId)) if (['PENDING', 'RETRY_WAIT'].includes(d.status)) await env.entregar(d.id); // eslint-disable-line no-await-in-loop
};

test('despublicar_exige_confirmacao', async () => {
  const imovel = await publicado([zap]);
  const antes = await vinculo(imovel.id, zap);
  store.ignoreUnpublishNext(zap.id, 1); // o portal responde 200, mas o anúncio continua no ar
  const r = await despublicar(imovel.id);
  assert.deepEqual([r.items[0].status, r.items[0].dispatchId !== null], ['UNPUBLISHING', true]);
  await entregarAbertos(antes.id);
  const [d] = await remocoes(antes.id);
  assert.ok(['SUBMITTED', 'CONFIRMED'].includes(d.status), 'o portal aceitou o pedido de remoção (200)');
  await sincronizar();
  assert.equal((await vinculo(imovel.id, zap)).status, 'UNPUBLISHING', '200 não basta: o status do portal ainda mostra o anúncio ativo');
  const lista = await comTenant(tenant, (t) => portal.listPortalListings(env.ctxDe(tenant), imovel.id, t));
  assert.equal(lista.items.find((i) => i.connectionId === zap.id).statusMessage, 'Remoção aguardando confirmação do portal');
  // despublicar de novo é no-op: nenhum envio novo
  const outra = await despublicar(imovel.id);
  assert.deepEqual([outra.items[0].noop, (await remocoes(antes.id)).length], [true, 1]);
  // o portal remove de fato: o status confirma
  store.setStatus(zap.id, antes.external_listing_id, 'UNPUBLISHED');
  await sincronizar();
  assert.equal((await vinculo(imovel.id, zap)).status, 'UNPUBLISHED');
});

test('despublicar_reenvia_ate_confirmar', async () => {
  const imovel = await publicado([zap]);
  const v = await vinculo(imovel.id, zap);
  store.ignoreUnpublishNext(zap.id, 3); // as 3 primeiras remoções respondem 200 sem remover
  await despublicar(imovel.id);
  await entregarAbertos(v.id);
  const t0 = Date.now();
  let passo = 61;
  while ((await vinculo(imovel.id, zap)).status === 'UNPUBLISHING' && passo < 400) {
    await reconciliar(new Date(t0 + passo * MIN)); // eslint-disable-line no-await-in-loop
    await entregarAbertos(v.id); // eslint-disable-line no-await-in-loop
    passo += 31;
  }
  const depois = await vinculo(imovel.id, zap);
  assert.equal(depois.status, 'UNPUBLISHED', 'o job reenviou até o portal remover');
  assert.equal(depois.unpublish_attempts, 3, 'três reenvios depois do pedido inicial');
  assert.equal((await remocoes(v.id)).length, 4);
  assert.equal(depois.unpublish_exhausted_at, null);
});

test('despublicar_esgotado_gera_tarefa_urgente', async () => {
  const imovel = await publicado([zap]);
  const v = await vinculo(imovel.id, zap);
  store.ignoreUnpublishNext(zap.id, 99);
  await despublicar(imovel.id);
  await entregarAbertos(v.id);
  const t0 = Date.now();
  for (let passo = 61; passo <= 340; passo += 31) {
    await reconciliar(new Date(t0 + passo * MIN)); // eslint-disable-line no-await-in-loop
    await entregarAbertos(v.id); // eslint-disable-line no-await-in-loop
  }
  const depois = await vinculo(imovel.id, zap);
  assert.equal(depois.status, 'UNPUBLISHING');
  assert.equal(depois.unpublish_attempts, 8, 'no máximo 8 reenvios');
  assert.ok(depois.unpublish_exhausted_at, 'esgotado');
  assert.equal((await remocoes(v.id)).length, 9, 'o pedido inicial mais 8 reenvios; nada além disso');
  const tarefas = await env.ler("SELECT * FROM core.tasks WHERE company_id = :c AND related_entity_type = 'PortalListing' AND related_entity_id = :l", { l: v.id });
  assert.equal(tarefas.length, 1, 'uma tarefa só, mesmo com o job rodando de novo');
  assert.equal(tarefas[0].priority, 'URGENT');
  assert.match(tarefas[0].title, /Anúncio de imóvel indisponível no ar/);
  const erros = await env.ler("SELECT * FROM integration.integration_errors WHERE company_id = :c AND error_code = 'INTEGRATION_PORTAL_UNPUBLISH_EXHAUSTED' AND source_ref_id = :l", { l: v.id });
  assert.deepEqual([erros.length, erros[0].severity, erros[0].status], [1, 'HIGH', 'OPEN']);
});

test('portal_falha_isolada_nao_bloqueia_demais', async () => {
  const olx2 = olx; // o portal fora do ar
  const imovel = await publicado([zap, viva, olx]);
  assert.deepEqual((await env.vinculos(imovel.id)).map((v) => v.status), ['PUBLISHED', 'PUBLISHED', 'PUBLISHED']);
  store.setDown(olx2.id, true);
  const r = await despublicar(imovel.id);
  assert.equal(r.items.length, 3, 'um envio por portal, sem erro geral');
  for (const v of await env.vinculos(imovel.id)) await entregarAbertos(v.id); // eslint-disable-line no-await-in-loop
  await sincronizar();
  const vs = await env.vinculos(imovel.id);
  const doD = vs.find((v) => v.connection_id === olx2.id);
  assert.deepEqual(vs.filter((v) => v.connection_id !== olx2.id).map((v) => v.status), ['UNPUBLISHED', 'UNPUBLISHED'], 'os portais no ar confirmam');
  assert.equal(doD.status, 'UNPUBLISHING', 'o portal fora fica pendente, sem afetar os outros');
  assert.ok(doD.last_error, 'o erro fica no vínculo daquele portal');
  // o portal volta: o job consulta, o envio sai e a remoção é confirmada
  store.setDown(olx2.id, false);
  await reconciliar(new Date(Date.now() + 70 * MIN));
  await entregarAbertos(doD.id);
  await reconciliar(new Date(Date.now() + 110 * MIN));
  assert.equal((await vinculo(imovel.id, olx2)).status, 'UNPUBLISHED', 'confirmação tardia');
});

test('portal_usuario_recebe_status_por_portal', async () => {
  const imovel = await publicado([zap, viva]);
  const controller = require('../../../src/features/integrations/portal/portal.controller');
  const resposta = {};
  const res = { status(c) { resposta.status = c; return this; }, json(b) { resposta.body = b; return this; } };
  const req = { auth: { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId }, params: { id: imovel.id }, body: {}, withTenantTransaction: (fn) => comTenant(tenant, fn) };
  await new Promise((resolve, reject) => { controller.unpublish(req, res, (e) => (e ? reject(e) : resolve())); setTimeout(resolve, 1500); });
  assert.equal(resposta.status, 202, 'a operação do usuário nunca devolve erro geral por causa de um portal');
  assert.equal(resposta.body.data.code, 'INTEGRATION_PORTAL_PARTIAL_PROGRESS');
  assert.equal(resposta.body.data.message, 'Remoção iniciada: acompanhe o status de cada portal.');
  assert.deepEqual(resposta.body.data.items.map((i) => [i.providerCode, i.status]).sort(), [['portal-vivareal-sandbox', 'UNPUBLISHING'], ['portal-zap-sandbox', 'UNPUBLISHING']]);
  assert.equal(resposta.body.data.summary, '0 de 2 portais publicados');
});

test('despublicar_reenvio_a_cada_30_min_apos_prazo_de_60', async () => {
  const imovel = await publicado([zap]);
  const v = await vinculo(imovel.id, zap);
  store.ignoreUnpublishNext(zap.id, 99);
  await despublicar(imovel.id);
  const t0 = Date.now();
  const tentativas = async (min) => { await reconciliar(new Date(t0 + min * MIN)); return (await vinculo(imovel.id, zap)).unpublish_attempts; };
  assert.equal(await tentativas(59), 0, 'antes do prazo de 60 min o job não reenvia');
  assert.equal(await tentativas(61), 1, 'no prazo: consulta e reenvia');
  assert.equal(await tentativas(89), 1, 'o próximo reenvio só 30 min depois');
  assert.equal(await tentativas(92), 2);
  assert.equal(await tentativas(123), 3);
  const antes = await vinculo(imovel.id, zap);
  assert.equal(antes.status, 'UNPUBLISHING', 'o vínculo usa UNPUBLISHING até a confirmação');
  const proximo = new Date(antes.unpublish_next_attempt_at).getTime();
  assert.ok(Math.abs(proximo - (t0 + 123 * MIN) - 30 * MIN) < 2 * MIN, 'sem backoff crescente: sempre +30 min');
  for (let min = 154; min <= 340; min += 31) await tentativas(min); // eslint-disable-line no-await-in-loop
  assert.equal((await vinculo(imovel.id, zap)).unpublish_attempts, 8, 'até a 8ª');
  assert.ok(v);
});

test('despublicar_evento_do_read_model_despublica_em_todos_os_portais', async () => {
  // gatilho do livro: o imóvel deixa de ser publicável (evento property.public.unpublish) e cada portal recebe o seu pedido de remoção
  const { onPublicUnpublish } = require('../../../src/features/integrations/portal/portal.events');
  const imovel = await publicado([zap, viva, olx]);
  const r = await comTenant(tenant, (t) => onPublicUnpublish({ groupId: tenant.groupId, companyId: tenant.companyId, payloadJson: { propertyId: imovel.id, reasons: ['SOLD'] } }, t));
  assert.deepEqual(r.items.map((i) => i.status), ['UNPUBLISHING', 'UNPUBLISHING', 'UNPUBLISHING']);
  const vs = await env.vinculos(imovel.id);
  for (const v of vs) assert.equal((await remocoes(v.id)).length, 1, `${v.provider_code}: um envio de remoção por portal`); // eslint-disable-line no-await-in-loop
  assert.ok(vs.every((v) => v.unpublish_requested_at && v.unpublish_next_attempt_at));
});
