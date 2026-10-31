'use strict';

// M9-D441 carga (d): o kill switch acionado no meio do lote (3 instâncias do worker, 300 jobs) deixa de produzir chamadas novas ao adapter a partir do acionamento: nenhum envio COMEÇA depois
// do commit do kill switch, os jobs que sobram ficam PENDING (nem perdidos nem cancelados) e, desligado o kill switch, saem todos, cada chave uma só vez. COMMIT real: só em banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withTenantTransaction } = require('../../../testHelpers');
const env = require('../../_helpers/mktWorker');
const carga = require('../../_helpers/mktCarga');
const jobs = require('../../_helpers/mktCargaJobs');
const ks = require('../../../../src/features/marketing/killswitch.service');

const TOTAL = 300;
const ACIONAR_NA_CHAMADA = Math.max(10, Math.floor(TOTAL / 5));
let ctx; let itemIds = [];
before(async () => { if (carga.DISPOSABLE) ctx = await env.setup(); });
after(async () => {
  if (carga.DISPOSABLE) {
    await withTenantTransaction(ctx.tenant, (t) => ks.changeKillSwitch({ tenant: ctx.tenant, actorUserId: ctx.tenant.userId, transaction: t, input: { scope: 'GLOBAL', active: false, reason: 'QA-M9 carga: limpeza do kill switch' } })).catch(() => null);
    env.resetSandbox();
    await jobs.limpar(itemIds);
    await carga.withAdmin(async (admin) => {
      await admin.query('ALTER TABLE marketing.kill_switch_log DISABLE TRIGGER kill_switch_log_guard').catch(() => null);
      await admin.query("DELETE FROM marketing.kill_switch_log WHERE reason LIKE 'QA-M9 carga%'").catch(() => null);
      await admin.query('ALTER TABLE marketing.kill_switch_log ENABLE TRIGGER kill_switch_log_guard').catch(() => null);
      // o acionamento commitado registra a chave do switch na empresa; sem apagar, a suíte seguinte (M9-D425, ciclo diário) já a encontra cadastrada
      await admin.query("DELETE FROM governance.feature_flags WHERE company_id = $1 AND key LIKE 'marketing.%.kill'", [ctx.tenant.companyId]).catch(() => null);
    });
  }
  await sequelize.close();
});

test('kill_switch_sob_carga_nenhuma_chamada_depois', { skip: carga.SKIP }, async (tctx) => {
  env.resetSandbox();
  const semeado = await jobs.semear(ctx, TOTAL);
  itemIds = semeado.itemIds;
  const tx = (fn) => withTenantTransaction(ctx.tenant, fn);
  const liga = (active, reason) => tx((t) => ks.changeKillSwitch({ tenant: ctx.tenant, actorUserId: ctx.tenant.userId, transaction: t, input: { scope: 'GLOBAL', active, reason } }));
  const marca = {};
  // o kill switch é acionado (e commitado) de dentro da N-ésima chamada ao adapter, com as 3 instâncias em andamento
  const { chamadas, restaurar } = jobs.espiar('SITE', async (chave, n) => {
    if (n !== ACIONAR_NA_CHAMADA || marca.antes) return;
    marca.antes = Date.now();
    await liga(true, 'QA-M9 carga: kill switch durante o lote');
    marca.depois = Date.now();
  });
  try {
    await Promise.all([1, 2, 3].map(() => jobs.instancia(ctx, { tx, agora: () => semeado.now })));
    assert.ok(marca.depois, 'o kill switch foi acionado durante a carga');
    // (d) nenhuma chamada nova começou depois do commit do kill switch
    const depois = chamadas.filter((c) => c.em > marca.depois);
    const emVoo = chamadas.filter((c) => c.em >= marca.antes && c.em <= marca.depois);
    assert.deepEqual(depois.map((c) => c.chave), [], 'MKT_LOAD_INVARIANT_BROKEN: houve chamada ao adapter depois do kill switch');
    const antes = chamadas.length;
    // nem perda nem cancelamento: o que não saiu fica PENDING (ou já saiu), e nada FAILED/UNKNOWN/CANCELLED
    const estado = await tx((t) => env.fx.q(t, 'SELECT status, count(*)::int AS n FROM marketing.publication_jobs WHERE id = ANY(CAST(:ids AS uuid[])) GROUP BY status', { ids: `{${semeado.jobIds.join(',')}}` }));
    const por = Object.fromEntries(estado.map((r) => [r.status, r.n]));
    assert.ok((por.PENDING || 0) > 0, `sobraram jobs para depois do kill switch: ${JSON.stringify(por)}`);
    assert.deepEqual(Object.keys(por).filter((s) => !['PENDING', 'PUBLISHED'].includes(s)), [], `estados inesperados: ${JSON.stringify(por)}`);
    assert.equal((por.PUBLISHED || 0) + (por.PENDING || 0), TOTAL);
    // desligado o kill switch, tudo que sobrou sai, e cada chave só foi enviada uma vez no total
    await liga(false, 'QA-M9 carga: kill switch desligado depois do lote');
    await Promise.all([1, 2, 3].map(() => jobs.instancia(ctx, { tx, agora: () => semeado.now })));
    const porChave = new Map();
    for (const c of chamadas) porChave.set(c.chave, (porChave.get(c.chave) || 0) + 1);
    assert.equal(porChave.size, TOTAL, 'toda chave foi enviada');
    assert.deepEqual([...porChave.values()].filter((n) => n !== 1), [], 'nenhuma chave enviada duas vezes');
    const final = await tx((t) => env.fx.q(t, "SELECT count(*)::int AS n FROM marketing.publication_jobs WHERE id = ANY(CAST(:ids AS uuid[])) AND status = 'PUBLISHED' AND attempts = 1", { ids: `{${semeado.jobIds.join(',')}}` }));
    assert.equal(final[0].n, TOTAL);
    tctx.diagnostic(`kill switch acionado na chamada ${ACIONAR_NA_CHAMADA} de ${TOTAL} jobs com 3 instâncias: ${antes} chamadas até o fim do lote (${emVoo.length} em voo no momento do commit), 0 depois do commit, ${por.PENDING} jobs PENDING preservados; desligado, ${final[0].n} PUBLISHED com 1 tentativa e nenhuma chave repetida`);
  } finally { restaurar(); }
});
