'use strict';

// Marco 9, M9-D227 — portal fora: o imóvel segue publicado internamente, o anúncio fica PENDING_SYNC com o motivo, é reprocessado até o portal aceitar e a tarefa ao marketing sai
// uma única vez, passadas 24 h; um portal fora nunca bloqueia os demais. Banco descartável (os testes COMMITAM). Nome do teste da seção 8 da demanda.
process.env.PORT = process.env.M9D227_PORTAL_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d232Env');
const e227 = require('../_helpers/m9d227Env');
const portal = require('../../../src/features/integrations/portal');
const contingency = require('../../../src/features/integrations/contingency');
const { PropertyOffer, Property } = require('../../../src/models');

const { sequelize, comTenant } = env;
let tenant;
let zap; let viva; let olx;
before(async () => {
  tenant = await env.carregar();
  contingency.installContingency();
  [zap, viva, olx] = await env.tresPortais();
});
beforeEach(async () => { await e227.limparContingencias(tenant); await e227.limparCircuito(tenant); await e227.limparPendentes(tenant); });
after(async () => { await e227.drenarEventos(tenant); await e227.limparContingencias(tenant); await e227.limparCircuito(tenant); await e227.limparPendentes(tenant); await e227.desativarConexoesDeTeste(tenant); await sequelize.close(); process.exit(0); });

const publicar = (propertyId, connectionIds) => comTenant(tenant, (t) => portal.publishToPortals(env.ctxDe(tenant), { propertyId, connectionIds }, t));
const sincronizar = () => portal.syncListingStatuses({ group: env.grupo, company: env.empresa });
const mudarPreco = (propertyId, preco) => comTenant(tenant, (t) => PropertyOffer.update({ askingPrice: preco }, { where: { propertyId }, transaction: t }));
const vinculoDe = async (propertyId, con) => (await env.vinculos(propertyId)).find((v) => v.connection_id === con.id);
const enviosFila = (listingId) => env.ler("SELECT * FROM integration.dispatches WHERE company_id = :c AND aggregate_type = 'PortalListing' AND aggregate_id = :l AND status IN ('PENDING','RETRY_WAIT') ORDER BY created_at", { l: listingId });

async function entregarTudo(propertyId) {
  const r = await publicar(propertyId);
  for (const i of r.items) await env.entregar(i.dispatchId);
  await sincronizar();
  return r;
}

test('contingencia_portal_publicacao_interna_mantida_e_reprocessada', async () => {
  const imoveis = [];
  for (let i = 0; i < 18; i += 1) {
    const im = await env.criarImovel(tenant);
    const r = await publicar(im.id, [zap.id]);
    await env.entregar(r.items[0].dispatchId);
    imoveis.push(im);
  }
  await sincronizar();
  assert.deepEqual([...new Set((await Promise.all(imoveis.map((im) => vinculoDe(im.id, zap)))).map((v) => v.status))], ['PUBLISHED']);

  // O portal ZAP cai: circuito aberto, contingência ativa no modo "manter interno e reprocessar".
  await e227.derrubar(tenant, zap.id);
  const ativou = await e227.ciclo(tenant);
  assert.ok(ativou.activated >= 1);
  assert.equal((await e227.ativas(tenant)).find((a) => a.connectionId === zap.id).mode, 'KEEP_INTERNAL_AND_REPROCESS');

  // 18 atualizações represadas: cada anúncio fica PENDING_SYNC com o motivo; o imóvel segue publicado no ERP.
  for (const im of imoveis) { await mudarPreco(im.id, '910000.00'); await publicar(im.id, [zap.id]); }
  const pendentes = await Promise.all(imoveis.map((im) => vinculoDe(im.id, zap)));
  assert.equal(pendentes.every((v) => v.status === 'PENDING_SYNC'), true, '18 PENDING_SYNC');
  assert.ok(pendentes.every((v) => /portal está indisponível/.test(v.last_error) && v.pending_sync_since), 'o motivo e o início da espera ficam no anúncio');
  assert.ok(pendentes.every((v) => v.external_listing_id), 'o anúncio que já estava no ar continua com o id do portal');
  for (const im of imoveis) assert.equal((await comTenant(tenant, (t) => Property.findByPk(im.id, { transaction: t }))).publicationStatus, 'PUBLISHED', 'o imóvel segue PUBLISHED internamente');
  for (const v of pendentes) assert.equal((await enviosFila(v.id)).length, 1, 'o envio de cada anúncio espera na fila');
  await e227.rodarEnvios(tenant);
  assert.equal((await vinculoDe(imoveis[0].id, zap)).status, 'PENDING_SYNC', 'com o portal fora nada é dado como sincronizado');

  // Outro portal não é bloqueado: a mesma publicação nos três, e só o ZAP espera.
  const extra = await env.criarImovel(tenant);
  const tres = await publicar(extra.id);
  for (const i of tres.items.filter((x) => x.connectionId !== zap.id)) await env.entregar(i.dispatchId);
  await sincronizar();
  assert.deepEqual((await env.vinculos(extra.id)).map((v) => [v.provider_code, v.status]).sort(), [['portal-olx-sandbox', 'PUBLISHED'], ['portal-vivareal-sandbox', 'PUBLISHED'], ['portal-zap-sandbox', 'PENDING_SYNC']]);
  assert.equal(olx.id !== viva.id, true);

  // O portal volta: a primeira rodada que passa solta a fila em ordem e os 18 sincronizam.
  await e227.recuperar(tenant, zap.id);
  const volta = await e227.ciclo(tenant);
  assert.ok(volta.deactivated >= 1);
  for (let i = 0; i < 10; i += 1) { const r = await e227.rodarEnvios(tenant); if (!r.claimed) break; }
  await sincronizar();
  const depois = await Promise.all(imoveis.map((im) => vinculoDe(im.id, zap)));
  assert.equal(depois.every((v) => v.status === 'PUBLISHED' && v.last_error === null && v.pending_sync_since === null), true, 'todas as 18 sincronizadas ao voltar');
});

test('contingencia_portal_reprocessa_o_envio_recusado_e_abre_uma_tarefa_so_depois_do_prazo', async () => {
  const im = await env.criarImovel(tenant);
  await entregarTudo(im.id);
  await e227.derrubar(tenant, zap.id);
  await e227.ciclo(tenant);
  await mudarPreco(im.id, '920000.00');
  await publicar(im.id, [zap.id]);
  const v0 = await vinculoDe(im.id, zap);
  assert.equal(v0.status, 'PENDING_SYNC');

  // Antes de 24 h não há tarefa; passadas 24 h sai UMA tarefa ao responsável de marketing (nada de tarefa por reenvio).
  await e227.ciclo(tenant);
  const tarefas = () => env.ler("SELECT * FROM core.tasks WHERE company_id = :c AND related_entity_type = 'PortalListing' AND related_entity_id = :l", { l: v0.id });
  assert.equal((await tarefas()).length, 0);
  await env.ler("UPDATE integration.dispatches SET created_at = created_at - interval '50 hours' WHERE company_id = :c AND aggregate_type = 'PortalListing' AND aggregate_id = :l AND operation = 'publishListing' RETURNING id", { l: v0.id }); // o envelhecimento do teste não pode deixar o 1º envio como o mais novo
  await env.ler('UPDATE real_estate.portal_listings SET pending_sync_since = now() - interval \'25 hours\' WHERE id = :l RETURNING id', { l: v0.id });
  await e227.envelhecer(tenant, (await enviosFila(v0.id))[0].id, 25);
  const r = await e227.ciclo(tenant);
  assert.equal(r.manualTasks, 0, 'a tarefa do anúncio substitui a tarefa genérica do envio');
  assert.equal((await tarefas()).length, 1);
  assert.match((await tarefas())[0].description, /não sincronizou com o portal depois de 24 h/);
  await e227.ciclo(tenant);
  assert.equal((await tarefas()).length, 1, 'repetir a rodada não duplica');

  // O portal volta, mas o envio de atualização foi recusado de vez (FAILED): o sync reprocessa com um envio novo até o portal aceitar.
  await e227.recuperar(tenant, zap.id);
  assert.ok((await e227.ciclo(tenant)).deactivated >= 1, 'o portal voltou: a contingência encerra');
  await env.ler("UPDATE integration.dispatches SET status = 'FAILED' WHERE company_id = :c AND aggregate_type = 'PortalListing' AND aggregate_id = :l AND status IN ('PENDING','RETRY_WAIT') RETURNING id", { l: v0.id });
  assert.equal((await enviosFila(v0.id)).length, 0);
  await sincronizar();
  const novos = await enviosFila(v0.id);
  assert.equal(novos.length, 1, 'o reprocessamento criou um envio novo para o mesmo conteúdo');
  assert.equal(novos[0].operation, 'updateListing');
  await env.entregar(novos[0].id);
  await sincronizar();
  const fim = await vinculoDe(im.id, zap);
  assert.equal(fim.status, 'PUBLISHED');
  assert.equal(fim.pending_sync_since, null);
});

test('contingencia_portal_despublicacao_pendente_continua_unpublishing', async () => {
  const im = await env.criarImovel(tenant);
  await entregarTudo(im.id);
  await e227.derrubar(tenant, olx.id);
  await e227.ciclo(tenant);
  await comTenant(tenant, (t) => Property.update({ availabilityStatus: 'SOLD' }, { where: { id: im.id }, transaction: t, individualHooks: false }));
  await comTenant(tenant, (t) => portal.unpublishFromPortals(env.ctxDe(tenant), { propertyId: im.id }, t));
  const v = await vinculoDe(im.id, olx);
  assert.equal(v.status, 'UNPUBLISHING', 'a remoção só termina com a confirmação do portal');
  await e227.ciclo(tenant);
  await e227.rodarEnvios(tenant);
  assert.equal((await vinculoDe(im.id, olx)).status, 'UNPUBLISHING', 'o portal fora não dá o anúncio por removido');
});
