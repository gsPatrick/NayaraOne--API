'use strict';

// M9-D912 — a retenção (M9-D911) com a trava jurídica REAL: legal hold sempre prevalece sobre o descarte, a corrida entre a simulação e o apply, o dry-run com 1.200 em hold e
// o contrato do escopo jurídico. Banco descartável; sem ele os testes aparecem como pulados.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d912Env');

let tenants;
const A = () => tenants.A;
const NOW = new Date('2026-03-10T15:00:00Z');
const OLD = '2023-01-15T12:00:00Z';
const tag = () => env.tag();
before(async () => { if (env.DISPOSABLE) { tenants = await env.loadTenants(); await env.resetHolds(A()); await env.resetRetention(A()); await env.clearSignals(A()); env.useRealGuard(); } });
afterEach(async () => { if (env.DISPOSABLE) { await env.resetHolds(A()); await env.clearSignals(A()); await env.resetRetention(A()); } });
after(async () => { await env.sequelize.close(); });
const logsOf = (run) => env.policyReport(run, 'LOGS_TECNICOS');

test('m9d912 legal hold sempre prevalece sobre a retenção: o sinal em hold sobra na simulação, no apply e depois dele', { skip: env.skip() }, async () => {
  await env.insertSignals(A(), 10, OLD);
  const ids = await env.signalIds(A());
  const held = ids.slice(0, 3);
  await env.createHold(A(), { scope: held.map((id) => ({ type: 'ENTITY', entity_type: 'ACCESS_SIGNAL', id })) });
  const dry = await env.dryRun(A(), { policyCodes: ['LOGS_TECNICOS'], now: NOW });
  assert.deepEqual([logsOf(dry).eligibleCount, logsOf(dry).blockedByHold, logsOf(dry).wouldDelete], [10, 3, 7]);
  assert.equal((await env.items(dry.id)).some((item) => held.includes(item.record_id)), false, 'o que está em hold não entra no conjunto');
  await env.apply(A(), dry.id, { now: NOW });
  assert.deepEqual((await env.signalIds(A())).sort(), [...held].sort(), 'só os 3 em hold sobraram');
  const again = await env.dryRun(A(), { policyCodes: ['LOGS_TECNICOS'], now: NOW });
  assert.deepEqual([logsOf(again).blockedByHold, logsOf(again).wouldDelete], [3, 0], 'a próxima rodada continua respeitando a trava');
});

test('m9d912 lead em hold não é anonimizado; liberada a retenção, a rodada seguinte o anonimiza', { skip: env.skip() }, async () => {
  const t = tag();
  const lead = await env.insertLead(A(), { name: `Maria Hold ${t}`, taxId: `5555${t}`.slice(0, 14), lastContact: OLD });
  const hold = await env.createHold(A(), { scope: [{ type: 'PERSON', id: lead }] });
  const dry = await env.dryRun(A(), { policyCodes: ['LEADS'], now: NOW });
  const leads = env.policyReport(dry, 'LEADS');
  assert.equal(leads.blockedByHold >= 1, true);
  assert.equal((await env.items(dry.id)).some((item) => item.record_id === lead), false);
  await env.apply(A(), dry.id, { now: NOW });
  assert.equal((await env.personRow(lead)).legal_name, `Maria Hold ${t}`, 'o dado pessoal em hold ficou intacto');
  await env.releaseHold(A(), hold.id);
  const after = await env.dryRun(A(), { policyCodes: ['LEADS'], now: NOW });
  assert.equal((await env.items(after.id)).some((item) => item.record_id === lead), true, 'liberado, volta ao ciclo normal');
  await env.apply(A(), after.id, { now: NOW });
  assert.equal((await env.personRow(lead)).legal_name, '[ANONIMIZADO]');
});

test('m9d912 hold criado entre dry-run e apply é respeitado: o apply re-verifica dentro do lote e pula os 300 novos', { skip: env.skip() }, async () => {
  await env.insertSignals(A(), 700, OLD);
  await env.insertSignals(A(), 300, '2023-02-20T12:00:00Z');
  const dry = await env.dryRun(A(), { policyCodes: ['LOGS_TECNICOS'], now: NOW });
  assert.deepEqual([logsOf(dry).blockedByHold, logsOf(dry).wouldDelete], [0, 1000]);
  const hold = await env.createHold(A(), { scope: [{ type: 'DATA_TYPE', entity_type: 'ACCESS_SIGNAL', from: '2023-02-20', to: '2023-02-20' }] });
  const applied = await env.apply(A(), dry.id, { now: NOW });
  assert.equal(applied.status, 'APPLIED');
  assert.equal(await env.countSignals(A()), 300, 'os 700 saíram e os 300 do hold ficaram');
  assert.equal((await env.items(dry.id, "state = 'SKIPPED_HOLD'")).length, 300);
  assert.equal((await env.items(dry.id, "state = 'DONE'")).length, 700);
  assert.equal((await env.targetsOf(hold.id)).length, 300, 'os alvos foram materializados quando a checagem os viu');
});

test('m9d912 dry-run com 1.200 registros em hold devolve blocked_by_hold 1.200 e would_delete 38.800', { skip: env.skip() }, async () => {
  await env.insertSignals(A(), 38800, OLD);
  await env.insertSignals(A(), 1200, '2023-03-05T12:00:00Z');
  await env.createHold(A(), { scope: [{ type: 'DATA_TYPE', entity_type: 'ACCESS_SIGNAL', from: '2023-03-05', to: '2023-03-05' }] });
  const run = await env.dryRun(A(), { policyCodes: ['LOGS_TECNICOS'], now: NOW });
  const logs = logsOf(run);
  assert.deepEqual([logs.eligibleCount, logs.blockedByHold, logs.wouldDelete], [40000, 1200, 38800]);
  assert.equal((await env.items(run.id)).length, 38800);
  assert.equal(await env.countSignals(A()), 40000, 'a simulação não apaga nada');
});

test('m9d912 contrato do escopo jurídico em hold fica em blocked_by_hold e o apply o pula; a retenção não alcança assinatura, vistoria nem prova crítica', { skip: env.skip() }, async () => {
  await env.editPolicy(A(), 'CONTRATOS', { disposition: 'ARCHIVE', retention_months: 1 });
  const held = await env.insertContract(A(), null, { endsAt: '2020-01-31T12:00:00Z', status: 'TERMINATED' });
  const free = await env.insertContract(A(), null, { endsAt: '2020-01-31T12:00:00Z', status: 'TERMINATED' });
  await env.createHold(A(), { scope: [{ type: 'CONTRACT', id: held }] });
  const dry = await env.dryRun(A(), { policyCodes: ['CONTRATOS'], now: NOW });
  const target = env.policyReport(dry, 'CONTRATOS').targets.find((t) => t.target === 'CONTRACTS');
  assert.equal(target.blockedByHold >= 1, true);
  assert.deepEqual((await env.items(dry.id)).map((item) => item.record_id).filter((id) => [held, free].includes(id)), [free]);
  await env.apply(A(), dry.id, { now: NOW });
  const archived = (await env.adminQuery("SELECT record_id FROM governance.retention_archives WHERE company_id = $1 AND target_code = 'CONTRACTS'", [A().companyId])).rows.map((r) => r.record_id);
  assert.equal(archived.includes(free), true);
  assert.equal(archived.includes(held), false, 'o contrato em hold não foi arquivado');
  const targets = require('../../../src/features/core-governance/data-quality/retention.targets').all().filter((x) => x.table).map((x) => `${x.schema}.${x.table}`);
  for (const table of ['legal.signatures', 'legal.inspections', 'legal.evidence_packages', 'legal.contract_signatures']) assert.equal(targets.includes(table), false, `${table} não é alvo de retenção`);
});

test('m9d912 a retenção de integração (job) respeita a retenção legal da empresa inteira', { skip: env.skip() }, async () => {
  const hold = await env.createHold(A(), { scope: [{ type: 'COMPANY' }] });
  const held = await env.withTx(A(), (tx) => env.guard.heldIds('INTEGRATION', [A().companyId], { tenant: A(), transaction: tx, disposal: true }));
  assert.deepEqual(held, [A().companyId]);
  await env.releaseHold(A(), hold.id);
  assert.deepEqual(await env.withTx(A(), (tx) => env.guard.heldIds('INTEGRATION', [A().companyId], { tenant: A(), transaction: tx })), []);
});
