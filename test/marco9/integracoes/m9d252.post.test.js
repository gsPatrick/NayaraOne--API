'use strict';

// Marco 9, M9-D252 — teste adversarial 12 do livro (seção 19): agendamento repetido, nova tentativa e timeout publicam UM post por rede. Três redes programáveis: a primeira aceita o post e a resposta
// se perde, a segunda falha com 503 e repete, a terceira publica normalmente. Banco descartável (os testes COMMITAM).
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  sequelize, carregarTenants, ctxDe, limparTudo, limparConfig, restaurar, forcar, ler, dispatch, instalarRedes, removerRedes, criarConteudo, limparConteudos, dispatchesDe, publicar,
} = require('../_helpers/m9d239Env');
const { clearCircuitCache } = require('../../../src/features/integrations/health');
const { erroHttp } = require('../_helpers/m9d214Scripted');

let tenant;
let redes;
const ctx = () => ctxDe(tenant);
const rodar = () => dispatch.runDispatchCycle(ctx(), { now: new Date() });
const depois = (s) => new Date(Date.now() + s * 1000);

before(async () => { ({ tenant } = await carregarTenants()); });
beforeEach(async () => { redes = await instalarRedes(tenant); clearCircuitCache(); await limparConfig(tenant, ['integration.social.post_dedup_window_days']); await limparTudo(tenant); });
after(async () => { await limparConteudos(); await limparConfig(tenant, ['integration.social.post_dedup_window_days']); removerRedes(); restaurar(); await sequelize.close(); });

test('adv_post_duplicado_nao_ocorre_em_retry_e_timeout', async () => {
  const [r1, r2, r3] = redes;
  const c = await criarConteudo(tenant, {});
  const ids = redes.map((r) => r.connection.id);
  const quando = depois(3600);
  // Agendamento repetido: o mesmo pedido devolve os mesmos envios, um por rede.
  const a = await publicar(tenant, { contentItemId: c.itemId, connectionIds: ids, scheduledAt: quando });
  const b = await publicar(tenant, { contentItemId: c.itemId, connectionIds: ids, scheduledAt: quando });
  assert.deepEqual(b.results.map((x) => x.created), [false, false, false]);
  assert.deepEqual(b.results.map((x) => x.dispatchId), a.results.map((x) => x.dispatchId));
  const linhas = await dispatchesDe(tenant, c.itemId);
  assert.equal(linhas.length, 3, 'um envio por rede');
  await rodar();
  assert.deepEqual(redes.map((r) => r.S.chamadas.length), [0, 0, 0], 'antes do horário nada sai');
  // Chega a hora: rede 1 recebe e dá timeout, rede 2 recebe 503 e repete, rede 3 publica.
  r1.S.fila('publishPost', [{ recebeEDaTimeout: true }]);
  r2.S.fila('publishPost', [{ erro: erroHttp(503) }]);
  await Promise.all(linhas.map((l) => forcar(tenant, l.id, "next_attempt_at = now() - interval '1 second'")));
  await rodar();
  const porRede = async () => Object.fromEntries((await dispatchesDe(tenant, c.itemId)).map((l) => [l.provider_code, l]));
  let l = await porRede();
  assert.equal(l[r1.code].status, 'UNKNOWN', 'timeout depois do envio: incerto, nunca republicado');
  assert.equal(l[r2.code].status, 'RETRY_WAIT');
  assert.equal(l[r3.code].status, 'CONFIRMED');
  // Nova tentativa da rede 2 e reconciliação da rede 1 pela chave; um repetido do agendamento no meio não cria nada.
  await forcar(tenant, l[r2.code].id, "next_attempt_at = now() - interval '1 second'");
  await publicar(tenant, { contentItemId: c.itemId, connectionIds: ids, scheduledAt: quando });
  await rodar();
  const rec = await dispatch.reconcileDispatch(ctx(), l[r1.code].id, { now: depois(40) });
  assert.equal(rec.status, 'CONFIRMED');
  await rodar();
  l = await porRede();
  assert.deepEqual(Object.values(l).map((x) => x.status), ['CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
  assert.equal((await dispatchesDe(tenant, c.itemId)).length, 3, 'continuam 3 envios');
  for (const r of redes) assert.equal(r.S.todos.length, 1, `${r.code}: um post só na rede`);
  assert.equal(new Set(r2.S.chamadas.map((x) => x.meta.idempotencyKey)).size, 1, 'a nova tentativa levou a mesma chave');
  assert.equal(new Set(r1.S.chamadas.map((x) => x.meta.idempotencyKey)).size, 1);
  assert.equal(r1.S.chamadas.length, 1, 'a reconciliação consulta pela chave; não publica de novo');
  assert.equal((await ler(tenant, l[r1.code].id)).status, 'CONFIRMED');
});
