'use strict';

// M9-D834 — versão imprimível: PDF em branco de cada um dos 11 formulários com cabeçalho, folhas numeradas (faixa, ano, limite do parâmetro) e a numeração igual à aceita pela D831.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/bcpEnv');
const { pdfText } = require('../_helpers/exportsEnv');
const { pageCount } = require('../_helpers/bcpPrintHttp');
const { SPEC } = require('../_helpers/m9d834Spec');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const print = require('../../../src/features/core-governance/bcp/formPrint.service');

const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
let A;
const run = (fn) => env.inTx(A, fn);
const sheets = (sector, formType, query = {}, now) => run((transaction) => print.printTemplate({ tenant: env.tenantOf(A), sector, formType, query, transaction, now, actorUserId: A.userId }));

before(async () => { if (env.DISPOSABLE) A = (await env.loadTenants()).A; });
beforeEach(async () => {
  if (!env.DISPOSABLE) return;
  await env.cleanBcp();
  await env.setSectorRoles(A, Object.fromEntries(SPEC.map((s) => [s.sector, ['CI GESTOR']])));
});
after(async () => { if (env.DISPOSABLE) { await env.cleanBcp(); await env.sequelize.close(); } });

test('m9d834 PDF em branco de cada formulário é gerado com cabeçalho e um espaço por campo', { skip: skip() }, async () => {
  for (const spec of SPEC) {
    const file = await sheets(spec.sector, spec.formType);
    assert.equal(file.buffer.slice(0, 5).toString(), '%PDF-', spec.formType);
    assert.equal(pageCount(file.buffer), 1, 'em branco = uma folha');
    const text = pdfText(file.buffer);
    for (const word of ['Número', 'Setor', 'Tipo', 'Data e hora da ocorrência', 'Preenchido por', 'Assinatura']) assert.ok(text.includes(word), `${spec.formType}: cabeçalho "${word}"`);
    assert.ok(text.includes(spec.sector), 'setor impresso');
    const template = (await env.adminQuery('SELECT fields FROM governance.bcp_form_templates WHERE form_type = $1', [spec.formType])).rows[0];
    for (const field of template.fields) assert.ok(text.includes(field.label), `${spec.formType}: campo "${field.label}"`);
    assert.match(file.fileName, /\.pdf$/);
  }
});

test('m9d834 folhas impressas trazem números sequenciais iguais aos aceitos por M9-D831', { skip: skip() }, async () => {
  const file = await sheets('FINANCEIRO', 'RECEBIMENTO', { from: '41', to: '140', year: '2026' });
  assert.equal(pageCount(file.buffer), 100);
  const text = pdfText(file.buffer);
  assert.ok(text.includes('FIN-2026-00041') && text.includes('FIN-2026-00140') && text.includes('FIN-2026-00090'));
  assert.ok(!text.includes('FIN-2026-00040') && !text.includes('FIN-2026-00141'));
  assert.equal(file.firstReference, 'FIN-2026-00041');
  // o número impresso é exatamente o manual_reference que o registro aceita
  const evidenceFileId = await env.evidence(A);
  const op = await env.record(A, { manualReference: 'FIN-2026-00041', evidenceFileId });
  assert.equal(op.manualReference, 'FIN-2026-00041');
  for (const sector of [['OBRAS', 'DIARIO_OBRA', 'OBR'], ['JURIDICO', 'PRAZO_INTIMACAO', 'JUR'], ['ATENDIMENTO', 'REGISTRO_VISITA', 'ATD']]) {
    const t = pdfText((await sheets(sector[0], sector[1], { from: '7', to: '8', year: '2026' })).buffer);
    assert.ok(t.includes(`${sector[2]}-2026-00007`) && t.includes(`${sector[2]}-2026-00008`), sector[0]);
  }
});

test('m9d834 o ano é o corrente em America/Sao_Paulo quando não informado', { skip: skip() }, async () => {
  // 2027-01-01 01:00 UTC ainda é 31/12/2026 em Brasília
  const text = pdfText((await sheets('FINANCEIRO', 'RECEBIMENTO', { from: '1', to: '1' }, new Date('2027-01-01T01:00:00Z'))).buffer);
  assert.ok(text.includes('FIN-2026-00001'), 'ainda 2026 em Brasília');
  const next = pdfText((await sheets('FINANCEIRO', 'RECEBIMENTO', { from: '1', to: '1' }, new Date('2027-01-01T04:00:00Z'))).buffer);
  assert.ok(next.includes('FIN-2027-00001'), '2027 a partir da meia-noite de Brasília');
});

test('m9d834 faixa de folhas inválida devolve 400 GOV_BCP_RANGE_INVALID', { skip: skip() }, async () => {
  const bad = [{ from: '10', to: '9' }, { from: '1', to: '501' }, { from: '0', to: '5' }, { from: 'a', to: '5' }, { from: '1' }, { to: '5' }, { from: '99999', to: '100000' }, { from: '1', to: '2', year: '26' }, { from: '1.5', to: '3' }];
  for (const query of bad) {
    const err = await env.failure(sheets('FINANCEIRO', 'RECEBIMENTO', query));
    assert.deepEqual([err && err.status, err && err.code, err && err.message], [400, 'GOV_BCP_RANGE_INVALID', 'A faixa de folhas é inválida (máximo de 500).'], JSON.stringify(query));
  }
  assert.equal(pageCount((await sheets('FINANCEIRO', 'RECEBIMENTO', { from: '1', to: '500' })).buffer), 500, '500 folhas é o limite aceito');
});

test('m9d834 o máximo de folhas vem do parâmetro governanca.bcp.impressao_max_folhas', { skip: skip() }, async () => {
  await run((tx) => upsertSetting('governanca.bcp.impressao_max_folhas', 3, env.tenantOf(A), A.userId, tx));
  assert.equal(pageCount((await sheets('FINANCEIRO', 'RECEBIMENTO', { from: '1', to: '3' })).buffer), 3);
  const err = await env.failure(sheets('FINANCEIRO', 'RECEBIMENTO', { from: '1', to: '4' }));
  assert.equal(err.code, 'GOV_BCP_RANGE_INVALID');
  assert.match(err.message, /máximo de 3/);
});

test('m9d834 tipo de formulário inexistente para o setor devolve 404 GOV_BCP_FORM_NOT_FOUND', { skip: skip() }, async () => {
  for (const [sector, formType] of [['FINANCEIRO', 'DIARIO_OBRA'], ['FINANCEIRO', 'NAO_EXISTE'], ['SETOR_FALSO', 'RECEBIMENTO']]) {
    const err = await env.failure(sheets(sector, formType));
    assert.deepEqual([err.status, err.code, err.message], [404, 'GOV_BCP_FORM_NOT_FOUND', 'Formulário não encontrado para este setor.'], `${sector}/${formType}`);
  }
});
