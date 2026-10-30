'use strict';

// M9-D440 guard_no_blind_retry (Guia §14: "Não retry cego após timeout"). Estática: timeout vira UNKNOWN, só a reconciliação devolve o job a PENDING e o envio não tem laço de nova tentativa.
// Dinâmica, com espião no adapter sandbox em cenário TIMEOUT: a segunda chamada a publish só acontece depois de findByIdempotencyKey, e o post continua um só.
const { test, before, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const env = require('../../_helpers/mktWorker');
const { adapters } = require('../../../../src/features/marketing/publications');
const g = require('../../_helpers/mktGuardas');

const NOME = 'guard_no_blind_retry';
let ctx;
let espiao;
before(async () => { ctx = await env.setup(); });
afterEach(() => { if (espiao) espiao.restaurar(); env.reset(); env.resetSandbox(); });
after(async () => { await sequelize.close(); });

test('guard_no_blind_retry: o timeout deixa o job em UNKNOWN, o retorno a PENDING vem da reconciliação e o envio não tem laço de nova tentativa', () => {
  g.assertSemViolacao(NOME);
});

test('guard_no_blind_retry: timeout que volta o job a PENDING sem consultar o canal é achado com arquivo e linha', () => {
  const copia = g.copiaDoModulo([{ arquivo: 'src/features/marketing/publications/worker/worker.outcome.js', de: "{ status: 'UNKNOWN', unknownSince: ctx.now, nextCheckAt: ctx.now,", para: "{ status: 'PENDING', unknownSince: ctx.now, nextCheckAt: ctx.now," }]);
  try {
    const achados = g.violacoesDe(NOME, copia);
    assert.equal(achados.length, 1);
    assert.equal(achados[0].arquivo, 'publications/worker/worker.outcome.js');
    assert.match(achados[0].regra, /retry cego/);
  } finally { require('node:fs').rmSync(copia, { recursive: true, force: true }); }
});

for (const cenario of ['TIMEOUT', 'UNKNOWN_BUT_PUBLISHED', 'UNKNOWN_NOT_PUBLISHED']) {
  test(`guard_no_blind_retry: com o sandbox em ${cenario}, a segunda chamada a publish só vem depois de findByIdempotencyKey e o canal fica com um post`, async () => {
    await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
      espiao = g.espiarCanais();
      const s = await env.scheduled(t, ctx, ['SITE']);
      let now = s.now;
      for (let i = 0; i < 14 && (await env.job(t, s.jobId)).status !== 'PUBLISHED'; i += 1) {
        await env.cycle(t, ctx, { now, scenarios: { SITE: [cenario, 'OK', 'OK'] } });
        now = env.seconds(now, 130);
      }
      const sequencia = espiao.chamadas.filter((c) => c.canal === 'SITE').map((c) => c.tipo);
      assert.equal(sequencia[0], 'envio', 'a primeira chamada é a publicação');
      // regra do livro: entre dois envios (publish) sempre houve uma consulta pela chave de idempotência
      for (let i = 1; i < sequencia.length; i += 1) {
        if (sequencia[i] === 'envio') assert.ok(sequencia.slice(0, i).lastIndexOf('consulta') > sequencia.slice(0, i).lastIndexOf('envio'), `retry cego: ${sequencia.join(' > ')}`);
      }
      assert.ok(sequencia.includes('consulta'), 'a reconciliação consultou o canal');
      assert.equal((await env.job(t, s.jobId)).status, 'PUBLISHED');
      assert.equal(adapters.sandboxRecordCount(ctx.tenant.companyId, 'SITE'), 1, 'um único post no canal');
    });
  });
}
