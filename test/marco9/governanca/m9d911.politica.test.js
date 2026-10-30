'use strict';

// M9-D911 — política de retenção: os cinco elementos do livro, as recusas, o idempotente do PUT, o isolamento e o cálculo de elegibilidade (mês de calendário).
// Banco descartável:
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d911.politica.test.js"
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d911Env');
const { addCalendarMonths } = require('../../../src/features/core-governance/data-quality/retention.calendar');
const { TRIGGERS, DISPOSITIONS, EXCEPTIONS } = require('../../../src/features/core-governance/data-quality/retention.constants');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenants;
before(async () => { if (env.DISPOSABLE) { tenants = await env.loadTenants(); await env.resetRetention(tenants.A); await env.resetRetention(tenants.B); } });
after(async () => { if (env.DISPOSABLE) { await env.resetRetention(tenants.A); await env.resetRetention(tenants.B); } await env.sequelize.close(); });
const A = () => tenants.A;
const put = (body, tenant = A()) => env.inTx(tenant, (tx) => env.service.putPolicy(tenant, env.actorOf(tenant), body, tx));
const refused = (promise) => promise.then(() => null, (err) => [err.statusCode, err.code, err.message]);
const GOOD = (code, extra = {}) => ({ code, name: `Política ${code}`, retention_months: 12, trigger: 'TRANSACTION_DATE', legal_basis: { code: 'LGPD_ART7_II_OBRIGACAO_LEGAL', reference_text: 'CTN art. 173' }, disposition: 'DELETE', exceptions: ['LEGAL_HOLD'], owner_domain: 'FISCAL', data_types: [], ...extra });

test('m9d911 cálculo do mês de calendário: 31/08/2025 + 6 meses = 28/02/2026 e contrato de 31/01/2016 + 120 meses = 31/01/2026', () => {
  assert.equal(addCalendarMonths('2025-08-31', 6), '2026-02-28');
  assert.equal(addCalendarMonths('2016-01-31', 120), '2026-01-31');
  assert.equal(addCalendarMonths('2023-08-31', 6), '2024-02-29', 'ano bissexto');
  assert.equal(addCalendarMonths('2025-11-30', 3), '2026-02-28');
  assert.equal(addCalendarMonths('2025-05-15', 0), '2025-05-15');
});

test('m9d911 toda política semeada tem os cinco elementos do livro (prazo, gatilho, base legal, disposição, exceções com LEGAL_HOLD)', { skip: env.skip() }, async () => {
  const list = await env.policies(A());
  assert.deepEqual(list.map((p) => p.code).sort(), ['AUDITORIA_SEGURANCA', 'CONTRATOS', 'FISCAL', 'INTEGRACAO', 'JURIDICO', 'LEADS', 'LOGS_TECNICOS', 'REVIEW_DEFAULT']);
  for (const p of list) {
    assert.ok(Number.isInteger(p.retentionMonths) && p.retentionMonths >= 0, `${p.code} prazo`);
    assert.ok(TRIGGERS.includes(p.trigger), `${p.code} gatilho`);
    assert.ok(p.legalBasis.code && p.legalBasis.text && p.legalBasis.referenceText, `${p.code} base legal`);
    assert.ok(Object.values(DISPOSITIONS).includes(p.disposition), `${p.code} disposição`);
    assert.ok(p.exceptions.includes('LEGAL_HOLD') && p.exceptions.every((e) => EXCEPTIONS.includes(e)), `${p.code} exceções`);
  }
  const by = Object.fromEntries(list.map((p) => [p.code, p]));
  assert.deepEqual([by.FISCAL.retentionMonths, by.CONTRATOS.retentionMonths, by.JURIDICO.retentionMonths, by.LEADS.retentionMonths, by.LOGS_TECNICOS.retentionMonths, by.AUDITORIA_SEGURANCA.retentionMonths], [60, 120, 120, 24, 18, 60]);
  assert.deepEqual([by.LEADS.disposition, by.LOGS_TECNICOS.disposition, by.AUDITORIA_SEGURANCA.disposition], ['ANONYMIZE', 'DELETE', 'ARCHIVE']);
  assert.deepEqual([by.REVIEW_DEFAULT.retentionMonths, by.REVIEW_DEFAULT.disposition], [0, 'REVIEW']);
  assert.equal(by.FISCAL.disposition, 'REVIEW', 'onde o livro não define a disposição, a decisão é humana');
});

test('m9d911 política sem base legal é recusada (422 GOV_RETENTION_LEGAL_BASIS_REQUIRED) e base fora do catálogo também', { skip: env.skip() }, async () => {
  const noBasis = GOOD('SEM_BASE'); delete noBasis.legal_basis;
  assert.deepEqual(await refused(put(noBasis)), [422, 'GOV_RETENTION_LEGAL_BASIS_REQUIRED', 'Informe a base legal da política de retenção.']);
  assert.equal((await refused(put(GOOD('SEM_BASE', { legal_basis: { code: 'LGPD_ART7_II_OBRIGACAO_LEGAL' } }))))[1], 'GOV_RETENTION_LEGAL_BASIS_REQUIRED', 'sem a norma citada');
  assert.equal((await refused(put(GOOD('BASE_RUIM', { legal_basis: { code: 'QUALQUER', reference_text: 'x' } }))))[1], 'GOV_RETENTION_LEGAL_BASIS_INVALID');
  const ok = await put(GOOD('SENSIVEL', { legal_basis: { code: 'LGPD_ART11_II_A', reference_text: 'LGPD art. 11, II, a' } }));
  assert.equal(ok.policy.legalBasis.code, 'LGPD_ART11_II_A', 'base de dado sensível aceita');
});

test('m9d911 prazo negativo ou inválido é 422 GOV_RETENTION_PERIOD_INVALID; 0 só com a disposição REVIEW', { skip: env.skip() }, async () => {
  assert.deepEqual(await refused(put(GOOD('NEG', { retention_months: -1 }))), [422, 'GOV_RETENTION_PERIOD_INVALID', 'O prazo de retenção é inválido.']);
  assert.equal((await refused(put(GOOD('FRAC', { retention_months: 1.5 }))))[1], 'GOV_RETENTION_PERIOD_INVALID');
  assert.equal((await refused(put(GOOD('TXT', { retention_months: '12' }))))[1], 'GOV_RETENTION_PERIOD_INVALID');
  assert.equal((await refused(put(GOOD('ZERO', { retention_months: 0, disposition: 'DELETE' }))))[1], 'GOV_RETENTION_PERIOD_INVALID', 'apagar na hora não é permitido');
  const zero = await put(GOOD('ZERO_OK', { retention_months: 0, disposition: 'REVIEW' }));
  assert.equal(zero.policy.retentionMonths, 0);
});

test('m9d911 toda política respeita o legal hold: sem LEGAL_HOLD nas exceções é 422 GOV_RETENTION_HOLD_EXCEPTION_REQUIRED', { skip: env.skip() }, async () => {
  assert.deepEqual(await refused(put(GOOD('SEM_HOLD', { exceptions: ['TAX_AUDIT'] }))), [422, 'GOV_RETENTION_HOLD_EXCEPTION_REQUIRED', 'Toda política deve respeitar a retenção legal (legal hold).']);
  assert.equal((await refused(put(GOOD('SEM_HOLD', { exceptions: [] }))))[1], 'GOV_RETENTION_HOLD_EXCEPTION_REQUIRED');
  assert.equal((await refused(put((({ exceptions, ...rest }) => rest)(GOOD('SEM_HOLD')))))[1], 'GOV_RETENTION_HOLD_EXCEPTION_REQUIRED', 'política nova sem a lista também');
  const edited = await env.editPolicy(A(), 'LOGS_TECNICOS', { retention_months: 20 });
  assert.ok(edited.policy.exceptions.includes('LEGAL_HOLD'), 'editar mantém o hold');
});

test('m9d911 o alvo precisa aceitar o gatilho e a disposição; alvo repetido em duas políticas e auto_apply fora de integração são recusados', { skip: env.skip() }, async () => {
  assert.equal((await refused(put(GOOD('X1', { data_types: ['ACCESS_SIGNALS'], disposition: 'ANONYMIZE' }))))[1], 'GOV_RETENTION_DISPOSITION_UNSUPPORTED');
  assert.equal((await refused(put(GOOD('X2', { data_types: ['ACCESS_SIGNALS'], trigger: 'CASE_CLOSED' }))))[1], 'GOV_RETENTION_TRIGGER_UNSUPPORTED');
  assert.equal((await refused(put(GOOD('X3', { data_types: ['ACCESS_SIGNALS'] }))))[1], 'GOV_RETENTION_TARGET_TAKEN');
  assert.equal((await refused(put(GOOD('X4', { data_types: ['NAO_EXISTE'] }))))[0], 400);
  assert.equal((await refused(put(GOOD('X5', { auto_apply: true, data_types: ['AUDIT_LOG'], disposition: 'ARCHIVE' }))))[1], 'GOV_RETENTION_AUTO_APPLY_UNSAFE');
  assert.equal((await refused(put({ ...GOOD('X6'), campo_novo: 1 })))[0], 400, 'campo desconhecido');
});

test('m9d911 PUT igual não altera nada (versão e data iguais); alteração sobe a versão e audita antes e depois', { skip: env.skip() }, async () => {
  const before = await env.policyOf(A(), 'LEADS');
  const same = await env.editPolicy(A(), 'LEADS', {});
  assert.equal(same.changed, false);
  const mid = await env.policyOf(A(), 'LEADS');
  assert.deepEqual([mid.version, String(mid.updatedAt)], [before.version, String(before.updatedAt)]);
  const changed = await env.editPolicy(A(), 'LEADS', { retention_months: 30 });
  assert.deepEqual([changed.changed, changed.policy.version, changed.policy.retentionMonths, changed.policy.approvedBy], [true, before.version + 1, 30, A().userId]);
  const { rows } = await env.adminQuery("SELECT before_json, after_json FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.retention.policy.changed' AND entity_id = $2 ORDER BY occurred_at DESC LIMIT 1", [A().companyId, before.id]);
  assert.deepEqual([rows[0].before_json.retentionMonths, rows[0].after_json.retentionMonths], [before.retentionMonths, 30]);
});

test('m9d911 os prazos iniciais são parâmetros: mudar governanca.retencao.prazo_meses.fiscal vale para a política criada depois', { skip: env.skip() }, async () => {
  await env.resetRetention(A());
  await env.inTx(A(), (tx) => upsertSetting('governanca.retencao.prazo_meses.fiscal', 72, A(), A().userId, tx));
  try {
    assert.equal((await env.policyOf(A(), 'FISCAL')).retentionMonths, 72);
  } finally {
    await env.adminQuery("DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = 'governanca.retencao.prazo_meses.fiscal'", [A().companyId]).catch(() => {});
    await env.resetRetention(A());
  }
});

test('m9d911 isolamento entre empresas: a política e a rodada de uma não aparecem na outra', { skip: env.skip() }, async () => {
  await put(GOOD('SO_DA_A', { data_types: [] }));
  const listB = await env.policies(tenants.B);
  assert.equal(listB.some((p) => p.code === 'SO_DA_A'), false);
  const run = await env.dryRun(A(), { policyCodes: ['LOGS_TECNICOS'] });
  const seenByB = await env.inTx(tenants.B, (tx) => env.service.listRuns(tenants.B, {}, tx));
  assert.equal(seenByB.items.some((r) => r.id === run.id), false);
  await assert.rejects(env.inTx(tenants.B, (tx) => env.service.getRun(tenants.B, run.id, {}, tx)), (err) => err.statusCode === 404);
  await assert.rejects(env.apply(tenants.B, run.id), (err) => err.code === 'GOV_RETENTION_DRY_RUN_REQUIRED', 'a rodada da outra empresa é "sem simulação"');
});
