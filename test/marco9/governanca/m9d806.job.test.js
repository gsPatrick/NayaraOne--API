'use strict';

// M9-D806 — job noturno dataQualityScanJob: avalia a empresa e chama notifyPendingDomains (D804). Banco descartável (ver m9d806.score.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d806Env');
const { runDataQualityScanJob } = require('../../../src/engines/jobs/dataQualityScanJob');
const lifecycle = require('../../../src/features/core-governance/data-quality/stewardship.lifecycle');
const { withTenantTransaction } = require('../../testHelpers');
const { adminQuery } = require('../../m9d801.helpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenants;
const created = { userIds: [] }; // usuário que o teste cria fora de transação; a limpeza o apaga (R4-L2)
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
// O aviso de domínio pendente é uma vez por dia (chave dq.domain_pending:<domínio>:<dia> em calendar_alert_log): uma execução anterior no mesmo dia/banco consome a chave.
const clearDomainClaims = (companyId) => adminQuery("DELETE FROM governance.calendar_alert_log WHERE company_id = $1 AND alert_key LIKE 'dq.domain\\_pending:%'", [companyId]);
before(async () => { if (env.DISPOSABLE) { tenants = await env.loadTenants(); await clearDomainClaims(tenants.A.companyId); } });
after(async () => {
  try {
    if (env.DISPOSABLE) {
      await clearDomainClaims(tenants.A.companyId);
      const { userIds } = created;
      if (userIds.length) {
        await adminQuery('DELETE FROM core.notifications WHERE user_id = ANY($1::uuid[])', [userIds]);
        await adminQuery('DELETE FROM core.user_memberships WHERE user_id = ANY($1::uuid[])', [userIds]);
        await adminQuery('DELETE FROM core.users WHERE id = ANY($1::uuid[])', [userIds]);
      }
    }
  } finally { await env.sequelize.close(); }
});

test('m9d806 o job avalia os cadastros da empresa e chama notifyPendingDomains', { skip: skip() }, async () => {
  const admin = await withTenantTransaction(tenants.A, (tx) => env.newUser(tenants.A, tx, { roleName: 'ADMIN' }));
  created.userIds.push(admin.id);
  const person = await withTenantTransaction(tenants.A, (tx) => env.fullPerson(tenants.A, tx, { legalName: 'QA-M9 Job Varredura' }, { contact: false }));
  const calls = [];
  const original = lifecycle.notifyPendingDomains;
  lifecycle.notifyPendingDomains = async (...args) => { calls.push(args[0].companyId); return original(...args); };
  try {
    const result = await runDataQualityScanJob(new Date(), { force: true });
    assert.ok(result.ran >= 1);
    assert.ok(calls.includes(tenants.A.companyId), 'o job chamou notifyPendingDomains para a empresa');
  } finally { lifecycle.notifyPendingDomains = original; }
  const { rows } = await adminQuery("SELECT status FROM governance.quality_issues WHERE entity_id = $1 AND rule_code = 'PERSON_CONTACT_PRESENT'", [person.id]);
  assert.deepEqual(rows.map((r) => r.status), ['OPEN']);
  const { rows: notes } = await adminQuery("SELECT 1 FROM core.notifications WHERE company_id = $1 AND title = 'Domínio de dados com pendência' AND created_at > now() - interval '1 hour'", [tenants.A.companyId]);
  assert.ok(notes.length >= 1, 'o administrador recebeu a Notification IN_APP do domínio pendente');
});

test('m9d806 o job só roda na hora configurada e uma vez por dia', { skip: skip() }, async () => {
  await withTenantTransaction(tenants.A, (tx) => upsertSetting('governanca.dados.qualidade.varredura_hora', 5, tenants.A, tenants.A.userId, tx));
  try {
    const midnight = new Date('2026-10-29T12:00:00Z'); // 09h em Brasília
    const out = await runDataQualityScanJob(midnight);
    assert.equal(out.ran, 0, 'fora da hora configurada nada roda');
  } finally {
    await withTenantTransaction(tenants.A, (tx) => upsertSetting('governanca.dados.qualidade.varredura_hora', 3, tenants.A, tenants.A.userId, tx));
  }
});
