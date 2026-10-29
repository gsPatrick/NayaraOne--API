'use strict';

// M9-D641 — rent.inspections_keys: o número refeito do zero só com as vistorias e chaves da fonte (pendentes e atrasadas; chaves fora e atrasadas), o fuso de São Paulo
// e a regra de qualidade (chave sem data prevista).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d641Env');
const sc = require('../_helpers/m9d641Scenario');
const oracle = require('../_helpers/m9d641Oracle');

let env;
before(async () => {
  env = await kit.setup();
  await sc.vistoriasChaves(env, env.cX);
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

test('m9d641 reproduz rent.inspections_keys a partir dos registros-fonte', async () => {
  const want = await oracle.inspectionsKeysFromSource(env, env.cX, kit.AS_OF);
  assert.deepEqual(want, { pending: 5, overdue: 2, keysOut: 4, keysOverdue: 2, keysWithoutDate: 0 }, 'a vistoria de hoje e a das 23:30 de hoje em SP não estão atrasadas; a das 23:30 de 26/10 em SP está');
  const kpi = await kit.readKpi(env.cX, 'rent.inspections_keys');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'COUNT', 1, 'rent.inspections_keys']);
  assert.equal(Number(kpi.value), want.pending);
  const dim = async (key) => Number(await kit.dimension(env.cX, 'rent.inspections_keys', key));
  assert.deepEqual([await dim('vistorias_atrasadas_qtd'), await dim('chaves_fora_qtd'), await dim('chaves_atrasadas_qtd')], [want.overdue, want.keysOut, want.keysOverdue]);
  assert.equal(kpi.sourceRefs[0].table, 'legal.inspections');
  assert.equal(kpi.sourceRefs[0].count, want.pending, 'o filtro da origem reproduz o mesmo número');
});

test('m9d641 rent.inspections_keys fica DEGRADED com valor nulo quando a regra de qualidade falha (chave sem data prevista)', async () => {
  const t = env.cY;
  const dated = await sc.contract(env, t, { ends_at: sc.iso('12-31') });
  await sc.key(env, t, dated, 'RELEASED');
  await kit.rebuild(t);
  assert.equal((await kit.kpis(t)).rent.kpis['rent.inspections_keys'].status, 'OK');
  await sc.key(env, t, await sc.contract(env, t, { ends_at: null }), 'RELEASED'); // contrato sem fim de vigência: a chave não tem devolução prevista
  await kit.rebuild(t);
  const result = (await kit.kpis(t)).rent.kpis['rent.inspections_keys'];
  assert.deepEqual([result.status, result.value, result.details.reason, result.details.keysWithoutReturnDate], ['DEGRADED', null, 'CHAVE_SEM_DATA_PREVISTA', '1']);
  assert.equal((await kit.readKpi(t, 'rent.inspections_keys')).value, null, 'nunca um número enganoso');
});

test('m9d641 timezone: vistoria e devolução às 23:30 de São Paulo caem no dia certo', async () => {
  const t = env.cX;
  const before = await oracle.inspectionsKeysFromSource(env, t, kit.AS_OF);
  const c = await sc.contract(env, t, { ends_at: sc.iso('12-31') });
  await sc.inspection(env, t, c, 'SCHEDULED', sc.iso('10-28', 2, 30)); // 27/10 23:30 em SP: atrasada
  await sc.inspection(env, t, c, 'SCHEDULED', sc.iso('10-29', 2, 30)); // 28/10 23:30 em SP: hoje
  await sc.key(env, t, await sc.contract(env, t, { ends_at: sc.iso('10-28', 2, 30) }), 'RELEASED'); // devolução prevista 27/10 23:30 em SP: atrasada
  await kit.rebuild(t);
  const result = (await kit.kpis(t)).rent.kpis['rent.inspections_keys'];
  const want = await oracle.inspectionsKeysFromSource(env, t, kit.AS_OF);
  assert.deepEqual(want, { pending: before.pending + 2, overdue: before.overdue + 1, keysOut: before.keysOut + 1, keysOverdue: before.keysOverdue + 1, keysWithoutDate: 0 });
  assert.deepEqual([result.status, result.value, result.details.inspectionsOverdue, result.details.keysOverdue], ['OK', String(want.pending), String(want.overdue), String(want.keysOverdue)]);
});
