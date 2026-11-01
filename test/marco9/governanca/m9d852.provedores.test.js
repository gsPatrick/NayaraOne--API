'use strict';

// M9-D852 — provedores de impacto lidos direto (banco descartável, com rollback): agente da NAY, credencial nova, link de outro dono, retry seguro e simulação do contrato.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DISPOSABLE, SKIP_DISPOSABLE, loadTenants } = require('../../m9d801.helpers');
const { withRollbackTenantTransaction } = require('../../testHelpers');

const skip = DISPOSABLE ? false : SKIP_DISPOSABLE;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'segredo-de-teste-m9d852';
after(async () => { if (DISPOSABLE) { await require('../_helpers/m9d852Env').desativarConexoesCriadas().catch(() => {}); await require('../../../src/models').sequelize.close().catch(() => {}); } setTimeout(() => process.exit(0), 200); });

const run = async (fn) => { const tenants = await loadTenants(); return withRollbackTenantTransaction(tenants.A, (tx) => fn(tenants.A, tx)); };
const req = (tenant, over = {}) => ({ auth: { ...tenant, permissions: [] }, params: {}, query: {}, body: {}, ...over });

test('m9d852 agente da NAY: o impacto mostra execuções e ferramentas e a versão aposentada é impedimento', { skip }, async () => {
  const { aiAgent } = require('../../../src/shared/destructive-actions/providers/ai.agent');
  const { inserirAgente, levarPara, run: q } = require('../../helpers/aiAgents');
  await run(async (tenant, tx) => {
    const code = `NAY_D852_${Date.now()}`.slice(0, 40);
    const agent = await inserirAgente(tenant, tx, { code });
    await levarPara(agent.id, 'ACTIVE', tx);
    const active = await aiAgent({ params: { code, version: '1' }, transaction: tx });
    assert.deepEqual([active.code, active.impact.blockers, active.impact.counts.versions], [code, [], 1]);
    await q("UPDATE ai.agents SET status = 'RETIRED' WHERE id = :id", { id: agent.id }, tx);
    const retired = await aiAgent({ params: { code, version: '1' }, transaction: tx });
    assert.equal(retired.impact.blockers[0].code, 'AGENT_ALREADY_RETIRED');
    await assert.rejects(() => aiAgent({ params: { code: 'NAO_EXISTE', version: '1' }, transaction: tx }), (e) => e.statusCode === 404);
  });
});

test('m9d852 credencial nova: o código a digitar é o nome e faltar nome ou scope é impedimento', { skip }, async () => {
  const { apiClientCreate } = require('../../../src/shared/destructive-actions/providers/apiClient');
  const ok = await apiClientCreate({ body: { name: '  Parceiro X ', scopes: ['properties:read', 'leads:write'] } });
  assert.deepEqual([ok.code, ok.impact.counts.scopes, ok.impact.blockers], ['Parceiro X', 2, []]);
  const bad = await apiClientCreate({ body: {} });
  assert.deepEqual(bad.impact.blockers.map((b) => b.code), ['NAME_REQUIRED', 'SCOPES_REQUIRED']);
});

test('m9d852 link externo: quem não criou o link e não é administrador do DLP leva 403 antes de pedir a confirmação', { skip }, async () => {
  const { dlpShareLink } = require('../../../src/shared/destructive-actions/providers/dlp.shareLink');
  const { adminQuery } = require('../../m9d801.helpers');
  const tenants = await loadTenants();
  const t = tenants.A;
  const { rows: [other] } = await adminQuery("SELECT id FROM core.users WHERE email = 'ci-a-maker@ci.nayaraone.test'");
  const { rows: [job] } = await adminQuery(
    `INSERT INTO governance.export_jobs (id, group_id, company_id, actor_user_id, kind, action, resource_type, classification, status, requested_at, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,$3,'SHARE','SHARE','legal.contract','HIGH','APPROVED',now(),now(),now()) RETURNING id`, [t.groupId, t.companyId, t.userId]
  );
  const { rows: [link] } = await adminQuery(
    `INSERT INTO governance.share_links (id, group_id, company_id, created_by, resource_type, resource_id, recipient_label, classification, token_hash, expires_at, status, access_count, export_job_id, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,$3,'legal.contract',gen_random_uuid(),'Cliente QA','HIGH',$4,now() + interval '1 day','ACTIVE',2,$5,now(),now()) RETURNING id`,
    [t.groupId, t.companyId, t.userId, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), job.id]
  );
  try {
    await withRollbackTenantTransaction(t, async (tx) => {
      await assert.rejects(() => dlpShareLink({ id: link.id, transaction: tx, req: req(t, { auth: { ...t, userId: other.id, permissions: [] } }) }), (e) => e.statusCode === 403 && e.code === 'GOV_LINK_NOT_OWNER');
      const owner = await dlpShareLink({ id: link.id, transaction: tx, req: req(t) });
      assert.deepEqual([owner.impact.counts.accessesSoFar, owner.impact.blockers], [2, []]);
      const admin = await dlpShareLink({ id: link.id, transaction: tx, req: req(t, { auth: { ...t, userId: other.id, permissions: ['governance:dlp:admin'] } }) });
      assert.deepEqual(admin.impact.blockers, []);
    });
  } finally {
    await adminQuery('DELETE FROM governance.share_links WHERE id = $1', [link.id]);
    await adminQuery('DELETE FROM governance.export_jobs WHERE id = $1', [job.id]);
  }
});

test('m9d852 contrato: a simulação do cancelamento (?targetStatus=CANCELLED) não aplica o gate de encerramento e a chamada de outra transição passa direto', { skip }, async () => {
  const { legalContract } = require('../../../src/shared/destructive-actions/providers/legal.contract');
  const env = require('../_helpers/m9d852Env');
  const tenants = await loadTenants();
  const c = await env.insertContract(tenants.A, { openInstallments: 2 });
  await withRollbackTenantTransaction(tenants.A, async (tx) => {
    const terminate = await legalContract({ id: c.id, transaction: tx, preview: true, req: req(tenants.A), query: {}, itemsMax: 10 });
    assert.ok(terminate.impact.blockers.some((b) => b.code === 'OPEN_BILLING'));
    const cancel = await legalContract({ id: c.id, transaction: tx, preview: true, req: req(tenants.A), query: { targetStatus: 'CANCELLED' }, itemsMax: 10 });
    assert.deepEqual(cancel.impact.blockers, [], 'cancelar não passa pelo gate da rescisão');
    assert.equal(cancel.impact.counts.openInstallments, 2);
    const other = await legalContract({ id: c.id, transaction: tx, preview: false, req: req(tenants.A, { body: { targetStatus: 'ACTIVE' }, path: `/legal/contracts/${c.id}/transition` }), query: {}, itemsMax: 10 });
    assert.deepEqual(other, { skip: true });
  });
});

test('m9d852 retry de operação não perigosa e conexão que não vai a DISABLED não pedem confirmação (skip)', { skip }, async () => {
  const { integrationConnection } = require('../../../src/shared/destructive-actions/providers/integration');
  const env = require('../_helpers/m9d852Env');
  const tenants = await loadTenants();
  const conn = await env.insertConnection(tenants.A, 'ACTIVE');
  await withRollbackTenantTransaction(tenants.A, async (tx) => {
    assert.deepEqual(await integrationConnection({ id: conn.id, transaction: tx, preview: false, req: req(tenants.A, { body: { status: 'PAUSED' } }) }), { skip: true });
    const preview = await integrationConnection({ id: conn.id, transaction: tx, preview: true, req: req(tenants.A) });
    assert.equal(preview.code, conn.label);
  });
});
