'use strict';

// M9-D708 — os comandos operacionais scripts/analytics/reconcile.js e acceptMetric.js (sem rota nem tela) e a etapa 14 da esteira
// (gateAceite.js) lendo a tabela real analytics.metric_acceptance, com uma métrica aceita e outra pendente. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const e708 = require('../_helpers/m9d708Env');
const { runReconcile, parseArgs: parseReconcile } = require('../../../scripts/analytics/reconcileCli');
const { runAccept, parseArgs: parseAccept } = require('../../../scripts/analytics/acceptMetricCli');
require('../../../src/features/analytics');

const { entry, account, bankTx, run, dayAt } = e708;
let env;
let granted = [];
before(async () => {
  env = await e708.setup();
  const [rows] = await env.admin.query(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
    SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r, core.permissions p
     WHERE r.company_id = :c AND r.name = :n AND p.code IN ('analytics:accept', 'analytics:read') RETURNING id`, { replacements: { c: env.cX.companyId, n: e708.OWNER_ROLE } });
  granted = rows.map((r) => r.id);
  const t = env.cX;
  const acc = await account(env, t, { opening: '0.00' });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '5000.00', account: acc, settled: dayAt(-2) });
  await bankTx(env, t, { account: acc, amount: '5000.00', date: '2026-10-26' });
  await run(t);
  await env.admin.query("UPDATE analytics.metric_definitions SET status = 'RETIRED' WHERE company_id = :c AND status = 'PUBLISHED' AND metric_code NOT IN ('fin.free_cash', 'fin.third_party_cash')", { replacements: { c: t.companyId } });
});
after(async () => {
  if (granted.length) await env.admin.query('DELETE FROM core.role_permissions WHERE id IN (:ids)', { replacements: { ids: granted } });
  await e708.teardown(env);
});

async function cli(fn, args) {
  const out = [];
  const err = [];
  const code = await fn(args, { out: (l) => out.push(l), err: (l) => err.push(l), asOfDate: e708.AS_OF, now: e708.NOW });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('m9d708 reconcile.js lê os argumentos e recusa uso incorreto', async () => {
  assert.deepEqual(parseReconcile(['--metric=fin.free_cash', '--company=abc']), { metric: 'fin.free_cash', company: 'abc', data: undefined });
  for (const args of [[], ['--metric=fin.free_cash'], ['--company=x'], ['--metric=fin.free_cash', '--company=nao-e-uuid']]) {
    const r = await cli(runReconcile, args);
    assert.equal(r.code, 2);
    assert.match(r.err, /Uso: node scripts\/analytics\/reconcile.js/);
  }
});

test('m9d708 reconcile.js calcula BI e relatório, grava a linha PENDING e imprime a diferença', async () => {
  const r = await cli(runReconcile, [`--metric=fin.free_cash`, `--company=${env.cX.companyId}`]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /fin\.free_cash/);
  assert.match(r.out, /diferença 0,00/);
  const row = await e708.acceptanceRow(env, env.cX, 'fin.free_cash', 1);
  assert.deepEqual([row.status, row.bi_value, row.reference_value, row.difference], ['PENDING', '5000.00', '5000.00', '0.00']);
  const all = await cli(runReconcile, [`--metric=all`, `--company=${env.cX.companyId}`]);
  assert.equal(all.code, 0, all.err);
  assert.match(all.out, /fin\.third_party_cash/);
  const missing = await cli(runReconcile, ['--metric=fin.free_cash', `--company=${e708.uuid()}`]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /Empresa não encontrada/);
});

test('m9d708 acceptMetric.js lê os argumentos, exige o usuário owner e grava o aceite com a evidência', async () => {
  assert.deepEqual(parseAccept(['--metric=fin.free_cash', '--company=c', '--user=u', '--decisao=ACEITAR', '--evidencia=f', '--versao=2', '--comentario= ok ']),
    { metric: 'fin.free_cash', company: 'c', user: 'u', decision: 'ACEITAR', evidence: 'f', version: 2, comment: 'ok' });
  const usage = await cli(runAccept, ['--metric=fin.free_cash']);
  assert.equal(usage.code, 2);
  assert.match(usage.err, /Uso: node scripts\/analytics\/acceptMetric.js/);
  const file = await e708.evidenceFile(env, env.cX);
  const base = [`--metric=fin.free_cash`, `--company=${env.cX.companyId}`, `--decisao=ACEITAR`, `--evidencia=${file}`];
  const notOwner = await cli(runAccept, [...base, `--user=${env.otherUserId}`]);
  assert.equal(notOwner.code, 1);
  assert.match(notOwner.err, /ANALYTICS_ACCEPT_NOT_OWNER|Permissão ausente/);
  const ok = await cli(runAccept, [...base, `--user=${env.ownerUserId}`, '--comentario=Conferido']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /ACCEPTED/);
  assert.equal((await e708.acceptanceRow(env, env.cX, 'fin.free_cash', 1)).status, 'ACCEPTED');
});

test('m9d708 etapa 14 da esteira lê a tabela real: aceita passa, pendente reprova em PRODUCAO e em LAB só informa', async () => {
  const gate = path.join(__dirname, '../../../scripts/analytics/ci/gateAceite.js');
  const exec = (ambiente) => spawnSync(process.execPath, [gate, '--ambiente', ambiente], { env: { ...process.env }, encoding: 'utf8' });
  const prod = exec('PRODUCAO');
  assert.equal(prod.status, 1, prod.stdout + prod.stderr);
  assert.match(prod.stdout, /pendente: .*fin\.third_party_cash/, 'a pendente aparece');
  assert.doesNotMatch(prod.stdout, /pendente: .*fin\.free_cash/, 'a aceita não aparece');
  assert.match(prod.stderr, /Reprovada/);
  const lab = exec('LAB');
  assert.equal(lab.status, 0, lab.stdout + lab.stderr);
  assert.match(lab.stdout, /fin\.third_party_cash/);
  const file = await e708.evidenceFile(env, env.cX);
  await cli(runReconcile, [`--metric=fin.third_party_cash`, `--company=${env.cX.companyId}`]);
  await cli(runAccept, [`--metric=fin.third_party_cash`, `--company=${env.cX.companyId}`, `--user=${env.ownerUserId}`, `--decisao=ACEITAR`, `--evidencia=${file}`]);
  const done = exec('PRODUCAO');
  // outros testes podem deixar métricas sintéticas publicadas em outras empresas do banco: aqui vale o que é desta empresa
  assert.doesNotMatch(done.stdout, new RegExp(`\\[empresa ${env.cX.companyId}\\]`), done.stdout);
  assert.match(done.stdout, /com aceite/);
});
