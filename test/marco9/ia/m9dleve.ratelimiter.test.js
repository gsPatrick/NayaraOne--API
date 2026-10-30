'use strict';

// DI-IA-LEVE-5 — o limitador em memória (código morto no fluxo de produção) saiu; a taxa por pessoa é o contador de banco do AgentRunGuard.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const agents = require('../../../src/features/ai/agents');
const { WINDOW_MS } = require('../../../src/features/ai/agents/RunRateLimiter');

test('m9dleve5_sem_limitador_em_memoria_e_janela_preservada', () => {
  assert.equal(agents.RunRateLimiter, undefined);
  assert.equal(agents.defaultRunRateLimiter, undefined);
  assert.equal(typeof agents.AgentRunGuard.prototype.assertRate, 'undefined');
  assert.equal(typeof agents.AgentRunGuard.prototype.assertRateCount, 'function');
  assert.equal(WINDOW_MS, 60000);
});

test('m9dleve5_contador_de_banco_devolve_429_no_limite', () => {
  const guarda = new agents.AgentRunGuard({ code: 'X' }, { companyId: 'c', userId: 'u' }, { maxRunsPorMinutoUsuario: 3 });
  guarda.assertRateCount(2);
  assert.throws(() => guarda.assertRateCount(3), (e) => e.statusCode === 429 && e.code === 'AI_RATE_LIMITED');
});
