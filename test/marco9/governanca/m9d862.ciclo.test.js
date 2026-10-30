'use strict';

// M9-D862 — idempotência, somente leitura, resolução automática, falha sem achado falso e agendamento dos cinco jobs (banco descartável).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d862Env');
const { runDetector, runSchedule, byCode } = require('../../../src/features/core-governance/finops/detectors/run');
const { DETECTORS } = require('../../../src/features/core-governance/finops/detectors');
const { isDue } = require('../../../src/engines/jobs/finopsDetectorsJob');
const { collectorStatus, detectorStatus } = require('../../../src/features/core-governance/finops/collectors/status');
const { KEYS, DETECTOR_SETTING_DEFAULTS, DETECTOR_SETTINGS_SCHEMA } = require('../../../src/features/core-governance/finops/detectors/detectors.settings');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, async (tx) => { await env.resetFindings(tenant, tx); return fn(tx); });
const go = (code, tx, now = env.NOW, tenant = tenants.A) => runDetector(tenant, byCode(code), now, tx);
const all = (tx) => env.findings(tenants.A, tx);

test('m9d862 replay não duplica finding', { skip: skip() }, async () => {
  await run(async (tx) => {
    await env.outbox(tenants.A, tx, 6000);
    const first = await go('QUEUE_BACKLOG', tx);
    const later = new Date(env.NOW.getTime() + 5 * 60000);
    const second = await go('QUEUE_BACKLOG', tx, later);
    assert.deepEqual([first.opened, first.updated, second.opened, second.updated], [1, 0, 0, 1]);
    const rows = await all(tx);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].first_seen_at.getTime(), rows[0].last_seen_at.getTime()], [env.NOW.getTime(), later.getTime()], 'primeira vez fica, última vez avança');
  });
});

test('m9d862 detector não altera nem apaga dado', { skip: skip() }, async () => {
  const b = env.bucket(tenants.A);
  try {
    await run(async (tx) => {
      const A = tenants.A;
      await env.file(A, tx, { age: 45 });
      await env.outbox(A, tx, 6000);
      await env.aiRuns(A, tx, { n: 5, model: 'caro', cost: '0.90' });
      await env.volumes(A, tx, { category: 'EGRESS', unit: 'bytes', service: 'egress:x' }, [...Array(14).fill(1024 ** 3), 9 * 1024 ** 3]);
      b.put(`docs/${A.groupId}/solto.bin`);
      const snap = async () => (await env.q(tx, `SELECT
        (SELECT count(*) FROM people.files) AS files, (SELECT count(*) FROM integration.outbox_events) AS outbox, (SELECT count(*) FROM ai.ai_runs) AS runs,
        (SELECT count(*) FROM governance.cost_ledger) AS ledger, (SELECT coalesce(sum(amount_cents),0) FROM governance.cost_ledger) AS cents,
        (SELECT count(*) FROM integration.outbox_events WHERE status = 'PENDING') AS pending`, {}))[0];
      const before = await snap();
      const outs = await runSchedule(A, 'daily', env.NOW, tx);
      outs.push(...await runSchedule(A, 'queue', env.NOW, tx));
      assert.equal(outs.length, 5);
      assert.ok(outs.every((o) => o.ok));
      assert.ok((await all(tx)).length >= 4, 'os detectores acharam coisas');
      assert.deepEqual(await snap(), before, 'nenhuma tabela de dado foi alterada');
      assert.equal(require('node:fs').readdirSync(b.root, { recursive: true }).filter((f) => f.endsWith('solto.bin')).length, 1, 'o objeto do bucket continua lá');
    });
  } finally { b.cleanup(); }
});

test('m9d862 condição some e finding resolve sozinho', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    await env.outbox(A, tx, 6000);
    await go('QUEUE_BACKLOG', tx);
    assert.deepEqual((await all(tx)).map((r) => r.status), ['OPEN']);
    await env.q(tx, "UPDATE integration.outbox_events SET status = 'SENT' WHERE company_id = :c AND status = 'PENDING'", { c: A.companyId });
    const out = await go('QUEUE_BACKLOG', tx, new Date(env.NOW.getTime() + 300000));
    assert.equal(out.resolved, 1);
    const [row] = await all(tx);
    assert.deepEqual([row.status, row.resolved_at !== null], ['RESOLVED', true]);
    await env.q(tx, "UPDATE integration.outbox_events SET status = 'PENDING' WHERE company_id = :c", { c: A.companyId });
    await go('QUEUE_BACKLOG', tx, new Date(env.NOW.getTime() + 600000));
    assert.deepEqual((await all(tx)).map((r) => r.status).sort(), ['OPEN', 'RESOLVED'], 'voltou o problema: abre um achado novo e o resolvido fica no histórico');
  });
});

test('m9d862 detector com erro registra falha e não cria nem resolve finding falso', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    await env.outbox(A, tx, 6000);
    await go('QUEUE_BACKLOG', tx);
    const failing = await runDetector(A, byCode('QUEUE_BACKLOG'), env.NOW, tx, { detect: async () => { throw new Error('banco indisponível'); } });
    assert.deepEqual([failing.ok, failing.code], [false, 'GOV_FINOPS_COLLECTOR_FAILED']);
    assert.deepEqual((await all(tx)).map((r) => r.status), ['OPEN'], 'o achado aberto não foi resolvido por causa da falha');
    const status = await detectorStatus(A, tx);
    assert.deepEqual(status.map((s) => [s.detector, s.situacao, s.falhasSeguidas]), [['queue_backlog', 'FAILED', 1]]);
    assert.equal((await collectorStatus(A, tx)).filter((c) => c.coletor.startsWith('det_')).length, 0, 'os coletores de custo não misturam os detectores');
    const ok = await go('QUEUE_BACKLOG', tx);
    assert.equal(ok.ok, true);
    assert.equal((await detectorStatus(A, tx))[0].falhasSeguidas, 0);
  });
});

test('m9d862 os cinco jobs rodam às 03:00 e a fila no intervalo, com limiares e horários configuráveis', () => {
  assert.deepEqual(DETECTORS.map((d) => d.detector).sort(), ['AI_MODEL_COST', 'EGRESS', 'LOG_VOLUME', 'ORPHAN_STORAGE', 'QUEUE_BACKLOG']);
  const tenant = { companyId: 'c1' };
  const params = { detectorHour: 3, queueInterval: 5 };
  const daily = byCode('EGRESS');
  const queue = byCode('QUEUE_BACKLOG');
  assert.equal(isDue(daily, tenant, params, new Date('2026-10-30T06:00:00Z'), false), true, '03:00 de Brasília');
  assert.equal(isDue(daily, tenant, params, new Date('2026-10-30T07:00:00Z'), false), false, '04:00 não');
  assert.equal(isDue(daily, tenant, { ...params, detectorHour: 4 }, new Date('2026-10-30T07:00:00Z'), false), true, 'a hora é parâmetro');
  assert.equal(isDue(queue, tenant, params, new Date('2026-10-30T07:41:00Z'), false), true, 'a fila não espera a madrugada');
  for (const key of Object.values(KEYS)) assert.ok(key in DETECTOR_SETTING_DEFAULTS && key in DETECTOR_SETTINGS_SCHEMA, key);
  assert.deepEqual([DETECTOR_SETTING_DEFAULTS[KEYS.orphanDays], DETECTOR_SETTING_DEFAULTS[KEYS.logFactor], DETECTOR_SETTING_DEFAULTS[KEYS.queueMax], DETECTOR_SETTING_DEFAULTS[KEYS.queueOldMin], DETECTOR_SETTING_DEFAULTS[KEYS.queueAgeMin], DETECTOR_SETTING_DEFAULTS[KEYS.aiCallCents], DETECTOR_SETTING_DEFAULTS[KEYS.egressFactor]], [30, 3, 5000, 50, 30, 50, 3]);
});
