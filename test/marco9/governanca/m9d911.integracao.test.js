'use strict';

// M9-D911 — o calendário de retenção inclui as tabelas de integração: o retentionJob simula tudo, aplica sozinho só o descarte técnico (integration.purge_expired, M9-D244)
// e respeita os 7 dias do payload bruto de DEAD_LETTER (M9-D212/D203) e o legal hold.
// Banco descartável: ver m9d911.politica.test.js.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const env = require('../_helpers/m9d911Env');
const { runRetentionJob } = require('../../../src/engines/jobs/retentionJob');

let tenants;
const A = () => tenants.A;
before(async () => { if (env.DISPOSABLE) { tenants = await env.loadTenants(); await env.resetRetention(A()); } });
afterEach(() => env.holdGuard.resetProvider());
after(async () => { if (env.DISPOSABLE) { await env.adminQuery("DELETE FROM integration.webhook_inbox WHERE company_id = $1 AND provider_code = 'qa-m9d911'", [A().companyId]); await env.resetRetention(A()); } await env.sequelize.close(); });
const inbox = (age, status = 'DEAD_LETTER') => env.adminQuery(
  `INSERT INTO integration.webhook_inbox (id, group_id, company_id, provider_code, external_event_id, signature_valid, payload_hash, payload_raw, payload, status, received_at)
   VALUES ($1, $2, $3, 'qa-m9d911', $4, true, 'hash', 'corpo-bruto', '{"a":1}'::jsonb, $5, now() - ($6 || ' days')::interval) RETURNING id`, [randomUUID(), A().groupId, A().companyId, `ev-${randomUUID()}`, status, String(age)]
);
const rawOf = async (id) => (await env.adminQuery("SELECT convert_from(payload_raw, 'UTF8') AS payload_raw, payload FROM integration.webhook_inbox WHERE id = $1", [id])).rows[0];

test('m9d911 o calendário de retenção traz a política de integração (INTEGRACAO) apontando para integration.purge_expired, com aplicação automática', { skip: env.skip() }, async () => {
  const p = await env.policyOf(A(), 'INTEGRACAO');
  assert.deepEqual([p.dataTypes, p.disposition, p.autoApply, p.exceptions], [['INTEGRACAO'], 'DELETE', true, ['LEGAL_HOLD']]);
  assert.ok(p.retentionMonths >= 1);
  const dry = await env.dryRun(A(), { policyCodes: ['INTEGRACAO'] });
  const report = env.policyReport(dry, 'INTEGRACAO');
  assert.equal(report.targets[0].effectiveDays.inbox_dlq_raw_days, 7, 'o payload bruto de DEAD_LETTER por ATTEMPTS_EXHAUSTED tem retenção de 7 dias');
});

test('m9d911 retentionJob chama integration.purge_expired e respeita os 7 dias do payload de DLQ (8 dias limpa, 3 dias mantém)', { skip: env.skip() }, async () => {
  const old = (await inbox(8)).rows[0].id;
  const young = (await inbox(3)).rows[0].id;
  const summary = await runRetentionJob({ force: true });
  assert.equal(summary.errors, 0);
  const mine = summary.summaries.find((s) => s.companyId === A().companyId);
  assert.ok(mine && mine.autoRunId && mine.autoStatus === 'APPLIED', 'o job simulou e aplicou a política automática');
  assert.deepEqual(await rawOf(old), { payload_raw: null, payload: null }, 'passou de 7 dias: corpo bruto limpo');
  const kept = await rawOf(young);
  assert.equal(kept.payload_raw, 'corpo-bruto', '3 dias: continua guardado para o reenvio');
  const dryOfJob = (await env.adminQuery("SELECT count(*)::int AS n FROM governance.retention_runs WHERE company_id = $1 AND source = 'JOB'", [A().companyId])).rows[0].n;
  assert.equal(dryOfJob >= 1, true, 'o job também gera a simulação de todas as políticas');
  const purge = await env.adminQuery("SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = $1 AND action = 'integration.retention.purge'", [A().companyId]);
  assert.equal(purge.rows[0].n >= 1, true, 'a auditoria da função única de retenção foi gravada');
  const applied = await env.adminQuery("SELECT detail FROM governance.retention_run_items WHERE run_id = $1 AND target_code = 'INTEGRACAO'", [mine.autoRunId]);
  assert.equal(applied.rows[0].detail.webhook_inbox.dlqRawCleared >= 1, true);
});

test('m9d911 as demais políticas nunca são aplicadas pelo job (só simuladas) e legal hold sobre a integração suspende o descarte', { skip: env.skip() }, async () => {
  await env.clearSignals(A());
  await env.insertSignals(A(), 5, '2023-01-15T12:00:00Z');
  const old = (await inbox(9)).rows[0].id;
  env.setHold(new Set([A().companyId])); // hold da empresa sobre os dados de integração
  const summary = await runRetentionJob({ force: true });
  assert.equal(summary.errors, 0);
  assert.equal(await env.countSignals(A()), 5, 'logs técnicos não são descartados pelo job: o apply deles é humano');
  assert.equal((await rawOf(old)).payload_raw, 'corpo-bruto', 'sob hold o corpo bruto não é limpo');
  env.holdGuard.resetProvider();
  await runRetentionJob({ force: true });
  assert.equal((await rawOf(old)).payload_raw, null, 'liberado o hold, o descarte técnico acontece');
  assert.equal(await env.countSignals(A()), 5);
  await env.clearSignals(A());
});
