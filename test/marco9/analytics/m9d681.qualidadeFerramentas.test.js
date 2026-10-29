'use strict';

// M9-D681 — ai.quality_scores e ai.tool_calls_blocked: reproduzem o número só com as linhas-fonte, ficam DEGRADED/INCOMPLETE com valor nulo quando a regra de qualidade falha, o dia de
// São Paulo decide onde a chamada cai e o bloqueio é só o estado BLOCKED (STALE conta; PROPOSED e CANCELLED_BY_HUMAN não).
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

test('m9d681 reproduz ai.quality_scores a partir dos registros-fonte', async () => {
  const want = await oracle.grounding(env, env.cX, '2026-10-26');
  assert.deepEqual([want.applicable, want.grounded, want.value, want.blocked], [10, 8, '80.00', 2], 'a conta à mão: 8 de 10 execuções com fundamentação aplicável');
  const r = (await run())['ai.quality_scores'];
  assert.deepEqual([r.status, r.value], ['OK', want.value]);
  assert.deepEqual([r.details.week, r.details.runs, r.details.blockedByGrounding], ['2026-10-26', '10', '2']);
  assert.equal(await dim('ai.quality_scores', 'agente:NAY_COMERCIAL'), 75.00, '6 de 8');
  assert.equal(await dim('ai.quality_scores', 'agente:NAY_COMERCIAL:bloqueadas_grounding_qtd'), 2, 'respostas bloqueadas por grounding contadas à parte');
  assert.equal(await dim('ai.quality_scores', 'avaliacao_nota'), 58.3, 'média das notas 1; 0,5; 0,25 na escala de 0 a 100, 1 casa');
  assert.equal(await dim('ai.quality_scores', 'agente:NAY_COMERCIAL:avaliacao_nota'), 58.3);
  assert.equal(await dim('ai.quality_scores', 'agente:NAY_FINANCEIRO'), null, 'amostra de 2 execuções, abaixo do mínimo do agente');
  assert.deepEqual(r.details.insufficientAgents, ['NAY_FINANCEIRO']);
});

test('m9d681 ai.quality_scores: o histórico por semana é parâmetro e a semana de setembro bate com a fonte', async () => {
  await kit.setSetting(env, env.cX, 'analytics.ia.qualidade_semanas', 5);
  try {
    await run();
    const sep = await oracle.grounding(env, env.cX, '2026-09-28');
    assert.equal(sep.value, '83.33', '5 de 6: cinco fundamentadas em 29/09 e a das 23:30 de 30/09 sem fonte suficiente');
    assert.equal(await dim('ai.quality_scores', 'semana:2026-09-28'), Number(sep.value));
    assert.equal(await dim('ai.quality_scores', 'semana:2026-10-26'), 80.00);
  } finally { await kit.setSetting(env, env.cX, 'analytics.ia.qualidade_semanas', 4); }
  await run();
  // o quadro de quatro semanas não traz a de 28/09: a linha dela não é refeita e o último valor gravado fica no histórico do snapshot, mas o resumo do cálculo não a lista
  const again = (await kit.kpis(env.cX)).ia.kpis['ai.quality_scores'];
  assert.equal(again.dimensions.some((d) => d.key === 'semana:2026-09-28'), false, 'com quatro semanas a de 28/09 sai do quadro');
});

test('m9d681 ai.quality_scores fica DEGRADED/INCOMPLETE com valor nulo quando a regra de qualidade falha', async () => {
  await kit.setSetting(env, env.cX, 'analytics.qualidade.min_amostra', 50);
  try {
    const r = (await run())['ai.quality_scores'];
    assert.deepEqual([r.status, r.value, r.details.reason, r.details.runs, r.details.minSample], ['INCOMPLETE', null, 'AMOSTRA_INSUFICIENTE', '10', '50']);
  } finally { await kit.setSetting(env, env.cX, 'analytics.qualidade.min_amostra', 5); }
  assert.equal((await run())['ai.quality_scores'].status, 'OK');
});

test('m9d681 reproduz ai.tool_calls_blocked a partir dos registros-fonte', async () => {
  const want = await oracle.toolCalls(env, env.cX, '2026-10', kit.AS_OF);
  assert.deepEqual([want.calls, want.blocked, want.value, want.reasons], [13, 3, '23.08', { ALLOWLIST: 1, PERMISSION: 1, STALE: 1 }]);
  const r = (await run())['ai.tool_calls_blocked'];
  assert.deepEqual([r.status, r.value], ['OK', String(want.blocked)]);
  assert.deepEqual([r.details.calls, r.details.blockedPct], ['13', '23.08']);
  assert.equal(await dim('ai.tool_calls_blocked', 'bloqueadas_pct'), 23.08);
  assert.equal(await dim('ai.tool_calls_blocked', 'agente:NAY_COMERCIAL'), 3);
  assert.equal(await dim('ai.tool_calls_blocked', 'ferramenta:crm.list:bloqueadas_pct'), 12.50);
  assert.equal(await dim('ai.tool_calls_blocked', 'ferramenta:finance.get'), 2);
  assert.equal(await dim('ai.tool_calls_blocked', 'ferramenta:finance.get:chamadas_qtd'), 5);
  for (const [reason, n] of Object.entries(want.reasons)) assert.equal(await dim('ai.tool_calls_blocked', `motivo:${reason}`), n, reason);
});

test('m9d681 ai.tool_calls_blocked fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  await run();
  await env.admin.query("UPDATE analytics.rm_ai_tool_calls SET by_reason = by_reason || '{\"NO_REASON\": 1}'::jsonb WHERE company_id = :c AND day = '2026-10-26'", { replacements: { c: env.cX.companyId } });
  const bad = (await kit.kpis(env.cX)).ia.kpis['ai.tool_calls_blocked'];
  assert.deepEqual([bad.status, bad.value, bad.details.reason], ['DEGRADED', null, 'BLOQUEIO_SEM_MOTIVO']);
  assert.equal((await run())['ai.tool_calls_blocked'].status, 'OK', 'recalculado da fonte, o motivo volta');
});

test('m9d681 stale conta como bloqueio e rejeicao humana nao conta', async () => {
  const r = (await run())['ai.tool_calls_blocked'];
  assert.equal(r.details.byReason.STALE, '1', 'tool_call BLOCKED com blocked_reason STALE entra');
  assert.equal(r.value, '3', 'PROPOSED (aprovação pendente) e CANCELLED_BY_HUMAN (rejeição humana) ficam fora: só BLOCKED conta');
  assert.equal(r.details.calls, '13', 'mas as duas continuam entre as chamadas totais');
  assert.equal(Object.keys(r.details.byReason).includes('EXPIRED'), false, 'o tool_call não tem estado EXPIRED');
  const states = (await env.admin.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'tool_calls_status_chk'"))[0][0].def;
  assert.doesNotMatch(states, /EXPIRED/);
});

test('m9d681 timezone: a chamada das 23:30 de São Paulo cai no dia certo', async () => {
  // a chamada BLOQUEADA das 02:30Z de 01/10 é das 23:30 de 30/09 em São Paulo: setembro
  const sep = await oracle.toolCalls(env, env.cX, '2026-09', '2026-09-30');
  assert.deepEqual([sep.calls, sep.blocked], [1, 1]);
  const r = (await run('2026-09-30'))['ai.tool_calls_blocked'];
  assert.deepEqual([r.status, r.value, r.details.calls], ['OK', '1', '1']);
  assert.equal((await run('2026-10-28'))['ai.tool_calls_blocked'].value, '3', 'outubro não a conta');
});
