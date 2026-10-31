'use strict';

// M9-D904 (reabertura G1/M2) — o gate do canary considera a migração real: PERSON, SUPPLIER e PROPERTY (as entidades com destino) pesam sobre todo setor com a configuração PADRÃO,
// a comparação paralela é exigida delas e os blockers globais do plano de rollback (M9-D907) travam o avanço. Sem entidades fictícias. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d904Env');
const base = require('../_helpers/m9d904Base');
const providers = require('../../../src/features/migration-v2/control/blockers.providers');
const targets = require('../../../src/features/migration-v2/ingest/targets');

let A;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) { A = (await env.loadTenants()).A; await env.cleanup(A); } });
afterEach(async () => { if (env.DISPOSABLE) await env.cleanup(A); });
after(async () => { await env.sequelize.close(); });

const REAL = ['PERSON', 'SUPPLIER', 'PROPERTY'];
const withBlocker = (code, entity) => providers.register(`qa-m9d904-real-${code}-${entity}`, async () => [{ code, entity, ref: 'qa904-real', owner: null, detail: {} }]);

test('m9d904 as entidades com destino real existem e não estão na lista padrão de nenhum setor', { skip: skip() }, async () => {
  assert.deepEqual(REAL.filter((name) => !targets.ENTITIES().includes(name)), []);
  const { DEFAULT_ENTITIES } = require('../../../src/features/migration-v2/canary/canary.settings');
  for (const list of Object.values(DEFAULT_ENTITIES)) assert.deepEqual(list.split(',').filter((name) => REAL.includes(name)), []);
});

for (const entity of REAL) {
  test(`m9d904 blocker de ${entity} real trava o avanço de ATENDIMENTO com a configuração padrão`, { skip: skip() }, async () => {
    await env.addSectorUsers(A, 'ATENDIMENTO', 4);
    const off = withBlocker('GOV_MIG_QUARANTINE_OPEN', entity);
    try {
      const err = await env.fail(env.advance(A, 'ATENDIMENTO'));
      assert.deepEqual([err.status, err.code], [409, 'GOV_CANARY_BLOCKERS_OPEN']);
      assert.ok(err.details.blockers.some((b) => b.code === 'GOV_MIG_QUARANTINE_OPEN' && b.entity === entity));
      assert.equal(await env.percentOf(A, 'ATENDIMENTO'), 0);
    } finally { off(); }
    assert.equal((await env.advance(A, 'ATENDIMENTO')).percent, 5, 'fechado o blocker, avança');
  });
}

test('m9d904 com a configuração padrão a comparação paralela das entidades reais é exigida em todo setor', { skip: skip() }, async () => {
  await env.addSectorUsers(A, 'LOCACAO', 4);
  const err = await env.fail(env.advanceRaw(A, 'LOCACAO'));
  assert.deepEqual([err.status, err.code], [409, 'GOV_CANARY_COMPARISON_PENDING']);
  assert.deepEqual(err.details.problems.map((p) => [p.entity, p.reason]).sort(), REAL.map((name) => [name, 'NO_COMPARISON']).sort());
  await base.ensureCleanBase(A);
  assert.equal((await env.advanceRaw(A, 'LOCACAO')).percent, 5, 'com a comparação limpa das três entidades, avança');
});

for (const code of ['GOV_ROLLBACK_PENDING', 'GOV_ROLLBACK_COMPENSATION_REQUIRED']) {
  for (const entity of [null, 'QA904_TIPO_DE_OPERACAO']) {
    test(`m9d904 ${code} ${entity ? 'com entidade' : 'sem entidade'} trava o avanço de qualquer setor`, { skip: skip() }, async () => {
      await env.addSectorUsers(A, 'JURIDICO', 4);
      const off = withBlocker(code, entity);
      try {
        const err = await env.fail(env.advance(A, 'JURIDICO'));
        assert.deepEqual([err.status, err.code], [409, 'GOV_CANARY_BLOCKERS_OPEN']);
        assert.ok(err.details.blockers.some((b) => b.code === code));
      } finally { off(); }
      assert.equal((await env.advance(A, 'JURIDICO')).percent, 5);
    });
  }
}
