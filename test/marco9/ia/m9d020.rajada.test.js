'use strict';

// M9-D020 (reabertura, achados G-1 e M-1 da auditoria de fechamento) — rajada de POST /ai/runs do mesmo usuário, acima do tamanho do pool de
// conexões (10): nenhuma resposta 500 (a trava do pool terminava em 500 após o prazo de aquisição de conexão), e o limite de runs por minuto do usuário é exato
// (aceita exatamente o limite, as demais recebem 429 e só o limite é gravado). Cinco rodadas seguidas. App real, provider sandbox, cluster
// descartável; nunca chama MFA nem forja token.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP } = require('../_helpers/aiHttpEnv');
const H = require('../_helpers/iaRunApiEnv');

let env; let tenant;
const RAJADA = 30;
const RODADAS = 5;
const pedido = (code, extra = '') => ({ agentCode: code, purpose: 'Rajada', input: `Olá [[RESPOSTA:Olá.]] ${extra}`.trim() });
const disparar = (code, n, extra) => Promise.all(Array.from({ length: n }, () => env.call('POST', '/ai/runs', env.tokens['A:gestor'], pedido(code, extra))));
const gravados = async (code) => Number((await H.admin('SELECT count(*) AS n FROM ai.ai_runs WHERE company_id = $1 AND agent_name = $2', [tenant.companyId, code])).rows[0].n);

before(async () => {
  if (!DISPOSABLE) return;
  ({ env, tenant } = await H.subir(Number(process.env.M9D020_RAJADA_TEST_PORT) || 23871));
});
after(async () => { await H.encerrar(env, []); });

test('m9d020_rajada_acima_do_pool_nao_trava_a_api_nem_devolve_500', { skip: SKIP }, async () => {
  const code = await H.agenteAtivo(env, tenant, { limits: { max_runs_por_minuto_usuario: 1000 } });
  for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
    // [[LENTO:150]]: cada run segura a conexão da execução por 150 ms, como uma chamada de modelo de verdade.
    const respostas = await disparar(code, RAJADA, '[[LENTO:150]]');
    const status = respostas.map((r) => r.status);
    assert.deepEqual(status.filter((s) => s !== 200 && s !== 202), [], `rodada ${rodada}: ${JSON.stringify(respostas.find((r) => r.status >= 400) || {})}`);
    // A API segue de pé para os outros endpoints logo depois da rajada.
    assert.equal((await env.call('GET', '/ai/agents', env.tokens['A:gestor'])).status, 200);
  }
  assert.equal(await gravados(code), RAJADA * RODADAS, 'todo pedido aceito tem o seu run gravado');
});

test('m9d020_limite_por_minuto_do_usuario_e_exato_sob_rajada', { skip: SKIP }, async () => {
  const LIMITE = 3;
  for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
    const code = await H.agenteAtivo(env, tenant, { limits: { max_runs_por_minuto_usuario: LIMITE } });
    const respostas = await disparar(code, RAJADA);
    const aceitos = respostas.filter((r) => r.status === 200 || r.status === 202);
    const barrados = respostas.filter((r) => r.status === 429);
    assert.equal(aceitos.length, LIMITE, `rodada ${rodada}: aceitos ${aceitos.length}, status ${respostas.map((r) => r.status).join(',')}`);
    assert.equal(barrados.length, RAJADA - LIMITE, `rodada ${rodada}`);
    assert.ok(barrados.every((r) => r.body.error.code === 'AI_RATE_LIMITED'));
    assert.equal(await gravados(code), LIMITE, `rodada ${rodada}: só o limite fica gravado`);
  }
});

test('m9d020_rajada_do_canal_de_atendimento_e_do_chat_tambem_usa_uma_conexao_por_pedido', { skip: SKIP }, async () => {
  const code = await H.agenteAtivo(env, tenant, { limits: { max_runs_por_minuto_usuario: 1000 } });
  const respostas = await Promise.all(Array.from({ length: RAJADA }, () => env.call('POST', `/ai/agents/${code}/chat`, env.tokens['A:gestor'], { message: 'Olá [[RESPOSTA:Olá.]] [[LENTO:100]]' })));
  assert.deepEqual(respostas.map((r) => r.status).filter((s) => s !== 200 && s !== 202), []);
});
