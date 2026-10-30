'use strict';

// M9-D404 — approved_hash e invalidação da aprovação quando o template (ou o conteúdo) muda depois de aprovar (Caderno §14 e §16).
// Postgres real com a role de runtime. Rodar SOMENTE em banco descartável (veja m9d404.templates.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../src/models');
const { getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const templates = require('../src/features/marketing/content/template.service');
const guard = require('../src/features/marketing/content/approval.guard');
const hashes = require('../src/features/marketing/content/template.hash');
const { q, uid, sha, templateInput, insertContent, insertNextVersion, insertJob } = require('./helpers/m9d404Fixtures');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});

async function publishedTemplate(t, overrides) {
  const created = await templates.createTemplate(tenant, tenant.userId, templateInput(overrides), t);
  return (await templates.publishTemplate(tenant, tenant.userId, created.id, t)).template;
}

test('approved_hash cobre conteúdo e versão do template: mesmo hash enquanto nada muda, outro hash se qualquer parte muda', () => {
  const base = { contentHash: sha('c'), templateId: uid(), templateVersionNo: 1, templateContentHash: sha('t') };
  const h = hashes.computeApprovedHash(base);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(hashes.computeApprovedHash({ ...base }), h);
  for (const change of [
    { contentHash: sha('c2') }, { templateId: uid() }, { templateVersionNo: 2 }, { templateContentHash: sha('t2') },
  ]) {
    assert.notEqual(hashes.computeApprovedHash({ ...base, ...change }), h);
  }
  // Sem template (conteúdo sem molde) também tem hash estável e diferente.
  const bare = hashes.computeApprovedHash({ contentHash: sha('c'), templateId: null, templateVersionNo: null, templateContentHash: null });
  assert.notEqual(bare, h);
});

test('aprovar guarda approved_hash; recalcular dá o mesmo hash enquanto nada mudar (aprovação íntegra)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const tpl = await publishedTemplate(t);
    const content = await insertContent(t, tenant, { templateRow: tpl, itemStatus: 'PENDING_APPROVAL' });
    const recorded = await guard.recordApprovedHash(tenant, tenant.userId, content.versionId, t);
    const expected = hashes.computeApprovedHash({
      contentHash: content.contentHash, templateId: tpl.id, templateVersionNo: tpl.versionNo, templateContentHash: tpl.contentHash,
    });
    assert.equal(recorded.approvedHash, expected);
    const [row] = await q(t, 'SELECT approved_hash FROM marketing.content_versions WHERE id = :id', { id: content.versionId });
    assert.equal(row.approved_hash, expected);
    await q(t, "UPDATE marketing.content_items SET status = 'APPROVED' WHERE id = :id", { id: content.itemId });
    const check = await guard.checkApproval(tenant, tenant.userId, content.itemId, t, { origin: 'SCHEDULE' });
    assert.equal(check.intact, true);
    assert.equal(check.invalidated, false);
  });
});

test('template_muda_apos_approval_invalida_aprovacao: hash diferente volta o item a PENDING_APPROVAL, limpa a aprovação, cancela jobs PENDING e audita', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const tpl = await publishedTemplate(t);
    // Aprovação feita com o template como era (hash antigo) e o template mudou depois (conteúdo do template com outro hash).
    const hashDoTemplateAntigo = hashes.computeApprovedHash({
      contentHash: sha('x'), templateId: tpl.id, templateVersionNo: tpl.versionNo, templateContentHash: sha('molde-antigo'),
    });
    const content = await insertContent(t, tenant, { templateRow: tpl, approvedHash: hashDoTemplateAntigo, contentHash: sha('x') });
    const pending = await insertJob(t, tenant, content.versionId, 'PENDING');
    const running = await insertJob(t, tenant, content.versionId, 'RUNNING', 'FACEBOOK'); // outro canal: só um job ativo por versão e canal (M9-D410)
    const check = await guard.checkApproval(tenant, tenant.userId, content.itemId, t, { origin: 'WORKER' });
    assert.equal(check.intact, false);
    assert.equal(check.invalidated, true);
    assert.equal(check.cancelledJobs, 1);
    const [item] = await q(t, 'SELECT status FROM marketing.content_items WHERE id = :id', { id: content.itemId });
    assert.equal(item.status, 'PENDING_APPROVAL');
    const [ver] = await q(t, 'SELECT approved_by, approved_at, approved_hash FROM marketing.content_versions WHERE id = :id', { id: content.versionId });
    assert.equal(ver.approved_by, null);
    assert.equal(ver.approved_at, null);
    assert.equal(ver.approved_hash, null);
    const jobs = await q(t, 'SELECT id, status, last_error_code FROM marketing.publication_jobs WHERE content_version_id = :v ORDER BY created_at', { v: content.versionId });
    const byId = Object.fromEntries(jobs.map((j) => [j.id, j]));
    assert.equal(byId[pending].status, 'CANCELLED');
    assert.equal(byId[pending].last_error_code, 'APPROVAL_INVALIDATED');
    assert.equal(byId[running].status, 'RUNNING', 'job em execução não é mexido aqui');
    const [log] = await q(t, "SELECT before_json, after_json, reason, user_id FROM audit.audit_log WHERE entity_id = :id AND action = 'marketing.approval.invalidated'", { id: content.itemId });
    assert.ok(log, 'auditoria da invalidação');
    assert.equal(log.before_json.status, 'APPROVED');
    assert.equal(log.after_json.status, 'PENDING_APPROVAL');
    assert.match(log.reason, /APPROVAL_INVALIDATED/);
    // A segunda checagem já não encontra aprovação a invalidar (idempotente).
    const again = await guard.checkApproval(tenant, tenant.userId, content.itemId, t, { origin: 'SCHEDULE' });
    assert.equal(again.invalidated, false);
  });
});

test('trocar a versão do template do conteúdo aprovado (nova content_version sem aprovação) invalida e o erro é 409 MKT_APPROVAL_INVALIDATED', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const input = templateInput();
    const v1 = await templates.createTemplate(tenant, tenant.userId, input, t);
    await templates.publishTemplate(tenant, tenant.userId, v1.id, t);
    const v2 = await templates.createTemplate(tenant, tenant.userId, input, t);
    const pub2 = (await templates.publishTemplate(tenant, tenant.userId, v2.id, t)).template;
    const tpl1 = { id: v1.id, versionNo: 1, contentHash: v1.contentHash };
    const content = await insertContent(t, tenant, {
      templateRow: tpl1,
      approvedHash: hashes.computeApprovedHash({ contentHash: sha('a'), templateId: v1.id, templateVersionNo: 1, templateContentHash: v1.contentHash }),
      contentHash: sha('a'),
    });
    // Enquanto o conteúdo aponta para a v1 (RETIRED para uso novo), a aprovação segue íntegra: histórico preservado.
    assert.equal((await guard.checkApproval(tenant, tenant.userId, content.itemId, t, { origin: 'SCHEDULE' })).intact, true);
    const job = await insertJob(t, tenant, content.versionId, 'PENDING');
    // Usuário troca para a v2: nasce versão 2 do conteúdo, sem aprovação.
    await insertNextVersion(t, tenant, content.itemId, pub2, 2);
    const check = await guard.checkApproval(tenant, tenant.userId, content.itemId, t, { origin: 'SCHEDULE' });
    assert.equal(check.invalidated, true);
    const err = guard.approvalInvalidatedError(check);
    assert.equal(err.statusCode, 409);
    assert.equal(err.code, 'MKT_APPROVAL_INVALIDATED');
    assert.equal(err.message, 'O conteúdo mudou desde a aprovação; aprove novamente.');
    const [j] = await q(t, 'SELECT status FROM marketing.publication_jobs WHERE id = :id', { id: job });
    assert.equal(j.status, 'CANCELLED');
  });
});

test('conteudo_antigo_mantem_versao_do_template: publicar a v2 não muda o template apontado pelo conteúdo já criado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const input = templateInput();
    const v1 = await templates.createTemplate(tenant, tenant.userId, input, t);
    await templates.publishTemplate(tenant, tenant.userId, v1.id, t);
    const content = await insertContent(t, tenant, { templateRow: { id: v1.id, versionNo: 1 }, itemStatus: 'DRAFT' });
    const v2 = await templates.createTemplate(tenant, tenant.userId, { ...input, body: 'Outro {{bairro}}' }, t);
    await templates.publishTemplate(tenant, tenant.userId, v2.id, t);
    const [ver] = await q(t, 'SELECT template_id, template_version_no FROM marketing.content_versions WHERE id = :id', { id: content.versionId });
    assert.equal(ver.template_id, v1.id);
    assert.equal(ver.template_version_no, 1);
    const [old] = await q(t, 'SELECT status, body FROM marketing.templates WHERE id = :id', { id: v1.id });
    assert.equal(old.status, 'RETIRED');
    assert.equal(old.body, input.body, 'o texto da v1 segue o mesmo, o histórico fica preservado');
  });
});

test('checkApproval: item que não está aprovado/agendado não é tocado; item inexistente (outra empresa) devolve 404', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const content = await insertContent(t, tenant, { itemStatus: 'DRAFT' });
    const r = await guard.checkApproval(tenant, tenant.userId, content.itemId, t, { origin: 'SCHEDULE' });
    assert.equal(r.intact, true);
    assert.equal(r.invalidated, false);
    const other = { ...tenant, companyId: uid() };
    await withRollbackTenantTransaction(other, async (t2) => {
      await assert.rejects(() => guard.checkApproval(other, tenant.userId, content.itemId, t2, { origin: 'SCHEDULE' }), (e) => e.statusCode === 404 && e.code === 'MKT_NOT_FOUND');
    });
  });
});
