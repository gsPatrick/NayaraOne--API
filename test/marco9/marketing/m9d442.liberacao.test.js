'use strict';

// M9-D442 — o drill de cada canal registra o resultado com recordChannelDrill(canal, { ok, scenarios }) e isso é o pré-requisito FAILURE_DRILL do releaseChannel (M9-D430):
// ponta a ponta, do drill até a liberação. Drill com cenário faltando ou divergência não libera o canal. Banco descartável; o registro e a liberação ficam na transação do teste.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktDrillEnv');
const { recordChannelResult } = require('../../../src/features/marketing/publications/drill/drill.record');
const { PERMISSION } = require('../../../src/features/marketing/publications/adapters/release/evidence');

let picked;
before(async () => { picked = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(() => env.adapters.resetSandbox());

const ctxOf = (tenant) => ({ tenant, actor: tenant.userId, permissions: [PERMISSION] });

test('drill_aprovado_vira_a_evidencia_e_libera_o_canal_com_as_outras_tres', async () => {
  const { report } = await env.drill.runDrill({ channels: ['SITE'], companyId: picked.tenant.companyId });
  assert.equal(report.passed, true, JSON.stringify(report.rows.filter((r) => !r.aprovado)));
  await env.withDrillTransaction(picked.tenant, async (t) => {
    const { tenant } = picked;
    await assert.rejects(() => env.adapters.releaseChannel('SITE', { reason: 'liberar' }, ctxOf(tenant), t), (e) => e.code === 'MKT_CHANNEL_RELEASE_PREREQ_MISSING' && e.details.missing.includes('FAILURE_DRILL'));
    const rec = await recordChannelResult(tenant, 'SITE', report, t);
    assert.equal(rec.ok, true);
    assert.deepEqual([...rec.scenarios].sort(), [...env.adapters.SCENARIOS].sort(), 'os 10 cenários do sandbox da M9-D430');
    await env.adapters.approveConsentPolicy('SITE', { reason: 'política aprovada' }, ctxOf(tenant), t);
    await env.adapters.homologateAdapter('SITE', { reason: 'adapter homologado' }, ctxOf(tenant), t);
    const out = await env.adapters.releaseChannel('SITE', { reason: 'liberar depois do drill' }, ctxOf(tenant), t);
    assert.deepEqual([out.released, out.replay], [true, false]);
  });
});

test('drill_com_divergencia_ou_cenario_faltando_nao_libera_o_canal', async () => {
  const restore = env.duplicatingSandbox('SITE');
  let bad;
  try {
    ({ report: bad } = await env.drill.runDrill({ channels: ['SITE'], companyId: picked.tenant.companyId }));
  } finally {
    restore();
  }
  assert.equal(bad.passed, false);
  const faltando = { ...bad, rows: bad.rows.filter((r) => r.cenario !== 'SLOW').map((r) => ({ ...r, aprovado: true })), baseline: bad.baseline.map((b) => ({ ...b, aprovado: true })) };
  for (const [nome, report] of [['divergência', bad], ['cenário faltando', faltando]]) {
    await env.withDrillTransaction(picked.tenant, async (t) => {
      const { tenant } = picked;
      const rec = await recordChannelResult(tenant, 'SITE', report, t);
      assert.equal(rec.ok, false, nome);
      await env.adapters.approveConsentPolicy('SITE', { reason: 'política aprovada' }, ctxOf(tenant), t);
      await env.adapters.homologateAdapter('SITE', { reason: 'adapter homologado' }, ctxOf(tenant), t);
      await assert.rejects(() => env.adapters.releaseChannel('SITE', { reason: 'tentativa' }, ctxOf(tenant), t), (e) => e.code === 'MKT_CHANNEL_RELEASE_PREREQ_MISSING' && e.details.missing.includes('FAILURE_DRILL'), nome);
    });
  }
});
