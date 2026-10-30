'use strict';

// Marco 9, M9-D251 — teste adversarial do livro (seção 19), circuit breaker: cinco falhas abrem o circuito, o não essencial é adiado sem gastar tentativa nem chamar o fornecedor,
// e um sucesso em HALF_OPEN fecha. Relógio simulado: a abertura é recuada no banco, sem esperar o cooldown. Banco descartável (os testes COMMITAM).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  sequelize, carregarTenants, ctxDe, conexaoAtiva, limparPendentes, enfileirar, tentativas, instalar, restaurar, forcar, ler, dispatch,
} = require('../_helpers/m9d214Env');
const { mensagemProgramavel, erroHttp } = require('../_helpers/m9d214Scripted');
const { linha, forcarCircuito, limparCircuito, desativarConexoesDeTeste } = require('../_helpers/m9d217Env');
const { clearContingencyHandlers } = require('../../../src/features/integrations/providers/contingency.registry');

let tenant;
let msg;
let Msg;
const agg = () => crypto.randomUUID();
const texto = (extra = {}) => enfileirar(tenant, { connectionId: msg.id, operation: 'sendText', aggregateType: 'Message', aggregateId: agg(), payload: { to: `+5541${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`, text: 'Olá' }, ...extra });
const rodar = (now = new Date()) => dispatch.runDispatchCycle(ctxDe(tenant), { now, limit: 50 });

before(async () => { ({ tenant } = await carregarTenants()); });
beforeEach(async () => {
  Msg = mensagemProgramavel({ idempotente: true });
  instalar(Msg);
  clearContingencyHandlers();
  await limparPendentes(tenant);
  await limparCircuito(tenant);
  msg = await conexaoAtiva(tenant, 'MESSAGING');
});
after(async () => { clearContingencyHandlers(); await limparCircuito(tenant); await desativarConexoesDeTeste(tenant); restaurar(); await sequelize.close(); });

test('adv_circuit_breaker_abre_e_nao_essenciais_nao_chamam', async () => {
  // Cinco 503 seguidos abrem o circuito.
  Msg.S.fila('sendText', [{ erro: erroHttp(503) }]);
  for (let i = 0; i < 5; i += 1) await texto();
  await rodar();
  const aberto = await linha(tenant, msg.id);
  assert.equal(aberto.circuit_state, 'OPEN', 'cinco falhas consecutivas abrem');
  assert.equal(aberto.consecutive_failures, 5);
  const chamadasAntes = Msg.S.chamadas.length;
  // Não essencial: adiado sem gastar tentativa e sem chamar o fornecedor.
  const massa = await texto();
  const resumo = await rodar();
  assert.equal(resumo.deferred, 1, 'o não essencial é adiado');
  const espera = await ler(tenant, massa.dispatchId);
  assert.equal(espera.status, 'RETRY_WAIT');
  assert.equal(espera.attempts, 0, 'nenhuma tentativa gasta');
  assert.equal((await tentativas(tenant, massa.dispatchId)).length, 0);
  assert.equal(Msg.S.chamadas.length, chamadasAntes, 'o fornecedor não foi chamado');
  // Cooldown vencido (relógio recuado): HALF_OPEN admite uma chamada de teste e um sucesso fecha.
  await forcarCircuito(tenant, msg.id, { circuitOpenedAt: new Date(Date.now() - 24 * 3600 * 1000) });
  Msg.S.fila('sendText', [{ resposta: { status: 'SENT', externalResourceId: `m-${crypto.randomUUID()}` } }]);
  await forcar(tenant, massa.dispatchId, "next_attempt_at = now() - interval '1 second'");
  await rodar();
  assert.equal((await ler(tenant, massa.dispatchId)).status, 'SUBMITTED', 'a chamada de teste passou');
  const fechado = await linha(tenant, msg.id);
  assert.deepEqual([fechado.circuit_state, fechado.consecutive_failures, fechado.half_open_inflight], ['CLOSED', 0, 0], 'um sucesso em HALF_OPEN fecha o circuito');
});
