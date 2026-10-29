'use strict';

// M9-D407 — o POST /marketing/content por HTTP real: texto reprovado pelo validador factual responde 422 com os findings
// (MKT_FACT_MISMATCH, MKT_FACT_MISSING; MKT_INJECTION_SUSPECT é provado no teste do pipeline) e o item fica salvo em FACT_CHECK_FAILED, visível na linha do tempo.
// Só em banco descartável; nenhum endpoint de MFA é chamado nem token forjado.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/aiHttpEnv');

let ctx; let sequelize;
after(async () => {
  if (sequelize) await sequelize.close().catch(() => {});
  if (ctx) setTimeout(() => process.exit(0), 300);
});

async function setup() {
  await env.grant('CI LEITURA', ['marketing:content:read', 'marketing:content:write']);
  ctx = await env.startHttpEnv(process.env.M9D407_HTTP_TEST_PORT || '21707', [['A', 'leitura'], ['B', 'leitura']]);
  ({ sequelize } = require('../../../src/models'));
}

/** Rascunho gravado de verdade (commit) na empresa A do seed de dois tenants, a mesma do login `A:leitura`. */
async function committedDraft(extraFacts) {
  const { withTenantTransaction } = require('../../testHelpers');
  const { draftWithFacts } = require('../_helpers/mktFactualEnv');
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  const row = (await env.admin(
    'SELECT m.group_id, m.company_id, u.id AS user_id FROM core.user_memberships m JOIN core.users u ON u.id = m.user_id WHERE u.email = $1', [emailFor('A', 'leitura')])).rows[0];
  const tenant = { groupId: row.group_id, companyId: row.company_id, userId: row.user_id };
  return withTenantTransaction(tenant, (t) => draftWithFacts(t, tenant, 'Rascunho.', extraFacts));
}

const post = (itemId, texto) => ctx.call('POST', '/marketing/content', ctx.tokens['A:leitura'], { contentItemId: itemId, texto });

test('texto_reprovado_responde_422_com_findings_e_o_item_fica_salvo', { skip: env.SKIP }, async () => {
  await setup();
  const mismatchItem = (await committedDraft()).itemId;
  const mismatch = await post(mismatchItem, 'Casa de 4 quartos por R$ 780 mil.');
  assert.equal(mismatch.status, 422, JSON.stringify(mismatch.body));
  assert.equal(mismatch.body.error.code, 'MKT_FACT_MISMATCH');
  assert.match(mismatch.body.error.message, /diferente do cadastro/);
  const rooms = mismatch.body.error.details.findings.find((f) => f.kind === 'ROOMS');
  assert.deepEqual([rooms.expected, rooms.found, rooms.severity, rooms.claim], [3, 4, 'BLOCK', '4 quartos']);
  assert.equal(mismatch.body.error.details.contentItemId, mismatchItem);

  const timeline = await ctx.call('GET', `/marketing/content/${mismatchItem}`, ctx.tokens['A:leitura']);
  assert.equal(timeline.body.data.status, 'FACT_CHECK_FAILED');
  assert.equal(timeline.body.data.findings[0].kind, 'ROOMS');
  assert.equal(timeline.body.data.checks.factual.ok, false);

  // retomar o mesmo item com o texto corrigido avança (200 = retomada)
  const fixed = await post(mismatchItem, 'Casa de 3 quartos com 120 m² por R$ 780 mil.');
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.body.data.status, 'PENDING_APPROVAL');

  // dado que o cadastro não tem: 422 MKT_FACT_MISSING (o imóvel de teste não tem suítes cadastradas)
  const missingItem = (await committedDraft()).itemId;
  const missing = await post(missingItem, 'Casa de 3 quartos com 2 suítes.');
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error.code, 'MKT_FACT_MISSING');
  assert.ok(missing.body.error.details.findings.every((f) => f.reason === 'MISSING'));
});
