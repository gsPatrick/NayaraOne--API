'use strict';

// M9-D020 (reabertura, literal INPUT_MAX do achado L-4) — o tamanho máximo do pedido de POST /ai/runs e do chat é parâmetro da empresa
// (ia.run.entrada_max_caracteres, padrão 8.000): o administrador muda pela tela de configurações e a rota obedece (400 AI_INPUT_INVALID
// acima do limite, antes de existir run). App real, provider sandbox, cluster descartável; nunca chama MFA nem forja token.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP } = require('../_helpers/aiHttpEnv');
const H = require('../_helpers/iaRunApiEnv');

let env; let tenant; let code;
const CHAVE = 'ia.run.entrada_max_caracteres';
const gestor = () => env.tokens['A:gestor'];
const texto = (n) => `Olá [[RESPOSTA:Olá.]] ${'x'.repeat(Math.max(0, n - 22))}`.slice(0, n);
const run = (n) => env.call('POST', '/ai/runs', gestor(), { agentCode: code, purpose: 'Limite', input: texto(n) });
const chat = (n) => env.call('POST', `/ai/agents/${code}/chat`, gestor(), { message: texto(n) });
const ok = (res) => res.status === 200 || res.status === 202; // 202: a máquina de teste demorou mais que ia.run.sincrono_max_ms
const contar = async () => Number((await H.admin('SELECT count(*) AS n FROM ai.ai_runs WHERE company_id = $1 AND agent_name = $2', [tenant.companyId, code])).rows[0].n);

before(async () => {
  if (!DISPOSABLE) return;
  ({ env, tenant } = await H.subir(Number(process.env.M9D020_ENTRADA_TEST_PORT) || 23873));
  code = await H.agenteAtivo(env, tenant, { limits: { max_runs_por_minuto_usuario: 1000 } });
});
after(async () => { await env.call('PUT', `/settings/${CHAVE}`, gestor(), { value: 8000 }); await H.encerrar(env, []); });

test('m9d020_tamanho_maximo_do_pedido_e_parametro_da_empresa', { skip: SKIP }, async () => {
  assert.ok(ok(await run(8000)), 'padrão do livro-demanda: 8.000 passa');
  const acima = await run(8001);
  assert.equal(acima.status, 400);
  assert.equal(acima.body.error.code, 'AI_INPUT_INVALID');

  assert.equal((await env.call('PUT', `/settings/${CHAVE}`, gestor(), { value: 100 })).status, 200);
  const antes = await contar();
  assert.ok(ok(await run(100)));
  const barrado = await run(101);
  assert.equal(barrado.status, 400, JSON.stringify(barrado.body));
  assert.equal(barrado.body.error.code, 'AI_INPUT_INVALID');
  const barradoChat = await chat(101);
  assert.equal(barradoChat.status, 400);
  assert.equal(await contar(), antes + 1, 'o pedido recusado não cria run');
  assert.ok(ok(await chat(100)));

  assert.equal((await env.call('PUT', `/settings/${CHAVE}`, gestor(), { value: 20000 })).status, 200);
  assert.ok(ok(await run(15000)), 'o administrador ampliou o limite');
  assert.equal((await env.call('PUT', `/settings/${CHAVE}`, gestor(), { value: 0 })).status, 400, 'valor fora da faixa é recusado');
});
