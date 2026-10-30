'use strict';

// Marco 9, M9-D259 — ordem dos status do site pelo webhook assinado: dentro do mesmo envio o status menor não regride o maior; republicar depois de despublicar abre um envio novo e é aplicado;
// FAILED depois de PENDING é aplicado e depois de CONFIRMED não. Passa pelo intake real (assinatura, esquema, ordem do worker e tratador do domínio). Banco descartável (os testes COMMITAM).
process.env.PORT = process.env.M9D259_ORDEM_PORT || '21260';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d259Env');

const { store } = env;
let tenant;
let canal;

before(async () => { tenant = (await env.carregarTenants()).tenant; env.useTempSecretStore(); await new Promise((r) => { setTimeout(r, 300); }); });
beforeEach(async () => { store.reset(); canal = await env.conectar(tenant, { config: { sandbox_publish_delay_ms: 3600000 } }); });
after(async () => { await env.semSite(tenant); await env.sequelize.close(); process.exit(0); });

/** Publica e entrega ao site; devolve { r, page, envio }, com o identificador da operação no site (o que o webhook traz). */
async function publicada(imovel) {
  const r = await env.publicar(tenant, imovel.id);
  await env.rodar(tenant);
  return { r, page: await env.pagina(tenant, r.pageId), envio: await env.envio(tenant, r.dispatchId) };
}
/** Envia o evento assinado do site e roda o worker da caixa de entrada; devolve a linha da caixa. */
async function webhook(page, publicationId, status, extra) {
  const ev = env.evento(page.page_key, publicationId, status, extra);
  const resp = await env.enviar(canal, ev);
  assert.ok([200, 202].includes(resp.status), `webhook aceito (${resp.status})`);
  await env.rodarIntake(tenant);
  await env.rodarIntake(tenant);
  const linha = (await env.inbox(tenant, 'site-sandbox', ev.id))[0];
  await env.consumir(tenant);
  return linha;
}

test('site_status_fora_de_ordem_nao_regride', async () => {
  const { r, page, envio } = await publicada(await env.novoImovel(tenant));
  const pub = envio.external_resource_id;
  // Chegam fora de ordem: o status final antes do intermediário. O final confirma; o intermediário atrasado é guardado sem aplicar e não regride nada.
  const live = await webhook(page, pub, 'live');
  assert.equal(live.applied, true);
  assert.equal((await env.envio(tenant, r.dispatchId)).status, 'CONFIRMED');
  const atrasado = await webhook(page, pub, 'pending');
  assert.equal(atrasado.applied, false, 'PENDING (0) depois de PUBLISHED (1) no mesmo envio fica no histórico, sem aplicar');
  assert.equal(atrasado.status_rank, 0);
  const p = await env.pagina(tenant, r.pageId);
  assert.deepEqual([p.status, p.site_sync_status, p.applied_status, p.applied_rank], ['PUBLISHED', 'SYNCED', 'PUBLISHED', 1]);
  assert.equal((await env.eventosDoEnvio(tenant, r.dispatchId, 'integration.dispatch.confirmed')).length, 1);
  // O mesmo status repetido (outro evento): também não duplica a confirmação.
  await webhook(page, pub, 'live');
  assert.equal((await env.eventosDoEnvio(tenant, r.dispatchId, 'integration.dispatch.confirmed')).length, 1);
});

test('site_webhook_so_aceita_assinatura_valida_e_pagina_conhecida', async () => {
  const { page, envio } = await publicada(await env.novoImovel(tenant));
  const ev = env.evento(page.page_key, envio.external_resource_id, 'live');
  const sem = await env.postar(`/v1/webhooks/${canal.provider}/${canal.canal}`, Buffer.from(JSON.stringify(ev)), { 'x-signature': 't=1,v1=00' });
  assert.ok([400, 401, 403].includes(sem.status), `assinatura inválida recusada (${sem.status})`);
  assert.equal((await env.inbox(tenant, 'site-sandbox', ev.id)).length, 0);
  // Página que não é nossa: o evento fica no histórico sem aplicar nada.
  const alheio = await webhook({ page_key: 'property:de-outro-sistema:pt-BR' }, 'pub-x', 'live');
  assert.equal(alheio.applied, false);
  // Status inédito do site: vai para a fila de erros (STATUS_UNMAPPED), nunca é presumido.
  const inedito = env.evento(page.page_key, envio.external_resource_id, 'em_revisao');
  await env.enviar(canal, inedito);
  await env.rodarIntake(tenant);
  assert.notEqual((await env.inbox(tenant, 'site-sandbox', inedito.id))[0].status, 'PROCESSED');
});

test('site_republicar_apos_despublicar_e_failed_apos_pending_sao_aplicados', async () => {
  const imovel = await env.novoImovel(tenant);
  // 1) publicar e confirmar; 2) despublicar e confirmar (UNPUBLISHED tem a mesma posição de PUBLISHED, em operações diferentes).
  const a = await publicada(imovel);
  await webhook(a.page, a.envio.external_resource_id, 'pending');
  await webhook(a.page, a.envio.external_resource_id, 'live');
  assert.equal((await env.pagina(tenant, a.r.pageId)).status, 'PUBLISHED');
  const u = await env.despublicar(tenant, a.r.pageId);
  await env.rodar(tenant);
  const envioU = await env.envio(tenant, u.dispatchId);
  const removida = await webhook(a.page, envioU.external_resource_id, 'removed');
  assert.equal(removida.applied, true);
  assert.equal((await env.pagina(tenant, a.r.pageId)).status, 'UNPUBLISHED');
  // Um PUBLISHED (rank igual) pingando no envio de retirada não é da operação dele: ignorado.
  const trocado = await webhook(a.page, envioU.external_resource_id, 'live');
  assert.equal((await env.pagina(tenant, a.r.pageId)).status, 'UNPUBLISHED', 'PUBLISHED não pertence ao envio de retirada');
  assert.ok(trocado);
  // 3) republicar o MESMO conteúdo depois de despublicar abre um envio novo, que recomeça em PENDING e é aplicado.
  const re = await env.publicar(tenant, imovel.id);
  assert.notEqual(re.dispatchId, a.r.dispatchId, 'envio novo com chave nova');
  assert.equal(re.noop, false);
  await env.rodar(tenant);
  const envioR = await env.envio(tenant, re.dispatchId);
  assert.notEqual(envioR.external_resource_id, a.envio.external_resource_id);
  const pend = await webhook(a.page, envioR.external_resource_id, 'pending');
  assert.equal(pend.applied, true, 'PENDING da republicação é aplicado, apesar do UNPUBLISHED anterior');
  assert.equal((await env.pagina(tenant, a.r.pageId)).applied_rank, 0);
  await webhook(a.page, envioR.external_resource_id, 'live');
  assert.equal((await env.pagina(tenant, a.r.pageId)).status, 'PUBLISHED', 'republicada');
  assert.equal((await env.envio(tenant, re.dispatchId)).status, 'CONFIRMED');

  // 4) FAILED depois de PENDING é aplicado: o envio falha, a página mantém o estado interno e só a sincronização vira FAILED.
  await env.configurar(tenant, canal.conn.id, { sandbox_publish_delay_ms: 3600000 });
  await env.despublicar(tenant, a.r.pageId);
  await env.rodar(tenant);
  const i2 = await env.pagina(tenant, a.r.pageId);
  await webhook(a.page, (await env.envio(tenant, i2.dispatch_id)).external_resource_id, 'removed');
  const f = await env.publicar(tenant, imovel.id);
  await env.rodar(tenant);
  const envioF = await env.envio(tenant, f.dispatchId);
  await webhook(a.page, envioF.external_resource_id, 'pending');
  const erro = await webhook(a.page, envioF.external_resource_id, 'error', { reason: 'Conteúdo recusado pelo gerenciador do site' });
  assert.equal(erro.applied, true, 'FAILED depois de PENDING é aplicado');
  assert.equal((await env.envio(tenant, f.dispatchId)).status, 'FAILED');
  const pf = await env.pagina(tenant, a.r.pageId);
  assert.deepEqual([pf.status, pf.site_sync_status], ['PENDING', 'FAILED'], 'a página nunca foi confirmada no ar: segue PENDING, e só a sincronização falhou');
  assert.match(pf.last_error, /Conteúdo recusado|site/);
  // Depois de FAILED nada mais é aplicado no mesmo envio (terminal).
  await webhook(a.page, envioF.external_resource_id, 'live');
  assert.equal((await env.pagina(tenant, a.r.pageId)).site_sync_status, 'FAILED');

  // 5) FAILED depois de CONFIRMED NÃO é aplicado: o site confirmou e depois mandou erro tardio.
  const g = await env.publicar(tenant, imovel.id);
  await env.rodar(tenant);
  const envioG = await env.envio(tenant, g.dispatchId);
  await webhook(a.page, envioG.external_resource_id, 'live');
  assert.equal((await env.envio(tenant, g.dispatchId)).status, 'CONFIRMED');
  const tardio = await webhook(a.page, envioG.external_resource_id, 'error');
  assert.ok(tardio);
  const pg = await env.pagina(tenant, a.r.pageId);
  assert.deepEqual([pg.status, pg.site_sync_status, pg.applied_status], ['PUBLISHED', 'SYNCED', 'PUBLISHED'], 'FAILED tardio ignorado');
  assert.equal((await env.envio(tenant, g.dispatchId)).status, 'CONFIRMED');
  assert.equal((await env.eventosDoEnvio(tenant, g.dispatchId, 'integration.dispatch.failed')).length, 0);
});
