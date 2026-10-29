'use strict';

// M9-D820 — edição da política: piso do livro, auditoria com antes e depois, idempotência e validação. Banco descartável (ver m9d820.matriz.test.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/dlpEnv');
const service = require('../../../src/features/core-governance/dlp/policy.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);
const put = (tx, c, a, body) => service.updatePolicy(tenants.A, env.actorOf(tenants.A), c, a, body, tx);

test('m9d820 piso do livro impede enfraquecer EXPORT HIGH', { skip: skip() }, async () => {
  await run(async (tx) => {
    for (const c of ['HIGH', 'RESTRICTED']) {
      for (const field of ['requireJustification', 'requireMfa', 'requireAudit']) {
        const err = await env.codeOf(put(tx, c, 'EXPORT', { [field]: false }));
        assert.deepEqual([err.status, err.code, err.message], [422, 'GOV_DLP_FLOOR_VIOLATION', 'Esta classificação exige justificativa, verificação em duas etapas, auditoria e expiração.'], `${c} ${field}`);
        assert.deepEqual(err.details.fields, [field]);
      }
      const noExpiry = await env.codeOf(put(tx, c, 'EXPORT', { maxExpiryHours: null }));
      assert.equal(noExpiry.code, 'GOV_DLP_FLOOR_VIOLATION', `${c} sem expiração`);
      const snake = await env.codeOf(put(tx, c, 'EXPORT', { require_mfa: false }));
      assert.equal(snake.code, 'GOV_DLP_FLOOR_VIOLATION', 'snake_case também');
    }
    const after = await service.getPolicy(tenants.A, 'RESTRICTED', 'EXPORT', tx);
    assert.deepEqual([after.requireJustification, after.requireMfa, after.requireAudit, after.maxExpiryHours], [true, true, true, 24], 'recusa não grava nada');
  });
});

test('m9d820 o piso só vale para EXPORT de HIGH e RESTRICTED; endurecer é sempre permitido', { skip: skip() }, async () => {
  await run(async (tx) => {
    assert.equal((await put(tx, 'MEDIUM', 'EXPORT', { requireAudit: false })).requireAudit, false, 'MEDIUM não tem piso');
    assert.equal((await put(tx, 'HIGH', 'PRINT', { requireJustification: false })).requireJustification, false, 'PRINT não tem piso no livro');
    assert.equal((await put(tx, 'HIGH', 'EXPORT', { allowed: false })).allowed, false, 'negar a ação endurece');
    assert.equal((await put(tx, 'HIGH', 'EXPORT', { allowed: true, maxExpiryHours: 12 })).maxExpiryHours, 12, 'reduzir a expiração endurece');
  });
});

test('m9d820 alteração exige permissão dlp:admin e audita antes e depois', { skip: skip() }, async () => {
  await run(async (tx) => {
    const out = await put(tx, 'MEDIUM', 'EXPORT', { maxExpiryHours: 24 });
    assert.equal(out.maxExpiryHours, 24);
    assert.equal(out.updatedBy, tenants.A.userId);
    const [audit] = await env.auditRows(tenants.A, 'governance.dlp_policy.changed', tx);
    assert.ok(audit, 'auditoria gravada');
    assert.equal(audit.user_id, tenants.A.userId);
    assert.equal(audit.before_json.maxExpiryHours, 72);
    assert.equal(audit.after_json.maxExpiryHours, 24);
    assert.deepEqual([audit.after_json.classification, audit.after_json.action], ['MEDIUM', 'EXPORT']);
  });
});

test('m9d820 PUT com o mesmo conteúdo não altera nada nem audita', { skip: skip() }, async () => {
  await run(async (tx) => {
    const countAudits = async () => (await env.auditRows(tenants.A, 'governance.dlp_policy.changed', tx)).length;
    const base = await countAudits();
    await put(tx, 'LOW', 'PRINT', { requireAudit: true });
    assert.equal((await countAudits()) - base, 1, 'a primeira mudança audita uma vez');
    const first = await service.getPolicy(tenants.A, 'LOW', 'PRINT', tx);
    const again = await put(tx, 'LOW', 'PRINT', { requireAudit: true });
    assert.equal(again.updatedAt.getTime(), first.updatedAt.getTime(), 'a linha não foi regravada');
    assert.equal((await countAudits()) - base, 1, 'a repetição não audita de novo');
    await put(tx, 'LOW', 'PRINT', {});
    assert.equal((await countAudits()) - base, 1, 'corpo vazio também não audita');
  });
});

test('m9d820 ação ou classe inexistente e campo inválido devolvem 400 GOV_DLP_POLICY_INVALID', { skip: skip() }, async () => {
  await run(async (tx) => {
    for (const [c, a] of [['TOP', 'EXPORT'], ['HIGH', 'DELETE'], ['', 'VIEW']]) {
      const err = await env.codeOf(put(tx, c, a, { allowed: true }));
      assert.deepEqual([err.status, err.code, err.message], [400, 'GOV_DLP_POLICY_INVALID', 'Classificação ou ação inválida.'], `${c}/${a}`);
    }
    for (const body of [{ allowed: 'sim' }, { maxRows: 0 }, { maxRows: 1.5 }, { maxExpiryHours: 9000 }, { requirePermission: 'Qualquer Coisa' }, { inventado: true }, [1]]) {
      const err = await env.codeOf(put(tx, 'LOW', 'VIEW', body));
      assert.equal(err.code, 'GOV_DLP_POLICY_INVALID', JSON.stringify(body));
    }
    const ok = await put(tx, 'LOW', 'VIEW', { requirePermission: 'finance:entries:read', maxRows: 5 });
    assert.deepEqual([ok.requirePermission, ok.maxRows], ['finance:entries:read', 5]);
    assert.equal((await put(tx, 'LOW', 'VIEW', { requirePermission: null, maxRows: null })).requirePermission, null);
  });
});

test('m9d820 duas edições simultâneas da mesma linha terminam coerentes (trava da linha)', { skip: skip() }, async (t) => {
  if (!env.DISPOSABLE) return t.skip(env.SKIP_DISPOSABLE);
  const { withTenantTransaction } = require('../../testHelpers');
  const A = tenants.A;
  await withTenantTransaction(A, (tx) => service.listPolicies(A, tx));
  const countAudits = async () => (await env.adminQuery("SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.dlp_policy.changed'", [A.companyId])).rows[0].n;
  const base = await countAudits();
  try {
    await Promise.all([
      withTenantTransaction(A, (tx) => service.updatePolicy(A, env.actorOf(A), 'LOW', 'COPY', { requireAudit: true }, tx)),
      withTenantTransaction(A, (tx) => service.updatePolicy(A, env.actorOf(A), 'LOW', 'COPY', { requireMask: true }, tx)),
    ]);
    const row = await withTenantTransaction(A, (tx) => service.getPolicy(A, 'LOW', 'COPY', tx));
    assert.deepEqual([row.requireAudit, row.requireMask], [true, true], 'nenhuma das duas edições se perde');
    assert.equal((await countAudits()) - base, 2);
  } finally {
    await env.adminQuery("DELETE FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.dlp_policy.changed'", [A.companyId]).catch(() => {});
    await env.adminQuery('DELETE FROM governance.dlp_policies WHERE company_id = $1', [A.companyId]);
  }
});
