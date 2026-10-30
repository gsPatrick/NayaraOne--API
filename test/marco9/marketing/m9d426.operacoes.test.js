'use strict';

// M9-D426 — operações da montagem: allowlist (corte, ordenação, legenda, trilha licenciada) e bloqueio de toda alteração material do imóvel.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktMidia');

let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });

const FORBIDDEN = ['SKY_REPLACE', 'REMOVE_ELEMENT', 'ADD_ELEMENT', 'COLOR_CHANGE', 'FACADE_RECOLOR', 'ENHANCE_STATE', 'GENERATIVE_FILL'];

test('operacao_generativa_sobre_imovel_e_bloqueada', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const f = await env.authorizedFile(t, ctx.tenant, { mime: 'image/jpeg', name: 'fachada.jpg' });
    for (const op of FORBIDDEN) {
      await assert.rejects(env.assemble(t, ctx.tenant, { midias: [f.id], operacoes: [{ op, mediaId: f.id }] }),
        (e) => e.statusCode === 422 && e.code === 'MKT_MEDIA_MATERIAL_ALTERATION' && e.details.operation === op && e.details.reason === 'FORBIDDEN_OPERATION' && /mudaria o imóvel/.test(e.message), op);
    }
    assert.equal(await env.count(t, 'marketing.media_derivatives'), 0, 'nenhum derivado nasce de operação proibida');
    assert.equal(await env.count(t, 'people.files', "file_name LIKE 'reel-%'"), 0, 'nem arquivo novo');
  });
});

test('operacao_desconhecida_ou_plugin_generativo_fora_da_allowlist_e_recusada', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const f = await env.authorizedFile(t, ctx.tenant);
    await assert.rejects(env.assemble(t, ctx.tenant, { midias: [f.id], operacoes: [{ op: 'NEURAL_UPSCALE' }] }),
      (e) => e.code === 'MKT_MEDIA_MATERIAL_ALTERATION' && e.details.reason === 'NOT_ALLOWLISTED' && e.details.allowed.includes('CUT'));
    // a lista é a do livro: nenhuma operação pode ser acrescentada em tempo de execução
    assert.deepEqual([...env.video.ALLOWED_OPERATIONS], ['CUT', 'ORDER', 'CAPTION', 'LICENSED_TRACK']);
    assert.throws(() => { env.video.ALLOWED_OPERATIONS.push('SKY_REPLACE'); }, TypeError);
    // uma operação proibida junto de operações boas derruba a montagem inteira
    await assert.rejects(env.assemble(t, ctx.tenant, { midias: [f.id], operacoes: [{ op: 'CAPTION', text: 'ok' }, { op: 'SKY_REPLACE' }] }), (e) => e.code === 'MKT_MEDIA_MATERIAL_ALTERATION');
  });
});

test('operacoes_permitidas_ficam_no_transform_log', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const a = await env.authorizedFile(t, ctx.tenant);
    const b = await env.authorizedFile(t, ctx.tenant);
    const { derivative } = await env.assemble(t, ctx.tenant, {
      midias: [a.id, b.id],
      operacoes: [
        { op: 'CUT', mediaId: a.id, startS: 2, endS: 12 }, { op: 'CUT', mediaId: b.id, startS: 0, endS: 20 }, { op: 'ORDER', order: [b.id, a.id] },
        { op: 'CAPTION', text: 'Sala ampla', atS: 3 }, { op: 'LICENSED_TRACK', trackRef: 'faixa-001', licenseRef: 'LIC-2026-77' },
      ],
    });
    assert.deepEqual(derivative.transform_log.operations.map((o) => o.op), ['CUT', 'CUT', 'ORDER', 'CAPTION', 'LICENSED_TRACK']);
    assert.equal(derivative.duration_s, 30, 'duração pelos cortes (10 + 20 s)');
    assert.equal(derivative.aspect_ratio, '9:16');
    assert.equal(derivative.format, 'REEL');
    assert.equal(derivative.synthetic, false);
  });
});

test('operacao_mal_formada_e_operacao_sobre_midia_fora_da_montagem_sao_400', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const a = await env.authorizedFile(t, ctx.tenant);
    const b = await env.authorizedFile(t, ctx.tenant);
    const bad = (operacoes) => env.rejectsCode(env.assemble(t, ctx.tenant, { midias: [a.id], operacoes }), 400, 'MKT_VALIDATION');
    await bad([{ op: 'CUT', mediaId: a.id, startS: 5, endS: 5 }]);
    await bad([{ op: 'CAPTION' }]);
    await bad([{ op: 'LICENSED_TRACK', trackRef: 'x' }]); // trilha sem licença
    await bad([{ op: 'CUT', mediaId: b.id, startS: 0, endS: 3 }]); // mídia que não está na montagem
    await env.rejectsCode(env.assemble(t, ctx.tenant, { midias: [a.id], extra: 1 }), 400, 'MKT_VALIDATION');
    await env.rejectsCode(env.assemble(t, ctx.tenant, { midias: [] }), 400, 'MKT_VALIDATION');
    await env.rejectsCode(env.assemble(t, ctx.tenant, { midias: [a.id], formato: 'LIVE' }), 400, 'MKT_VALIDATION');
    await env.setParam(t, ctx.tenant, 'marketing.video.max_midias', 1);
    await env.rejectsCode(env.assemble(t, ctx.tenant, { midias: [a.id, b.id] }), 400, 'MKT_VALIDATION');
  });
});
