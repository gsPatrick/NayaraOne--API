'use strict';

// M9-D426 — mídia do Marketing: autorização, original preservado com hash, derivado rastreável, idempotência da montagem e isolamento entre empresas.
// Banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d426.midia.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const env = require('../_helpers/mktMidia');

let ctx;
let tenantB;
before(async () => { ctx = await env.setup(); ({ tenantB } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

test('midia_original_e_preservada_com_hash', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const a = await env.authorizedFile(t, ctx.tenant, { mime: 'image/jpeg', name: 'sala.jpg' });
    const b = await env.authorizedFile(t, ctx.tenant, { mime: 'image/jpeg', name: 'cozinha.jpg' });
    const beforeA = await env.fileRow(t, a.id);
    const { derivative, replay } = await env.assemble(t, ctx.tenant, { midias: [a.id, b.id], operacoes: [{ op: 'ORDER', order: [b.id, a.id] }, { op: 'CAPTION', text: 'Sala e cozinha' }] });
    assert.equal(replay, false);
    assert.notEqual(derivative.derived_file_id, a.id, 'o derivado é um arquivo NOVO');
    assert.notEqual(derivative.derived_sha256, a.sha256, 'hashes distintos entre original e derivado');
    assert.deepEqual(derivative.derived_from.map((s) => s.fileId), [a.id, b.id]);
    assert.deepEqual(derivative.derived_from.map((s) => s.sha256), [a.sha256, b.sha256], 'derived_from guarda o hash de cada original');
    assert.deepEqual(derivative.transform_log.operations.map((o) => o.op), ['ORDER', 'CAPTION']);
    const afterA = await env.fileRow(t, a.id);
    assert.deepEqual(afterA, beforeA, 'o original nunca é alterado nem sobrescrito');
    const derived = await env.fileRow(t, derivative.derived_file_id);
    assert.equal(derived.checksum_sha256, derivative.derived_sha256, 'o hash do derivado é o do arquivo gravado');
    assert.equal(derived.mime_type, 'video/mp4');
    const audit = await env.fx.q(t, "SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'marketing.media.assemble' AND entity_id = :id", { id: derivative.id });
    assert.equal(audit[0].n, 1, 'a montagem fica na auditoria');
  });
});

test('montagem_repetida_com_as_mesmas_entradas_devolve_o_derivado_existente', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const a = await env.authorizedFile(t, ctx.tenant, { mime: 'image/png', name: 'a.png' });
    const spec = { midias: [a.id], operacoes: [{ op: 'CAPTION', text: 'Fachada' }] };
    const first = await env.assemble(t, ctx.tenant, spec);
    const again = await env.assemble(t, ctx.tenant, spec);
    assert.equal(again.replay, true);
    assert.equal(again.derivative.id, first.derivative.id);
    assert.equal(await env.count(t, 'marketing.media_derivatives', 'inputs_hash = :h', { h: first.derivative.inputs_hash }), 1);
    const other = await env.assemble(t, ctx.tenant, { midias: [a.id], operacoes: [{ op: 'CAPTION', text: 'Outra legenda' }] });
    assert.notEqual(other.derivative.id, first.derivative.id, 'entrada diferente, derivado diferente');
  });
});

test('midia_sem_autorizacao_recusa', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const loose = await env.makeFile(t, ctx.tenant);
    await env.rejectsCode(env.assemble(t, ctx.tenant, { midias: [loose.id] }), 422, 'MKT_MEDIA_NOT_AUTHORIZED');
    await env.rejectsCode(env.createReel(t, ctx, { midiaId: loose.id }), 422, 'MKT_MEDIA_NOT_AUTHORIZED');
    await env.rejectsCode(env.createReel(t, ctx, { midiaId: 'midia-que-nao-existe' }), 422, 'MKT_MEDIA_NOT_AUTHORIZED');
    assert.equal(await env.count(t, 'marketing.content_items', "title = 'QA-M9 reel'"), 0, 'nada foi gravado pelas recusas');
    assert.equal(await env.count(t, 'marketing.media_derivatives'), 0);
  });
});

test('autorizacao_exige_arquivo_limpo_imagem_ou_video_e_origem_do_parametro', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const infected = await env.makeFile(t, ctx.tenant, { scan: 'INFECTED' });
    await env.rejectsCode(env.authorize(t, ctx.tenant, infected.id), 422, 'MKT_MEDIA_NOT_AUTHORIZED');
    const pdf = await env.makeFile(t, ctx.tenant, { mime: 'application/pdf', name: 'a.pdf' });
    await env.rejectsCode(env.authorize(t, ctx.tenant, pdf.id), 400, 'MKT_VALIDATION');
    const ok = await env.makeFile(t, ctx.tenant);
    await env.rejectsCode(env.authorize(t, ctx.tenant, ok.id, 'INVENTADA'), 422, 'MKT_VALIDATION');
    await env.setParam(t, ctx.tenant, 'marketing.video.origens_midia', 'EQUIPE,PARCEIRO');
    const row = await env.authorize(t, ctx.tenant, ok.id, 'parceiro');
    assert.equal(row.origin, 'PARCEIRO', 'a lista de origens é o parâmetro');
    assert.equal(row.sha256, ok.sha256);
    assert.equal(row.authorizedBy, ctx.tenant.userId);
    assert.ok(row.authorizedAt, 'com a data');
    await env.rejectsCode(env.authorize(t, ctx.tenant, ok.id, 'OBRA'), 422, 'MKT_VALIDATION');
  });
});

test('revogar_a_autorizacao_recusa_o_uso_e_reautorizar_reabre', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const f = await env.authorizedFile(t, ctx.tenant);
    await env.assemble(t, ctx.tenant, { midias: [f.id] });
    const revoked = await env.video.revokeMedia({ tenant: ctx.tenant, actor: ctx.tenant.userId, fileId: f.id }, t);
    assert.ok(revoked.revokedAt);
    await env.rejectsCode(env.assemble(t, ctx.tenant, { midias: [f.id] }), 422, 'MKT_MEDIA_NOT_AUTHORIZED');
    await env.authorize(t, ctx.tenant, f.id);
    assert.equal((await env.assemble(t, ctx.tenant, { midias: [f.id] })).replay, true);
  });
});

test('autorizacao_e_derivado_de_uma_empresa_nao_valem_na_outra', async () => {
  const outsider = { ...tenantB, userId: ctx.tenant.userId };
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const f = await env.authorizedFile(t, ctx.tenant);
    const { derivative } = await env.assemble(t, ctx.tenant, { midias: [f.id] });
    assert.equal(await env.count(t, 'marketing.media_authorizations', 'file_id = :id', { id: f.id }), 1);
    assert.equal(derivative.synthetic, false);
  });
  await env.withRollbackTenantTransaction(outsider, async (t) => {
    assert.equal(await env.count(t, 'marketing.media_authorizations'), 0, 'RLS: a outra empresa não enxerga as autorizações');
    assert.equal(await env.count(t, 'marketing.media_derivatives'), 0);
  });
});
