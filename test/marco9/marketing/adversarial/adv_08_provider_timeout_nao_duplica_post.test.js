'use strict';

// M9-D436 adv_08 (Caderno §16: "Provider timeout -> não duplica post"). O sandbox responde UNKNOWN_BUT_PUBLISHED (o post foi, a resposta se perdeu); o job fica UNKNOWN, a reconciliação
// acha o post pela chave de idempotência e o job vira PUBLISHED, com um único post. Cenário da dona (M9-D411), sem lógica própria. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const env = require('../../_helpers/mktWorker');
const { adapters } = require('../../../../src/features/marketing/publications');

let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(() => { env.reset(); env.resetSandbox(); });

test('adv_08_provider_timeout_nao_duplica_post', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['SITE']);
    let now = s.now;
    await env.cycle(t, ctx, { now, scenarios: { SITE: ['UNKNOWN_BUT_PUBLISHED', 'OK', 'OK'] } });
    const unknown = await env.job(t, s.jobId);
    // (1) primeiro o job fica UNKNOWN, sem segunda tentativa cega
    assert.equal(unknown.status, 'UNKNOWN');
    assert.equal(unknown.attempts, 1);
    for (let i = 0; i < 4; i += 1) { now = env.seconds(now, 130); await env.cycle(t, ctx, { now, scenarios: { SITE: ['UNKNOWN_BUT_PUBLISHED', 'OK', 'OK'] } }); }
    // (2) a reconciliação achou o post pela chave: PUBLISHED, um único post, resultado de reconciliação registrado
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'PUBLISHED');
    assert.equal(adapters.sandboxRecordCount(ctx.tenant.companyId, 'SITE'), 1, 'um único post no canal');
    assert.equal(job.attempts, 1, 'a reconciliação não gasta tentativa de envio');
    const outcomes = (await env.results(t, s.jobId)).map((r) => r.outcome).filter((o) => o !== 'METRICS');
    assert.ok(outcomes.includes('TIMEOUT') && outcomes.includes('RECONCILED_FOUND'), outcomes.join());
    assert.equal(outcomes.filter((o) => o === 'SUCCESS').length, 0, 'nenhuma publicação nova');
    // isolamento (RLS): a outra empresa não enxerga o que este cenário gravou
    await require('../../_helpers/mktAdv').assertIsolated(t, ctx.tenant, [{ tabela: 'marketing.publication_jobs', ids: [s.jobId] }]);
  });
});
