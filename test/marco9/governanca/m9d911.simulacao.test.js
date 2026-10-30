'use strict';

// M9-D911 — a simulação (dry-run): não altera nada, usa o mês de calendário, conta hold e exceção, tem a saída do REVIEW pela edição da política.
// Banco descartável: ver m9d911.politica.test.js.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d911Env');

let tenants;
before(async () => { if (env.DISPOSABLE) { tenants = await env.loadTenants(); await env.resetRetention(tenants.A); await env.clearSignals(tenants.A); await env.clearFiscal(tenants.A); } });
afterEach(() => env.holdGuard.resetProvider());
after(async () => { if (env.DISPOSABLE) { await env.clearSignals(tenants.A); await env.clearFiscal(tenants.A); await env.resetRetention(tenants.A); } await env.sequelize.close(); });
const A = () => tenants.A;
const NOW = new Date('2026-03-10T15:00:00Z'); // hoje em Brasília: 10/03/2026

test('m9d911 retention dry-run não altera nenhum dado: contagens iguais antes e depois e nenhum item é descartado', { skip: env.skip() }, async () => {
  await env.clearSignals(A());
  await env.insertSignals(A(), 30, '2024-01-10T12:00:00Z'); // 26 meses: vencido para o prazo de 18
  await env.insertSignals(A(), 5, '2026-02-01T12:00:00Z');
  const before = await env.countSignals(A());
  const run = await env.dryRun(A(), { now: NOW });
  assert.equal(await env.countSignals(A()), before, 'a simulação não apaga nada');
  const logs = env.policyReport(run, 'LOGS_TECNICOS');
  assert.deepEqual([logs.eligibleCount, logs.wouldDelete, logs.blockedByHold, logs.blockedByException], [30, 30, 0, 0]);
  assert.equal(logs.sample.length, 20, 'amostra de 20 chaves');
  assert.deepEqual([run.status, run.mode, run.referenceDate], ['DRY_DONE', 'DRY', '2026-03-10']);
  const queued = await env.items(run.id, "target_code = 'ACCESS_SIGNALS'");
  assert.equal(queued.length, 30);
  assert.ok(queued.every((item) => item.state === 'PENDING' && item.disposition === 'DELETE'));
  const log = await env.audits(A(), 'governance.retention.dry_run', run.id);
  assert.equal(log.length, 1, 'a simulação é auditada');
});

test('m9d911 elegibilidade respeita fim de mês: gatilho 31/08/2025 + 6 meses elegível só a partir de 28/02/2026', { skip: env.skip() }, async () => {
  await env.clearSignals(A());
  await env.insertSignals(A(), 1, '2025-08-31T15:00:00Z');
  await env.editPolicy(A(), 'LOGS_TECNICOS', { retention_months: 6 });
  try {
    const dayBefore = await env.dryRun(A(), { policyCodes: ['LOGS_TECNICOS'], now: new Date('2026-02-27T15:00:00Z') });
    assert.equal(env.policyReport(dayBefore, 'LOGS_TECNICOS').eligibleCount, 0, '27/02 ainda não');
    const day = await env.dryRun(A(), { policyCodes: ['LOGS_TECNICOS'], now: new Date('2026-02-28T15:00:00Z') });
    assert.equal(env.policyReport(day, 'LOGS_TECNICOS').eligibleCount, 1, '28/02 já é elegível (31/08 + 6 meses = 28/02)');
    const sql = await env.adminQuery("SELECT (date '2025-08-31' + make_interval(months => 6))::date::text AS d");
    assert.equal(sql.rows[0].d, '2026-02-28', 'o Postgres e o cálculo do serviço usam a mesma regra');
  } finally { await env.editPolicy(A(), 'LOGS_TECNICOS', { retention_months: 18 }); }
});

test('m9d911 dry-run: 40.000 elegíveis com 1.200 em hold => would_delete 38.800 e blocked_by_hold 1.200', { skip: env.skip() }, async () => {
  await env.clearSignals(A());
  await env.insertSignals(A(), 40000, '2023-01-15T12:00:00Z');
  const held = new Set((await env.signalIds(A())).slice(0, 1200));
  env.setHold(held);
  const run = await env.dryRun(A(), { policyCodes: ['LOGS_TECNICOS'], now: NOW });
  const logs = env.policyReport(run, 'LOGS_TECNICOS');
  assert.deepEqual([logs.eligibleCount, logs.blockedByHold, logs.wouldDelete, logs.wouldAnonymize, logs.wouldArchive, logs.forReview], [40000, 1200, 38800, 0, 0, 0]);
  const queued = await env.items(run.id);
  assert.equal(queued.length, 38800);
  assert.equal(queued.some((item) => held.has(item.record_id)), false, 'o que está em hold não entra no conjunto');
  assert.equal(await env.countSignals(A()), 40000);
});

test('m9d911 exceção ativa pula o registro: obrigação fiscal em aberto é blocked_by_exception e a concluída vai para revisão', { skip: env.skip() }, async () => {
  await env.clearFiscal(A());
  await env.insertFiscal(A(), 2010, 'COMPLETED');
  await env.insertFiscal(A(), 2010, 'PENDING', 'DIRF');
  await env.insertFiscal(A(), 2025, 'COMPLETED', 'DECLARACAO'); // 2025 + 60 meses: ainda dentro do prazo
  const run = await env.dryRun(A(), { policyCodes: ['FISCAL'], now: NOW });
  const target = env.policyReport(run, 'FISCAL').targets.find((t) => t.target === 'FISCAL_OBLIGATIONS');
  assert.deepEqual([target.eligibleCount, target.blockedByException, target.forReview, target.wouldDelete], [2, 1, 1, 0]);
  assert.equal((await env.items(run.id)).length, 0, 'disposição REVIEW nunca vira item de descarte');
  const noOpen = await env.editPolicy(A(), 'FISCAL', { exceptions: ['LEGAL_HOLD'] });
  assert.equal(noOpen.changed, true);
  try {
    const again = await env.dryRun(A(), { policyCodes: ['FISCAL'], now: NOW });
    const t2 = env.policyReport(again, 'FISCAL').targets.find((t) => t.target === 'FISCAL_OBLIGATIONS');
    assert.deepEqual([t2.blockedByException, t2.forReview], [0, 2], 'sem a exceção na política, a obrigação aberta não é pulada');
  } finally { await env.editPolicy(A(), 'FISCAL', { exceptions: ['LEGAL_HOLD', 'OPEN_OBLIGATION', 'ONGOING_LITIGATION', 'TAX_AUDIT'] }); await env.clearFiscal(A()); }
});

test('m9d911 item em REVIEW_DEFAULT aparece em for_review e some depois que o steward edita a política', { skip: env.skip() }, async () => {
  const baseline = env.policyReport(await env.dryRun(A(), { policyCodes: ['REVIEW_DEFAULT'], now: NOW }), 'REVIEW_DEFAULT').forReview;
  const key = `qa-m9d911-${Date.now()}`;
  await env.adminQuery("INSERT INTO people.files (id, group_id, company_id, storage_key, file_name, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, 'qa-m9d911.pdf', '2020-01-10', '2020-01-10')", [A().groupId, A().companyId, key]);
  try {
    const first = env.policyReport(await env.dryRun(A(), { policyCodes: ['REVIEW_DEFAULT'], now: NOW }), 'REVIEW_DEFAULT');
    assert.equal(first.forReview, baseline + 1, 'com 0 meses o arquivo vira revisão assim que o gatilho (upload) ocorre');
    assert.deepEqual([first.wouldDelete, first.wouldAnonymize, first.wouldArchive], [0, 0, 0], 'nunca descarta sozinho');
    await env.editPolicy(A(), 'REVIEW_DEFAULT', { retention_months: 1200 });
    const after = env.policyReport(await env.dryRun(A(), { policyCodes: ['REVIEW_DEFAULT'], now: NOW }), 'REVIEW_DEFAULT');
    assert.equal(after.forReview, 0, 'depois da decisão do steward (prazo concreto) o item deixa de estar em revisão');
  } finally { await env.adminQuery('DELETE FROM people.files WHERE storage_key = $1', [key]); await env.editPolicy(A(), 'REVIEW_DEFAULT', { retention_months: 0 }); }
});
