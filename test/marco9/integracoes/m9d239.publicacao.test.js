'use strict';

// Marco 9, M9-D239 — só sai conteúdo aprovado e inalterado; a NAY só gera rascunho; publicação automática desligada por padrão.
// Testes 1, 2, 7 e 8 da demanda. Roda em banco descartável (os testes COMMITAM).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  sequelize, comTenant, carregarTenants, ctxDe, limparTudo, limparConfig, config, eventos, restaurar, forcar, ler, dispatch,
  instalarRedes, removerRedes, criarConteudo, dispatchesDe, publicar, sql, social,
} = require('../_helpers/m9d239Env');
const { clearCircuitCache } = require('../../../src/features/integrations/health');
const nay = require('../../../src/features/marketing/content/pipeline.nayPort');
const contentService = require('../../../src/features/marketing/content/content.service');

let tenant;
let redes;
const ctx = () => ctxDe(tenant);
const ids = () => redes.map((r) => r.connection.id);
const CHAVES = ['integration.social.auto_publish_enabled', 'integration.social.post_dedup_window_days'];

before(async () => { ({ tenant } = await carregarTenants()); });
beforeEach(async () => {
  redes = await instalarRedes(tenant);
  clearCircuitCache();
  await limparConfig(tenant, CHAVES);
  await limparTudo(tenant);
});
after(async () => { await limparConfig(tenant, CHAVES); removerRedes(); nay.clearNayDraftProvider(); restaurar(); await sequelize.close(); });

const recusa = (statusCode, code) => (e) => e.statusCode === statusCode && e.code === code;

test('social_publica_somente_conteudo_aprovado', async () => {
  const rascunho = await criarConteudo(tenant, { estado: 'DRAFT' });
  const pendente = await criarConteudo(tenant, { estado: 'PENDING_APPROVAL' });
  for (const c of [rascunho, pendente]) {
    await assert.rejects(publicar(tenant, { contentItemId: c.itemId, connectionIds: ids() }), (e) => recusa(403, 'INTEGRATION_SOCIAL_CONTENT_NOT_APPROVED')(e) && e.message === 'Este conteúdo ainda não foi aprovado para publicação.');
    assert.equal((await dispatchesDe(tenant, c.itemId)).length, 0, 'nenhum envio nasce de conteúdo não aprovado');
  }
  // Aprovado sem a aprovação gravada na versão (aprovação limpa) também não sai.
  const semHash = await criarConteudo(tenant, { estado: 'APPROVED' });
  await sql(tenant, 'UPDATE marketing.content_versions SET approved_hash = NULL, approved_at = NULL, approved_by = NULL WHERE id = :id', { id: semHash.versionId });
  await assert.rejects(publicar(tenant, { contentItemId: semHash.itemId, connectionIds: ids() }), recusa(403, 'INTEGRATION_SOCIAL_CONTENT_NOT_APPROVED'));
  await assert.rejects(publicar(tenant, { contentItemId: '00000000-0000-4000-8000-000000000000', connectionIds: ids() }), recusa(404, 'INTEGRATION_SOCIAL_CONTENT_NOT_FOUND'));
  await assert.rejects(publicar(tenant, { contentItemId: rascunho.itemId, connectionIds: [] }), recusa(422, 'INTEGRATION_SOCIAL_NETWORK_REQUIRED'));
  // Conteúdo de imóvel só sai se o imóvel continua no read model público.
  const imovel = await criarConteudo(tenant, { estado: 'APPROVED', imovelInexistente: true });
  await assert.rejects(publicar(tenant, { contentItemId: imovel.itemId, connectionIds: ids() }), recusa(409, 'INTEGRATION_PROPERTY_NOT_PUBLISHABLE'));
  // Aprovado e inalterado: sai, um envio por rede.
  const ok = await criarConteudo(tenant, { estado: 'APPROVED' });
  const r = await publicar(tenant, { contentItemId: ok.itemId, connectionIds: ids() });
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true]);
  assert.equal((await dispatchesDe(tenant, ok.itemId)).length, 3);
});

test('social_hash_da_versao_aprovada_confere', async () => {
  const c = await criarConteudo(tenant, { estado: 'APPROVED' });
  // Hash da aprovação que não bate com o conteúdo + template: 409 e nada nasce.
  await sql(tenant, "UPDATE marketing.content_versions SET approved_hash = repeat('a', 64) WHERE id = :id", { id: c.versionId });
  await assert.rejects(publicar(tenant, { contentItemId: c.itemId, connectionIds: ids() }),
    (e) => recusa(409, 'INTEGRATION_SOCIAL_CONTENT_CHANGED_AFTER_APPROVAL')(e) && e.message === 'O conteúdo mudou após a aprovação; aprove novamente.');
  assert.equal((await dispatchesDe(tenant, c.itemId)).length, 0);
  // Agendado e editado depois da aprovação: o worker reconfere e fecha o envio sem chamar a rede.
  const d = await criarConteudo(tenant, { estado: 'APPROVED' });
  await publicar(tenant, { contentItemId: d.itemId, connectionIds: ids().slice(0, 1) });
  await sql(tenant, "UPDATE marketing.content_versions SET approved_hash = repeat('b', 64) WHERE id = :id", { id: d.versionId });
  const resumo = await dispatch.runDispatchCycle(ctx(), { now: new Date() });
  assert.equal(resumo.failed, 1);
  const [linha] = await dispatchesDe(tenant, d.itemId);
  assert.equal(linha.status, 'FAILED');
  assert.equal(linha.last_error_code, 'INTEGRATION_SOCIAL_CONTENT_CHANGED_AFTER_APPROVAL');
  assert.equal(linha.attempts, 0, 'a tentativa foi devolvida');
  assert.equal(redes[0].S.chamadas.length, 0, 'a rede não foi chamada');
  assert.equal((await eventos(tenant, dispatch.EVENTS.FAILED, linha.id)).length, 1, 'o domínio recebe integration.dispatch.failed');
  // Aprovação perdida (invalidada pelo Marketing) antes de sair: também fecha, como não aprovado.
  const e = await criarConteudo(tenant, { estado: 'APPROVED' });
  await publicar(tenant, { contentItemId: e.itemId, connectionIds: ids().slice(1, 2) });
  await sql(tenant, "UPDATE marketing.content_versions SET approved_hash = NULL, approved_at = NULL, approved_by = NULL WHERE id = :id", { id: e.versionId });
  await sql(tenant, "UPDATE marketing.content_items SET status = 'PENDING_APPROVAL' WHERE id = :id", { id: e.itemId });
  await dispatch.runDispatchCycle(ctx(), { now: new Date() });
  assert.equal((await dispatchesDe(tenant, e.itemId))[0].last_error_code, 'INTEGRATION_SOCIAL_CONTENT_NOT_APPROVED');
  assert.equal(redes[1].S.chamadas.length, 0);
});

test('social_nay_gera_somente_rascunho', async () => {
  nay.registerNayDraftProvider(async () => ({ text: 'Texto da NAY para o post.', nayRunId: '11111111-1111-4111-8111-111111111111', modelName: 'qa-modelo' }));
  const criado = await comTenant(tenant, (t) => contentService.createContent({ tenant: ctx(), actor: tenant.userId, input: { type: 'EDUCATIONAL_BLOG', title: 'QA-M9 NAY', tema: 'Financiamento imobiliário', fontes: ['Guia interno da empresa'] } }, t));
  const [item] = await sql(tenant, 'SELECT status, nay_run_id FROM marketing.content_items WHERE id = :id', { id: criado.itemId });
  assert.equal(item.status, 'DRAFT', 'conteúdo da NAY nasce rascunho, nunca aprovado');
  assert.ok(item.nay_run_id);
  await assert.rejects(publicar(tenant, { contentItemId: criado.itemId, connectionIds: ids() }), recusa(403, 'INTEGRATION_SOCIAL_CONTENT_NOT_APPROVED'));
  // A aprovação por regra automática não libera a NAY no envio manual; só a aprovação humana libera.
  const porRegra = await criarConteudo(tenant, { estado: 'APPROVED', nay: true, aprovador: 'SYSTEM_AUTOPUBLISH:classe-a', autopublishClass: 'classe-a' });
  await assert.rejects(publicar(tenant, { contentItemId: porRegra.itemId, connectionIds: ids() }), recusa(403, 'INTEGRATION_SOCIAL_CONTENT_NOT_APPROVED'));
  const humana = await criarConteudo(tenant, { estado: 'APPROVED', nay: true });
  const r = await publicar(tenant, { contentItemId: humana.itemId, connectionIds: ids().slice(0, 1) });
  assert.equal(r.results[0].ok, true);
  nay.clearNayDraftProvider();
});

test('social_auto_publish_desligado_por_padrao', async () => {
  const c = await criarConteudo(tenant, { estado: 'APPROVED' });
  assert.deepEqual(await comTenant(tenant, (t) => social.readSocialParams(ctx(), t)), { postDedupWindowDays: 7, autoPublishEnabled: false }, 'padrões do livro');
  await assert.rejects(publicar(tenant, { contentItemId: c.itemId, connectionIds: ids(), mode: 'AUTO' }),
    (e) => recusa(403, 'INTEGRATION_SOCIAL_AUTO_PUBLISH_DISABLED')(e) && e.message === 'A publicação automática não está habilitada.');
  assert.equal((await dispatchesDe(tenant, c.itemId)).length, 0);
  await config(tenant, 'integration.social.auto_publish_enabled', true);
  // Ligada: conteúdo com aprovação humana sai; a NAY aprovada por regra pré-aprovada (com a classe) também; sem a classe, não.
  assert.equal((await publicar(tenant, { contentItemId: c.itemId, connectionIds: ids().slice(0, 1), mode: 'AUTO' })).results[0].ok, true);
  const regra = await criarConteudo(tenant, { estado: 'APPROVED', nay: true, aprovador: 'SYSTEM_AUTOPUBLISH:classe-a', autopublishClass: 'classe-a' });
  assert.equal((await publicar(tenant, { contentItemId: regra.itemId, connectionIds: ids().slice(0, 1), mode: 'AUTO' })).results[0].ok, true);
  const semClasse = await criarConteudo(tenant, { estado: 'APPROVED', nay: true, aprovador: 'SYSTEM_AUTOPUBLISH:classe-a' });
  await assert.rejects(publicar(tenant, { contentItemId: semClasse.itemId, connectionIds: ids(), mode: 'AUTO' }), recusa(403, 'INTEGRATION_SOCIAL_CONTENT_NOT_APPROVED'));
  // O kill switch do Marketing sobrepõe tudo: com a política ligada e o conteúdo aprovado, não sai; já agendado, espera sem gastar tentativa.
  let ligado = false;
  const desfazer = social.registerKillSwitchCheck(async () => ligado);
  const k = await criarConteudo(tenant, { estado: 'APPROVED' });
  await publicar(tenant, { contentItemId: k.itemId, connectionIds: ids().slice(1, 2), mode: 'AUTO' });
  ligado = true;
  const outro = await criarConteudo(tenant, { estado: 'APPROVED' });
  await assert.rejects(publicar(tenant, { contentItemId: outro.itemId, connectionIds: ids(), mode: 'AUTO' }), recusa(403, 'INTEGRATION_SOCIAL_KILL_SWITCH_ACTIVE'));
  await assert.rejects(publicar(tenant, { contentItemId: outro.itemId, connectionIds: ids() }), recusa(403, 'INTEGRATION_SOCIAL_KILL_SWITCH_ACTIVE'));
  await dispatch.runDispatchCycle(ctx(), { now: new Date() });
  const [espera] = await dispatchesDe(tenant, k.itemId);
  assert.deepEqual([espera.status, espera.attempts], ['RETRY_WAIT', 0], 'kill switch: o envio espera, sem gastar tentativa');
  assert.equal(redes[1].S.chamadas.length, 0);
  ligado = false;
  await forcar(tenant, espera.id, "next_attempt_at = now() - interval '1 second'");
  await dispatch.runDispatchCycle(ctx(), { now: new Date() });
  assert.equal((await ler(tenant, espera.id)).status, 'CONFIRMED', 'reativado, sai');
  desfazer();
  // Política desligada depois de agendar: o envio automático pendente fecha com o código do livro.
  const p = await criarConteudo(tenant, { estado: 'APPROVED' });
  await publicar(tenant, { contentItemId: p.itemId, connectionIds: ids().slice(2, 3), mode: 'AUTO' });
  await config(tenant, 'integration.social.auto_publish_enabled', false);
  await dispatch.runDispatchCycle(ctx(), { now: new Date() });
  assert.equal((await dispatchesDe(tenant, p.itemId))[0].last_error_code, 'INTEGRATION_SOCIAL_AUTO_PUBLISH_DISABLED');
});
