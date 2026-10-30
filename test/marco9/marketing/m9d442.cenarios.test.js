'use strict';

// M9-D442 — failure drill de provedor: os 12 cenários em cada um dos 9 canais (108 combinações) contra o worker, o sandbox, o circuit breaker, o webhook e o CRM de verdade.
// Banco descartável; cada cenário roda numa transação que é desfeita.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktDrillEnv');

let picked;
before(async () => { picked = await env.setup(); });
after(async () => { await sequelize.close(); });

test('drill_executa_12_cenarios_em_9_canais', { timeout: 1800000 }, async () => {
  const { report } = await env.drill.runDrill({ channels: env.adapters.CHANNELS, companyId: picked.tenant.companyId });
  const expectedIds = env.drill.DRILL_SCENARIOS.map((s) => s.id);
  assert.equal(expectedIds.length, 12);
  assert.equal(report.rows.length, 108, '9 canais x 12 cenários');
  for (const channel of env.adapters.CHANNELS) {
    const rows = report.rows.filter((r) => r.canal === channel);
    assert.deepEqual(rows.map((r) => r.cenario), expectedIds, `${channel}: os 12 cenários, na ordem da tabela do livro`);
    for (const r of rows) {
      assert.ok(r.esperado && r.obtido, `${channel}/${r.cenario}: o relatório traz esperado e obtido`);
      assert.equal(typeof r.aprovado, 'boolean');
    }
  }
  assert.equal(report.baseline.length, 9, 'o caso de base (OK) roda uma vez em cada canal');
  const reprovadas = [...report.baseline, ...report.rows].filter((r) => !r.aprovado).map((r) => `${r.canal}/${r.cenario}: ${r.obtido}`);
  assert.deepEqual(reprovadas, [], 'todas as combinações aprovadas');
  assert.equal(report.passed, true);
  assert.deepEqual(report.summary, { combinacoes: 108, aprovadas: 108, reprovadas: 0, baseReprovadas: 0 });
  console.log(`# ${env.drill.toText(report).split('\n').slice(-2).join(' | ')}`);
});

test('o_ensaio_nao_deixa_residuo_e_e_repetivel: nada do que os cenários criam sobrevive ao rollback', async () => {
  // a contagem roda com a conexão do runtime (RLS): sem empresa na sessão ela vê zero, então é feita dentro de uma transação da empresa
  const snap = () => env.withDrillTransaction(picked.tenant, async (t) => (await sequelize.query("SELECT (SELECT count(*) FROM marketing.publication_jobs)::int AS jobs, (SELECT count(*) FROM marketing.content_items)::int AS items, (SELECT count(*) FROM integration.webhook_inbox)::int AS inbox, (SELECT count(*) FROM crm.messages)::int AS msgs", { transaction: t, type: 'SELECT' }))[0]);
  const before1 = await snap();
  const a = await env.drill.runDrill({ channels: ['SITE'], companyId: picked.tenant.companyId });
  const after1 = await snap();
  assert.deepEqual(after1, before1, 'nenhuma linha sobrou');
  const b = await env.drill.runDrill({ channels: ['SITE'], companyId: picked.tenant.companyId });
  assert.equal(a.report.passed && b.report.passed, true, 'repetível: o segundo ensaio dá o mesmo veredito');
  assert.deepEqual(b.report.rows.map((r) => [r.cenario, r.aprovado]), a.report.rows.map((r) => [r.cenario, r.aprovado]));
});
