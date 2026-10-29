'use strict';

// M9-D681 — ai.cost_by_agent e ai.budget: reproduzem o número só com as linhas-fonte, ficam DEGRADED/INCOMPLETE com valor nulo quando a regra de qualidade falha, o mês de São Paulo
// decide onde a execução cai (23:30 de 30/09), a projeção do mês e o alerta do orçamento (parâmetro).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d681Env');
const oracle = require('../_helpers/m9d681Oracle');

let env;
before(async () => {
  env = await kit.setup();
  await kit.seedAi(env, env.cX);
  await kit.rebuild(env.cX);
});
after(() => kit.teardown(env));

const run = async (asOf = kit.AS_OF) => { await kit.rebuild(env.cX); return (await kit.kpis(env.cX, asOf)).ia.kpis; };
const dim = async (code, key, asOf) => { const v = await kit.dimension(env.cX, code, key, asOf); return v === null ? null : Number(v); }; // o snapshot guarda 4 casas: compara-se o número

test('m9d681 reproduz ai.cost_by_agent a partir dos registros-fonte', async () => {
  const total = await oracle.cost(env, env.cX, '2026-10');
  const comercial = await oracle.cost(env, env.cX, '2026-10', 'NAY_COMERCIAL');
  assert.deepEqual([total.total, total.runs, comercial.total, comercial.runs], ['655.50', 10, '640.00', 8], 'a conta à mão: 8 x 80,00 + 10,00 + 5,50; a execução que falhou fica de fora');
  const r = (await run())['ai.cost_by_agent'];
  assert.deepEqual([r.status, r.value], ['OK', total.total]);
  assert.deepEqual([r.details.runs, r.details.perRun], ['10', '65.55']);
  assert.equal(await dim('ai.cost_by_agent', 'agente:NAY_COMERCIAL'), 640.00);
  assert.equal(await dim('ai.cost_by_agent', 'agente:NAY_COMERCIAL:execucoes_qtd'), 8);
  assert.equal(await dim('ai.cost_by_agent', 'agente:NAY_COMERCIAL:custo_por_execucao_brl'), 80.00, 'o exemplo do livro: 640,00 em 8 execuções => 80,00 por execução');
  assert.equal(await dim('ai.cost_by_agent', 'agente:NAY_FINANCEIRO'), 15.50);
  assert.equal(await dim('ai.cost_by_agent', 'modelo:m-small'), 640.00);
  assert.equal(await dim('ai.cost_by_agent', 'modelo:m-large'), 15.50);
});

// a execução da NAY é imutável: só o superusuário de teste a apaga (réplica desliga o gatilho)
const drop = (id) => env.admin.transaction(async (transaction) => {
  await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
  await env.admin.query('DELETE FROM ai.ai_runs WHERE id = :id', { replacements: { id }, transaction });
});

test('m9d681 ai.cost_by_agent fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const withModel = await kit.runOf(env, env.cX, 'nay_comercial', '2026-10-28T14:00:00Z', null); // execução com modelo e sem custo gravado
  try {
    const bad = (await run())['ai.cost_by_agent'];
    assert.deepEqual([bad.status, bad.value, bad.details.reason, bad.details.runsWithoutCost], ['DEGRADED', null, 'EXECUCAO_SEM_CUSTO', '1']);
  } finally { await drop(withModel); }
  const byRule = await kit.runOf(env, env.cX, 'nay_comercial', '2026-10-28T14:00:00Z', null, { path: 'RULE' }); // regra não chama modelo: custo zero, não é falha de dado
  try {
    const ok = (await run())['ai.cost_by_agent'];
    assert.deepEqual([ok.status, ok.value, ok.details.runs], ['OK', '655.50', '11']);
  } finally { await drop(byRule); }
  assert.equal((await run())['ai.cost_by_agent'].details.runs, '10');
});

test('m9d681 reproduz ai.budget a partir dos registros-fonte', async () => {
  const cost = (await oracle.cost(env, env.cX, '2026-10')).total;
  const limit = Number(await oracle.budget(env, env.cX, '2026-10', 'NAY_COMERCIAL')) + Number(await oracle.budget(env, env.cX, '2026-10', 'NAY_FINANCEIRO'));
  assert.equal(limit, 920);
  const r = (await run())['ai.budget'];
  assert.deepEqual([r.status, r.value], ['OK', oracle.pct(String(Math.round(Number(cost) * 100)), String(limit * 100))]);
  assert.equal(r.value, '71.25');
  assert.equal(await dim('ai.budget', 'agente:NAY_COMERCIAL'), 71.11, 'o exemplo do livro: 640,00 de 900,00 => 71,11%');
  assert.equal(await dim('ai.budget', 'agente:NAY_FINANCEIRO'), 77.50);
  assert.equal(await dim('ai.budget', 'agente:NAY_COMERCIAL:orcamento_brl'), 900.00);
  assert.equal(await dim('ai.budget', 'agente:NAY_COMERCIAL:projecao_brl'), 708.57, 'dia 28 de 31: 640,00 / 28 x 31');
  assert.equal(await dim('ai.budget', 'acima_do_alerta_qtd'), 0, 'ninguém passou de 80%');
});

test('m9d681 ai.budget: a projeção do livro (dia 20 de 30) e o alerta acima do limite do administrador', async () => {
  const sept = (await run(kit.SEP))['ai.budget'];
  assert.deepEqual([sept.status, sept.value], ['OK', '71.11']);
  assert.equal(await dim('ai.budget', 'agente:NAY_COMERCIAL:projecao_brl', kit.SEP), 960.00, 'o exemplo do livro: dia 20 de 30 => projeção 960,00');
  await kit.setSetting(env, env.cX, 'analytics.ia.alerta_budget_pct', 75);
  try {
    const r = (await run())['ai.budget'];
    assert.deepEqual(r.details.alerts, ['NAY_FINANCEIRO'], '77,50% passa de 75%; 71,11% não');
    assert.equal(await dim('ai.budget', 'acima_do_alerta_qtd'), 1);
    assert.equal(await dim('ai.budget', 'agente:NAY_FINANCEIRO:alerta_qtd'), 1);
  } finally { await kit.setSetting(env, env.cX, 'analytics.ia.alerta_budget_pct', 80); }
});

test('m9d681 ai.budget fica DEGRADED/INCOMPLETE com valor nulo quando a regra de qualidade falha', async () => {
  await env.admin.query("UPDATE ai.budgets SET status = 'PAUSED' WHERE company_id = :c AND agent_code = 'NAY_FINANCEIRO'", { replacements: { c: env.cX.companyId } });
  try {
    const r = (await run())['ai.budget'];
    assert.deepEqual([r.status, r.value, r.details.reason, r.details.agents], ['INCOMPLETE', null, 'AGENTE_SEM_ORCAMENTO', ['NAY_FINANCEIRO']]);
  } finally { await env.admin.query("UPDATE ai.budgets SET status = 'ACTIVE' WHERE company_id = :c AND agent_code = 'NAY_FINANCEIRO'", { replacements: { c: env.cX.companyId } }); }
  assert.equal((await run())['ai.budget'].status, 'OK');
});

test('m9d681 timezone: a execução das 23:30 de São Paulo cai no mês certo', async () => {
  // 2026-10-01T02:30Z é 23:30 de 30/09 em São Paulo: setembro (600,00 + 40,00), nunca outubro
  assert.equal((await oracle.cost(env, env.cX, '2026-09')).total, '640.00');
  const sept = (await run(kit.SEP))['ai.cost_by_agent'];
  assert.equal(sept.value, '640.00', 'setembro inteiro, com a execução das 23:30');
  assert.equal((await run('2026-10-28'))['ai.cost_by_agent'].value, '655.50', 'outubro não a conta');
  assert.equal(await dim('ai.cost_by_agent', 'agente:NAY_COMERCIAL:execucoes_qtd', kit.SEP), 6);
});
