'use strict';

// M9-D632 — os read models de visitas e propostas, carteira de imóveis e preços aplicados pelo worker (M9-D607) e reconstruídos pelo rebuild (M9-D608):
// o incremental por eventos e o rebuild da fonte dão o MESMO resultado, inclusive nas colunas novas do KPI (coorte de propostas, por corretor, por tipo).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../_helpers/m9d632Scenario');
const asserts = require('../_helpers/readModelAsserts');

const { makeEvent, apply, rows } = sc;
let env;
let visitIds;
let proposalIds;
let propertyIds;
const broker = sc.src.uuid();
const MODELS = ['rm_crm_visits_proposals', 'rm_property_portfolio', 'rm_property_price_changes'];

before(async () => {
  env = await sc.setup();
  visitIds = await sc.seedVisits(env, env.cX, broker);
  proposalIds = await sc.seedProposals(env, env.cX, broker);
  propertyIds = Object.values(await sc.seedProperties(env, env.cX, broker));
  await sc.seedPrices(env, env.cX);
});
after(() => sc.teardown(env));

const events = () => [
  makeEvent(env.cX, 'crm.visit.completed', { id: visitIds[0] }),
  makeEvent(env.cX, 'crm.proposal.created', { id: proposalIds[0] }),
  makeEvent(env.cX, 'property.created', { id: propertyIds[0] }),
  ...['2026-09-15', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-28', '2026-10-29']
    .map((day) => makeEvent(env.cX, 'property.price.changed', { offerId: sc.src.uuid() }, { occurredAt: new Date(`${day}T15:00:00Z`) })),
];

for (const model of MODELS) {
  test(`m9d632 ${model}: o rebuild reproduz o incremental`, async () => {
    const ctx = { groupId: env.cX.groupId, actorUserId: env.cX.userId, permissions: ['analytics:rebuild'], reason: 'Teste: tabela apagada e reconstruída da fonte.' };
    const readModels = require('../../../src/features/analytics/read-models');
    await asserts.assertRebuildEqualsIncremental({
      buildIncremental: async () => { for (const event of events()) await apply(env.cX, event); },
      readRows: () => rows(env, model, env.cX),
      wipe: () => env.admin.query(`DELETE FROM analytics.${model} WHERE company_id = :c`, { replacements: { c: env.cX.companyId } }),
      rebuild: async () => { const r = await readModels.rebuildReadModel(ctx, { model, companyId: env.cX.companyId }); assert.equal(r.status, 'SUCCEEDED', model); },
    });
    assert.ok((await rows(env, model, env.cX)).length > 0, `${model}: o rebuild devolveu linhas`);
  });
}

test('m9d632 a proposta decidida em outro dia atualiza a coorte do dia do envio', async () => {
  const id = proposalIds[7]; // enviada, ainda em aberto
  const day15 = async () => (await rows(env, 'rm_crm_visits_proposals', env.cX)).find((r) => String(r.day.toISOString ? r.day.toISOString() : r.day).startsWith('2026-10-15'));
  const before = await day15();
  await sc.src.update(env, 'crm.proposals', id, { status: 'ACCEPTED', decided_at: sc.iso('2026-10-27') });
  await apply(env.cX, makeEvent(env.cX, 'crm.proposal.status_changed', { id, fromStatus: 'SENT', toStatus: 'ACCEPTED' }));
  const after = await day15();
  assert.equal(after.proposals_sent_accepted - before.proposals_sent_accepted, 1, 'a aceita entra na coorte do dia 15 (dia do envio), não do dia 27');
  assert.equal(after.proposals_sent_open - before.proposals_sent_open, -1);
});
