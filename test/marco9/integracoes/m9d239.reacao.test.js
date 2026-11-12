'use strict';

// Marco 9, M9-D239 + M9-D220 — o conteúdo muda o próprio estado só por evento interno do envio, enfileira na transação do domínio, compensa por novo envio e não é alterado pela falha
// ou pela ausência de resposta da rede. Banco descartável (os testes COMMITAM).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = require('../_helpers/m9d239Env');
const reacao = require('../_helpers/reacaoD220');
const { clearCircuitCache } = require('../../../src/features/integrations/health');
const { erroHttp } = require('../_helpers/m9d214Scripted');
const mktRepo = require('../../../src/features/marketing/content/pipeline.repository');

const { sequelize, comTenant, ctxDe, carregarTenants, limparTudo, restaurar, dispatch, instalarRedes, removerRedes, criarConteudo, dispatchesDe, publicar } = env;
let tenant;
let redes;
let leitor;
const ctx = () => ctxDe(tenant);
const ids = (n) => redes.slice(0, n).map((r) => r.connection.id);
const rodar = () => dispatch.runDispatchCycle(ctx(), { now: new Date() });
const statusDe = async (itemId) => (await env.sql(tenant, 'SELECT status FROM marketing.content_items WHERE id = :id', { id: itemId }))[0].status;
const poremEmPublicacao = (itemId, status = 'PUBLISHING') => comTenant(tenant, (t) => mktRepo.setStatus(itemId, status, tenant.userId, t));
const deRede = (linhas, rede) => linhas.find((l) => l.provider_code === rede.code);
const auditadas = (consumidor, itemId) => reacao.reacoesAuditadas(leitor, consumidor, itemId);

before(async () => {
  ({ tenant } = await carregarTenants());
  leitor = { tenant, comTenant, ler: (q, r = {}) => env.sql(tenant, q, { c: tenant.companyId, ...r }) };
});
beforeEach(async () => { redes = await instalarRedes(tenant); clearCircuitCache(); await limparTudo(tenant); });
after(async () => { await env.limparConteudos(); removerRedes(); restaurar(); await sequelize.close(); process.exit(0); });

test('social_d220_conteudo_so_muda_por_evento_interno_e_espera_a_rede_em_voo', async () => {
  const c = await criarConteudo(tenant, {});
  await publicar(tenant, { contentItemId: c.itemId, connectionIds: ids(2) });
  await poremEmPublicacao(c.itemId);
  redes[1].S.fila('publishPost', [{ erro: erroHttp(503) }]);
  await rodar();
  const linhas = await dispatchesDe(tenant, c.itemId);
  const [a, b] = [deRede(linhas, redes[0]), deRede(linhas, redes[1])];
  assert.equal(a.status, 'CONFIRMED', 'a resposta da rede confirmou o envio');
  assert.equal(b.status, 'RETRY_WAIT', 'a outra rede ainda tenta');
  assert.equal(await statusDe(c.itemId), 'PUBLISHING', 'a resposta da rede não muda o conteúdo antes do evento ser consumido');
  await reacao.consumirDuasVezes(leitor, 'integration.dispatch.confirmed', a.id);
  assert.equal(await statusDe(c.itemId), 'PUBLISHING', 'com a outra rede em voo, o conteúdo espera');
  // A segunda rede conclui: só então o conteúdo publica, uma vez, mesmo com o evento entregue duas vezes.
  await env.forcar(tenant, b.id, "next_attempt_at = now() - interval '1 second'");
  await rodar();
  assert.equal((await dispatchesDe(tenant, c.itemId)).every((l) => l.status === 'CONFIRMED'), true);
  await reacao.consumirDuasVezes(leitor, 'integration.dispatch.confirmed', b.id);
  assert.equal(await statusDe(c.itemId), 'PUBLISHED');
  assert.equal(await auditadas('integrations.social.dispatch_confirmed', c.itemId), 1, 'duas entregas do mesmo evento, uma reação');
});

test('social_d220_falha_de_uma_rede_nao_desfaz_a_que_publicou_e_falha_geral_vai_a_failed', async () => {
  const c = await criarConteudo(tenant, {});
  await publicar(tenant, { contentItemId: c.itemId, connectionIds: ids(2) });
  await poremEmPublicacao(c.itemId);
  redes[1].S.fila('publishPost', [{ erro: erroHttp(401) }]);
  await rodar();
  const [ok, falho] = [deRede(await dispatchesDe(tenant, c.itemId), redes[0]), deRede(await dispatchesDe(tenant, c.itemId), redes[1])];
  assert.deepEqual([ok.status, falho.status], ['CONFIRMED', 'FAILED']);
  await reacao.consumirDuasVezes(leitor, 'integration.dispatch.failed', falho.id);
  assert.equal(await statusDe(c.itemId), 'PUBLISHED', 'uma rede publicou: o conteúdo segue publicado e a rede que falhou fica FAILED no seu envio');
  assert.equal(deRede(await dispatchesDe(tenant, c.itemId), redes[0]).status, 'CONFIRMED');
  assert.equal(await auditadas('integrations.social.dispatch_failed', c.itemId), 1);
  // Nenhuma rede publicou: o conteúdo vai a FAILED para o Marketing reagendar; o motivo é a classe do erro, nunca o texto do fornecedor.
  const d = await criarConteudo(tenant, {});
  // (a conexão que recebeu 401 acima fica pausada por credencial: o segundo conteúdo usa a primeira e a terceira rede)
  await publicar(tenant, { contentItemId: d.itemId, connectionIds: [redes[0].connection.id, redes[2].connection.id] });
  await poremEmPublicacao(d.itemId);
  [redes[0], redes[2]].forEach((r) => r.S.fila('publishPost', [{ erro: erroHttp(400) }]));
  await rodar();
  const falhos = (await dispatchesDe(tenant, d.itemId)).filter((l) => l.status === 'FAILED');
  assert.equal(falhos.length, 2);
  await reacao.consumirDuasVezes(leitor, 'integration.dispatch.failed', falhos[0].id);
  assert.equal(await statusDe(d.itemId), 'FAILED');
});

test('social_d220_rede_sem_resposta_ou_fora_do_ar_nao_muda_o_conteudo', async () => {
  const c = await criarConteudo(tenant, {});
  await publicar(tenant, { contentItemId: c.itemId, connectionIds: ids(1) });
  await poremEmPublicacao(c.itemId);
  redes[0].S.fila('publishPost', [{ recebeEDaTimeout: true }]);
  await rodar();
  const [envio] = await dispatchesDe(tenant, c.itemId);
  assert.equal(envio.status, 'UNKNOWN', 'o timeout depois do envio é incerto');
  assert.equal(await reacao.eventoDoEnvio(leitor, 'integration.dispatch.failed', envio.id), null, 'sem resposta não é falha definitiva');
  assert.equal(await reacao.eventoDoEnvio(leitor, 'integration.dispatch.confirmed', envio.id), null);
  assert.equal(await statusDe(c.itemId), 'PUBLISHING');
  // Conteúdo que o Marketing ainda não pôs em publicação não é movido por evento de rede.
  const d = await criarConteudo(tenant, {});
  await publicar(tenant, { contentItemId: d.itemId, connectionIds: ids(1) });
  await rodar();
  const [enviado] = await dispatchesDe(tenant, d.itemId);
  await reacao.consumirDuasVezes(leitor, 'integration.dispatch.confirmed', enviado.id);
  assert.equal(await statusDe(d.itemId), 'APPROVED');
});

test('social_d220_compensacao_cria_novo_envio_de_remocao_sem_tocar_no_original', async () => {
  const c = await criarConteudo(tenant, {});
  await publicar(tenant, { contentItemId: c.itemId, connectionIds: ids(1) });
  await rodar();
  const [original] = await dispatchesDe(tenant, c.itemId);
  assert.equal(original.status, 'CONFIRMED');
  // O conteúdo foi retirado (ARCHIVED) enquanto o post estava em voo: a rede passa a mostrar o que o ERP já retirou.
  await poremEmPublicacao(c.itemId, 'ARCHIVED');
  await reacao.consumirDuasVezes(leitor, 'integration.dispatch.confirmed', original.id);
  const envios = await dispatchesDe(tenant, c.itemId);
  assert.deepEqual(envios.map((e) => e.operation).sort(), ['deletePost', 'publishPost'], 'a compensação é um NOVO envio de remoção');
  const remocao = envios.find((e) => e.operation === 'deletePost');
  assert.equal(remocao.idempotency_key, `compensate:${original.id}`);
  assert.equal(envios.find((e) => e.operation === 'publishPost').status, 'CONFIRMED', 'o envio original é preservado');
  assert.equal(await statusDe(c.itemId), 'ARCHIVED', 'o conteúdo não volta a PUBLISHING');
  assert.equal(await auditadas('integrations.social.dispatch_confirmed', c.itemId), 1, 'duas entregas, uma compensação');
});

test('social_d220_pedido_nasce_e_morre_com_a_transacao_do_dominio', async () => {
  const c = await criarConteudo(tenant, {});
  await assert.rejects(comTenant(tenant, async (t) => {
    await env.social.publishToSocial(ctx(), { contentItemId: c.itemId, connectionIds: ids(2), transaction: t });
    throw new Error('QA-M9 rollback do domínio');
  }), /rollback do domínio/);
  assert.equal((await dispatchesDe(tenant, c.itemId)).length, 0, 'sem commit do domínio não há envio');
});

test('social_d220_modulo_nao_chama_fornecedor_direto', () => {
  const dir = path.join(__dirname, '../../../src/features/integrations/social');
  const src = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  for (const [f, texto] of src) {
    assert.equal(/providers\/social|adapterInvoke|\.publishPost\(|\.deletePost\(|\.getPostStatus\(/.test(texto), false, `${f} chama a rede por fora do Dispatch Service`);
  }
  assert.ok(src.some(([, t]) => /registerDomainReaction/.test(t)) && src.some(([, t]) => /compensateDispatch/.test(t)));
});
