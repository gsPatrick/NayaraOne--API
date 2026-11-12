'use strict';

// Marco 9, M9-D239 — erro isolado por rede, post que nunca duplica, reconciliação por chave, agendamento e token expirado.
// Testes 3, 4, 5, 6 e 9 da demanda. Roda em banco descartável (os testes COMMITAM).
const crypto = require('crypto');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  sequelize, comTenant, carregarTenants, ctxDe, limparTudo, limparConfig, config, erros, restaurar, forcar, ler, dispatch,
  instalarRedes, removerRedes, criarConteudo, limparConteudos, dispatchesDe, conexao, publicar, social, sql,
} = require('../_helpers/m9d239Env');
const { clearCircuitCache } = require('../../../src/features/integrations/health');
const { erroHttp } = require('../_helpers/m9d214Scripted');
const { timeout } = require('../_helpers/m9d239Social');

let tenant;
let redes;
const ctx = () => ctxDe(tenant);
const ids = () => redes.map((r) => r.connection.id);
const rodar = () => dispatch.runDispatchCycle(ctx(), { now: new Date() });
const depois = (s) => new Date(Date.now() + s * 1000);
const porRede = (linhas) => Object.fromEntries(linhas.map((l) => [l.provider_code, l]));
const CHAVES = ['integration.social.post_dedup_window_days'];

before(async () => { ({ tenant } = await carregarTenants()); });
beforeEach(async () => {
  redes = await instalarRedes(tenant);
  clearCircuitCache();
  await limparConfig(tenant, CHAVES);
  await limparTudo(tenant);
});
after(async () => { await limparConteudos(); await limparConfig(tenant, CHAVES); removerRedes(); restaurar(); await sequelize.close(); });

test('social_erro_em_uma_rede_nao_afeta_outras', async () => {
  const c = await criarConteudo(tenant, {});
  await publicar(tenant, { contentItemId: c.itemId, connectionIds: ids() });
  const [r1, r2, r3] = redes;
  r2.S.fila('publishPost', [{ recebeEDaTimeout: true }]);
  r3.S.fila('publishPost', [{ erro: erroHttp(401) }]);
  await rodar();
  const l = porRede(await dispatchesDe(tenant, c.itemId));
  assert.equal(l[r1.code].status, 'CONFIRMED', 'a rede sem falha publicou');
  assert.equal(l[r2.code].status, 'UNKNOWN', 'timeout depois do envio: incerto, só nessa rede');
  assert.equal(l[r3.code].status, 'FAILED', 'credencial recusada: só nessa rede');
  assert.equal(l[r3.code].last_error_class, 'AUTH');
  assert.deepEqual([r1.S.chamadas.length, r2.S.chamadas.length, r3.S.chamadas.length], [1, 1, 1]);
  assert.equal(r1.S.todos.length, 1);
  // Três estados independentes, cada um no seu envio; a rede 2 resolve pela chave sem publicar de novo.
  const rec = await dispatch.reconcileDispatch(ctx(), l[r2.code].id, { now: depois(40) });
  assert.equal(rec.status, 'CONFIRMED');
  assert.equal(r2.S.todos.length, 1, 'um post por rede');
  assert.equal(r2.S.chamadas.length, 1);
  // Rede fora do ar no enfileiramento: o resultado é por rede e as outras nascem.
  const d = await criarConteudo(tenant, {});
  const semConexao = '00000000-0000-4000-8000-0000000000aa';
  const r = await publicar(tenant, { contentItemId: d.itemId, connectionIds: [r1.connection.id, semConexao, r2.connection.id] });
  assert.deepEqual(r.results.map((x) => x.ok), [true, false, true]);
  assert.equal(r.results[1].code, 'INTEGRATION_CONNECTION_NOT_FOUND');
});

test('social_post_duplicado_nao_ocorre_em_retry', async () => {
  const c = await criarConteudo(tenant, {});
  const a = await publicar(tenant, { contentItemId: c.itemId, connectionIds: ids() });
  const b = await publicar(tenant, { contentItemId: c.itemId, connectionIds: ids() });
  assert.deepEqual(b.results.map((x) => x.created), [false, false, false], 'repetir o pedido devolve os mesmos envios');
  assert.deepEqual(b.results.map((x) => x.dispatchId), a.results.map((x) => x.dispatchId));
  assert.equal((await dispatchesDe(tenant, c.itemId)).length, 3, 'um envio por rede');
  // Falha transitória e nova tentativa: a mesma chave, um post só.
  redes[0].S.fila('publishPost', [{ erro: erroHttp(503) }]);
  await rodar();
  const [l1] = (await dispatchesDe(tenant, c.itemId)).filter((x) => x.provider_code === redes[0].code);
  assert.equal(l1.status, 'RETRY_WAIT');
  await forcar(tenant, l1.id, "next_attempt_at = now() - interval '1 second'");
  await rodar();
  assert.equal((await ler(tenant, l1.id)).status, 'CONFIRMED');
  assert.equal(new Set(redes[0].S.chamadas.map((x) => x.meta.idempotencyKey)).size, 1, 'as duas chamadas levaram a mesma chave');
  assert.equal(redes[0].S.todos.length, 1, 'um post na rede');
  // Retry nunca cria post novo se o external_post_id já está registrado: o worker não envia, consulta.
  const d = await criarConteudo(tenant, {});
  await publicar(tenant, { contentItemId: d.itemId, connectionIds: ids().slice(1, 2) });
  const [l2] = await dispatchesDe(tenant, d.itemId);
  const existente = redes[1].S.registrar(l2.idempotency_key, d.texto);
  await forcar(tenant, l2.id, `external_resource_id = '${existente.id}'`);
  const antes = redes[1].S.chamadas.filter((x) => x.op === 'publishPost').length;
  await rodar();
  assert.equal(redes[1].S.chamadas.filter((x) => x.op === 'publishPost').length, antes, 'não publicou de novo');
  assert.equal((await ler(tenant, l2.id)).status, 'UNKNOWN');
  assert.equal((await dispatch.reconcileDispatch(ctx(), l2.id, { now: depois(40) })).status, 'CONFIRMED');
  assert.equal(redes[1].S.todos.filter((p) => p.text === d.texto).length, 1, 'um post do conteúdo na rede');
});

test('social_timeout_reconcilia_por_chave', async () => {
  const c = await criarConteudo(tenant, {});
  await publicar(tenant, { contentItemId: c.itemId, connectionIds: ids().slice(0, 1) });
  const [rede] = redes;
  rede.S.fila('publishPost', [{ recebeEDaTimeout: true }]);
  await rodar();
  const [u] = await dispatchesDe(tenant, c.itemId);
  assert.equal(u.status, 'UNKNOWN');
  const rec = await dispatch.reconcileDispatch(ctx(), u.id, { now: depois(40) });
  assert.deepEqual([rec.status, rec.verdict], ['CONFIRMED', 'FOUND']);
  assert.equal(rede.S.consultas[0].metodo, 'key', 'findPostByKey primeiro');
  assert.equal(rede.S.consultas[0].request.idempotencyKey, u.idempotency_key);
  assert.equal(rede.S.chamadas.length, 1, 'sem repetir a publicação');
  assert.equal(rede.S.todos.length, 1);
  // Sem busca pela chave, a listagem recente de posts da conta (texto igual dentro da janela) acha o post.
  const d = await criarConteudo(tenant, {});
  await publicar(tenant, { contentItemId: d.itemId, connectionIds: ids().slice(1, 2) });
  const [r2] = redes.slice(1);
  r2.Classe.prototype.findPostByKey = async () => null;
  r2.S.fila('publishPost', [{ recebeEDaTimeout: true }]);
  r2.S.posts.clear();
  await rodar();
  const [u2] = await dispatchesDe(tenant, d.itemId);
  r2.S.todos[0].at = Date.now() - 2 * 86400000;
  r2.S.posts.clear();
  const rec2 = await dispatch.reconcileDispatch(ctx(), u2.id, { now: depois(40) });
  assert.equal(rec2.status, 'CONFIRMED', 'achado na listagem recente');
  assert.equal(r2.S.windowDays, 7, 'janela padrão do livro');
  // Fora da janela configurada: não acha e, com a rede afirmando que não existe, repete com a MESMA chave (um post só).
  await config(tenant, 'integration.social.post_dedup_window_days', 1);
  const e = await criarConteudo(tenant, {});
  await publicar(tenant, { contentItemId: e.itemId, connectionIds: ids().slice(2, 3) });
  const [r3] = redes.slice(2);
  r3.Classe.prototype.findPostByKey = async () => null;
  r3.S.fila('publishPost', [{ semReceber: true }]);
  await rodar();
  const [u3] = await dispatchesDe(tenant, e.itemId);
  const rec3 = await dispatch.reconcileDispatch(ctx(), u3.id, { now: depois(40) });
  assert.deepEqual([rec3.status, rec3.verdict], ['RETRY_WAIT', 'NOT_FOUND']);
  assert.equal(r3.S.windowDays, 1, 'a janela vem do parâmetro da empresa');
  await forcar(tenant, u3.id, "next_attempt_at = now() - interval '1 second'");
  await rodar();
  assert.equal((await ler(tenant, u3.id)).status, 'CONFIRMED');
  assert.equal(r3.S.todos.length, 1);
  assert.equal(new Set(r3.S.chamadas.map((x) => x.meta.idempotencyKey)).size, 1);
  assert.ok(timeout() instanceof Error);
});

test('social_agendamento_cria_um_dispatch', async () => {
  const c = await criarConteudo(tenant, {});
  const quando = new Date(Date.now() + 3600 * 1000);
  const a = await publicar(tenant, { contentItemId: c.itemId, connectionIds: ids(), scheduledAt: quando });
  const b = await publicar(tenant, { contentItemId: c.itemId, connectionIds: ids(), scheduledAt: quando });
  assert.deepEqual(b.results.map((x) => x.created), [false, false, false]);
  const linhas = await dispatchesDe(tenant, c.itemId);
  assert.equal(linhas.length, 3, '1 dispatch por rede, mesmo repetindo o agendamento');
  linhas.forEach((l) => {
    assert.equal(l.status, 'PENDING');
    assert.ok(Math.abs(new Date(l.next_attempt_at).getTime() - quando.getTime()) < 2000, 'next_attempt_at = horário agendado');
  });
  // A chave do livro: sha256(conteúdo|versão|rede|horário).
  const [primeira] = a.results;
  const esperada = crypto.createHash('sha256').update([c.itemId, 1, primeira.connectionId, quando.toISOString()].join('|')).digest('hex');
  assert.equal(primeira.idempotencyKey, esperada);
  await rodar();
  assert.deepEqual(redes.map((r) => r.S.chamadas.length), [0, 0, 0], 'antes do horário nada sai');
  // Reagendar: o envio anterior é cancelado e nasce outro, com a chave nova e o horário novo.
  const novo = new Date(Date.now() + 7200 * 1000);
  const re = await comTenant(tenant, (t) => social.rescheduleSocialPost(ctx(), { dispatchId: primeira.dispatchId, scheduledAt: novo, transaction: t }));
  assert.equal(re.replaced, true);
  assert.equal((await ler(tenant, primeira.dispatchId)).status, 'CANCELLED');
  assert.notEqual(re.idempotencyKey, primeira.idempotencyKey);
  assert.equal((await ler(tenant, re.dispatchId)).status, 'PENDING');
  const mesmo = await comTenant(tenant, (t) => social.rescheduleSocialPost(ctx(), { dispatchId: re.dispatchId, scheduledAt: novo, transaction: t }));
  assert.deepEqual([mesmo.created, mesmo.replaced], [false, false], 'mesmo horário: nada muda');
  // Na hora, cada rede publica UMA vez; o que já saiu não se reagenda.
  const demais = linhas.filter((l) => l.id !== primeira.dispatchId);
  await Promise.all(demais.map((l) => forcar(tenant, l.id, "next_attempt_at = now() - interval '1 second'")));
  await rodar();
  assert.equal(redes[1].S.chamadas.length + redes[2].S.chamadas.length, 2);
  assert.equal(redes[0].S.chamadas.length, 0);
  await assert.rejects(comTenant(tenant, (t) => social.rescheduleSocialPost(ctx(), { dispatchId: demais[0].id, scheduledAt: depois(9000), transaction: t })),
    (e) => e.statusCode === 409 && e.code === 'INTEGRATION_SOCIAL_RESCHEDULE_NOT_ALLOWED');
  await assert.rejects(publicar(tenant, { contentItemId: c.itemId, connectionIds: ids(), scheduledAt: 'ontem' }), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_SOCIAL_SCHEDULE_INVALID');
});

test('social_token_expirado_pausa_so_aquela_rede', async () => {
  const c = await criarConteudo(tenant, {});
  await publicar(tenant, { contentItemId: c.itemId, connectionIds: ids() });
  const [r1, r2, r3] = redes;
  r3.S.fila('publishPost', [{ erro: erroHttp(401) }]);
  await rodar();
  assert.equal((await conexao(tenant, r3.connection.id)).status, 'AUTH_FAILED', 'só a rede com token recusado é pausada');
  assert.equal((await conexao(tenant, r1.connection.id)).status, 'ACTIVE');
  assert.equal((await conexao(tenant, r2.connection.id)).status, 'ACTIVE');
  const inc = await erros(tenant, r3.connection.id, 'HTTP_401');
  assert.ok(inc.length >= 1);
  // Um conteúdo novo: as redes ativas publicam; a pausada espera sem gastar tentativa e sem ser chamada.
  const d = await criarConteudo(tenant, {});
  const nova = await publicar(tenant, { contentItemId: d.itemId, connectionIds: ids() });
  assert.deepEqual(nova.results.map((x) => x.ok), [true, true, false], 'a rede pausada não aceita envio novo');
  assert.equal(nova.results[2].code, 'INTEGRATION_CONNECTION_NOT_FOUND');
  await rodar();
  const l = porRede(await dispatchesDe(tenant, d.itemId));
  assert.equal(l[r1.code].status, 'CONFIRMED');
  assert.equal(l[r2.code].status, 'CONFIRMED');
  assert.equal(l[r3.code], undefined, 'nenhum envio nasce para a rede pausada');
  assert.equal(r3.S.chamadas.length, 1, 'a rede pausada não é chamada de novo');
  // O envio que já esperava na rede pausada (de antes da recusa) não gasta tentativa enquanto a conexão estiver parada.
  const e = await criarConteudo(tenant, {});
  await sql(tenant, "UPDATE integration.connections SET status = 'ACTIVE' WHERE id = :id", { id: r3.connection.id });
  await publicar(tenant, { contentItemId: e.itemId, connectionIds: [r3.connection.id], scheduledAt: depois(3600) });
  await sql(tenant, "UPDATE integration.connections SET status = 'AUTH_FAILED' WHERE id = :id", { id: r3.connection.id });
  const [espera] = await dispatchesDe(tenant, e.itemId);
  await forcar(tenant, espera.id, "next_attempt_at = now() - interval '1 second'");
  await rodar();
  const depoisDeRodar = await ler(tenant, espera.id);
  assert.deepEqual([depoisDeRodar.status, depoisDeRodar.attempts], ['RETRY_WAIT', 0]);
  assert.equal(r3.S.chamadas.length, 1);
});
