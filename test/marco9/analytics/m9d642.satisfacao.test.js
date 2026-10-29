'use strict';

// M9-D642 — rent.satisfaction: o número refeito do zero só com os registros de atendimento e as partes dos contratos de locação (total, inquilino e proprietário), a amostra mínima
// do administrador, a nota de cada tipo vinda do parâmetro e o fuso de São Paulo na virada do mês.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d642Env');
const sc = require('../_helpers/m9d642Scenario');
const oracle = require('../_helpers/m9d642Oracle');

let env;
before(async () => {
  env = await kit.setup();
  await kit.setSetting(env, env.cX, 'analytics.qualidade.min_amostra', 3);
  await sc.satisfacao(env, env.cX);
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

test('m9d642 reproduz rent.satisfaction a partir dos registros-fonte', async () => {
  const want = await oracle.satisfactionFromSource(env, env.cX, kit.AS_OF);
  assert.deepEqual([want.all.responses, want.all.sum, want.average, want.tenant.responses, want.tenantAverage, want.owner.responses, want.ownerAverage], [7, 27, 3.86, 4, 4, 3, 4.33]);
  const kpi = await kit.readKpi(env.cX, 'rent.satisfaction');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'SCORE', 1, 'rent.satisfaction']);
  assert.equal(Number(kpi.value), want.average);
  const dim = async (key) => Number(await kit.dimension(env.cX, 'rent.satisfaction', key));
  assert.equal(await dim('respostas_qtd'), want.all.responses);
  assert.deepEqual([await dim('papel:INQUILINO'), await dim('papel:INQUILINO:respostas_qtd')], [want.tenantAverage, want.tenant.responses]);
  assert.deepEqual([await dim('papel:PROPRIETARIO'), await dim('papel:PROPRIETARIO:respostas_qtd')], [want.ownerAverage, want.owner.responses]);
  assert.equal(kpi.sourceRefs[0].table, 'crm.feedback_cases');
});

test('m9d642 rent.satisfaction fica INCOMPLETE com valor nulo quando a amostra é insuficiente (exemplo: notas 5,4,4,5 dão 4,50 com 4 respostas e mínimo 5)', async () => {
  const t = env.cY;
  await kit.setSetting(env, t, 'analytics.locacao.nota_conflito', 4);
  await sc.satisfacaoQuatroRespostas(env, t);
  const want = await oracle.satisfactionFromSource(env, t, kit.AS_OF, { COMPLIMENT: 5, COMPLAINT: 1, CONFLICT: 4 });
  assert.deepEqual([want.all.responses, want.average], [4, 4.5]);
  await kit.rebuild(t);
  const result = (await kit.kpis(t)).rent.kpis['rent.satisfaction'];
  assert.deepEqual([result.status, result.value, result.details.reason, result.details.responses, result.details.minSample], ['INCOMPLETE', null, 'AMOSTRA_INSUFICIENTE', '4', '5']);
  assert.equal((await kit.readKpi(t, 'rent.satisfaction')).value, null, 'nunca um número enganoso');
  await kit.setSetting(env, t, 'analytics.qualidade.min_amostra', 4);
  await kit.rebuild(t);
  const ok = (await kit.kpis(t)).rent.kpis['rent.satisfaction'];
  assert.deepEqual([ok.status, ok.value, ok.details.responses], ['OK', '4.50', '4'], 'com mínimo 4 o mesmo mês passa e a nota de cada tipo vem do parâmetro');
});

test('m9d642 timezone: registro das 23:30 de São Paulo cai no mês certo e quem é parte nos dois papéis conta uma vez no total', async () => {
  const want = await oracle.satisfactionFromSource(env, env.cX, kit.AS_OF);
  assert.equal(want.all.responses, 7, 'o registro de 23:30 de 30/09 em SP fica em setembro e o de 00:30 de 01/10 entra em outubro');
  const result = (await kit.kpis(env.cX)).rent.kpis['rent.satisfaction'];
  assert.equal(result.details.responses, '7');
  assert.equal(result.details.roles.INQUILINO.responses + result.details.roles.PROPRIETARIO.responses > result.details.responses - 1, true, 'quem é inquilino e proprietário aparece nos dois subtotais');
  assert.deepEqual([result.details.roles.INQUILINO.responses, result.details.roles.PROPRIETARIO.responses], ['4', '3']);
});
