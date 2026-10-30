'use strict';

// M9-D436 adv_05 (Caderno §16: "Template muda após approval -> invalida"). Conteúdo aprovado com o template v1; o template passa para a v2 e o conteúdo passa a apontar para ela, sem nova
// aprovação. (a) Tentar agendar dá 409 MKT_APPROVAL_INVALIDATED e o conteúdo volta a PENDING_APPROVAL. (b) O job que já estava agendado é cancelado e nada é publicado. Cenário da dona
// (M9-D404), sem lógica própria. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const env = require('../../_helpers/mktWorker');
const { adapters } = require('../../../../src/features/marketing/publications');
const templates = require('../../../../src/features/marketing/content/template.service');
const { templateInput, insertNextVersion } = require('../../../helpers/m9d404Fixtures');

let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(() => { env.reset(); env.resetSandbox(); });

/** Publica a v2 do template do conteúdo e faz o conteúdo apontar para ela numa nova versão (a versão aprovada é imutável), sem nova aprovação. */
async function trocarParaV2(t, itemId, templateId) {
  const [tpl] = await env.fx.q(t, 'SELECT code FROM marketing.templates WHERE id = :id', { id: templateId });
  const v2 = await templates.createTemplate(ctx.tenant, ctx.tenant.userId, templateInput({ code: tpl.code }), t);
  const pub2 = (await templates.publishTemplate(ctx.tenant, ctx.tenant.userId, v2.id, t)).template;
  assert.equal(pub2.versionNo, 2);
  const [{ n }] = await env.fx.q(t, 'SELECT COALESCE(max(version_no), 0)::int AS n FROM marketing.content_versions WHERE content_item_id = :i', { i: itemId });
  const [{ checks_json: checks }] = await env.fx.q(t, 'SELECT checks_json FROM marketing.content_versions WHERE content_item_id = :i AND version_no = :n', { i: itemId, n });
  const novaId = await insertNextVersion(t, ctx.tenant, itemId, pub2, n + 1);
  // a nova versão herda os passos já concluídos, mas não o approved_hash (a aprovação humana é da v1): é o que a invalidação detecta
  await env.fx.q(t, 'UPDATE marketing.content_versions SET checks_json = :c::jsonb WHERE id = :id RETURNING id', { c: JSON.stringify(checks), id: novaId });
}

test('adv_05_template_muda_apos_approval_invalida: tentar agendar recusa, volta a PENDING_APPROVAL e cancela os jobs', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['SITE']);
    assert.equal((await env.job(t, s.jobId)).status, 'PENDING');
    await trocarParaV2(t, s.itemId, s.templateId);
    const out = await env.schedule(t, ctx, s.itemId, { channels: ['SITE'], when: s.when.toISOString() });
    // o serviço devolve o 409 pronto para o chamador lançar depois do commit
    assert.equal(out.error.statusCode, 409);
    assert.equal(out.error.code, 'MKT_APPROVAL_INVALIDATED');
    // (1) o efeito proibido não ocorreu: o job antigo foi cancelado, nenhum novo nasceu e nada foi publicado
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'CANCELLED');
    assert.equal(job.last_error_code, 'APPROVAL_INVALIDATED');
    const jobs = await env.fx.q(t, 'SELECT j.id FROM marketing.publication_jobs j JOIN marketing.content_versions v ON v.id = j.content_version_id WHERE v.content_item_id = :i AND j.status <> \'CANCELLED\'', { i: s.itemId });
    assert.equal(jobs.length, 0);
    assert.equal(adapters.sandboxRecordCount(ctx.tenant.companyId, 'SITE'), 0);
    // (2) o motivo foi registrado: o conteúdo voltou a PENDING_APPROVAL e a invalidação está na auditoria
    assert.equal(await env.itemStatus(t, s.itemId), 'PENDING_APPROVAL');
    const audit = await env.fx.q(t, "SELECT reason FROM audit.audit_log WHERE company_id = :c AND entity_id = :i AND action = 'marketing.approval.invalidated'", { c: ctx.tenant.companyId, i: String(s.itemId) });
    assert.equal(audit.length, 1);
    assert.match(audit[0].reason, /APPROVAL_INVALIDATED/);
    // isolamento (RLS): a outra empresa não enxerga o que este cenário gravou
    await require('../../_helpers/mktAdv').assertIsolated(t, ctx.tenant, [{ tabela: 'marketing.publication_jobs', ids: [s.jobId] }, { tabela: 'marketing.content_items', ids: [s.itemId] }]);
  });
});

test('adv_05_template_muda_apos_approval_invalida: o job já agendado é cancelado e nada é publicado', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['SITE']);
    assert.equal((await env.job(t, s.jobId)).status, 'PENDING');
    await trocarParaV2(t, s.itemId, s.templateId);
    await env.cycle(t, ctx, { now: s.now });
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'CANCELLED', 'job cancelado');
    assert.equal(job.last_error_code, 'MKT_APPROVAL_INVALIDATED', 'com o motivo registrado');
    assert.equal(job.attempts, 0);
    assert.equal(adapters.sandboxRecordCount(ctx.tenant.companyId, 'SITE'), 0, 'nada foi publicado');
  });
});
