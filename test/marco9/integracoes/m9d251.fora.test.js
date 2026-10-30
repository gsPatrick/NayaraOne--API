'use strict';

// Marco 9, M9-D251 — teste adversarial do livro (seção 19), provider fora: o circuito aberto ativa a contingência, o domínio fica íntegro (a mensagem continua na fila, nunca entregue,
// sem duplicata) e a recuperação drena a fila em ordem. Banco descartável (os testes COMMITAM); a queda é o circuito aberto à força, sem espera real.
process.env.PORT = process.env.M9D251_FORA_PORT || '25252';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d227Env');
const adv = require('../_helpers/m9d251Env');

const { contingency } = env;
let tenant;

before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  env.e234.useTempSecretStore();
  contingency.installContingency();
  await adv.aguardarApp(() => `http://127.0.0.1:${process.env.PORT}/api`);
});
beforeEach(async () => { await env.limparContingencias(tenant); await env.limparCircuito(tenant); await env.limparPendentes(tenant); });
after(async () => { await env.drenarEventos(tenant); await env.limparContingencias(tenant); await env.limparCircuito(tenant); await env.limparPendentes(tenant); await env.desativarConexoesDeTeste(tenant); await env.sequelize.close(); process.exit(0); });

const mensagensDa = (pessoa) => env.sql(tenant, "SELECT id, delivery_status, external_message_id, created_at FROM crm.messages WHERE company_id = :c AND person_id = :p AND direction = 'OUTBOUND' ORDER BY created_at, id", { c: tenant.companyId, p: pessoa.id });

test('adv_provider_fora_aciona_contingencia_sem_corromper_dominio', async () => {
  const c = await env.whatsapp(tenant);
  const p = await env.pessoa(tenant);
  await env.derrubar(tenant, c.id);
  const a = await env.enviar(tenant, p, 'Seu boleto vence amanhã.');
  const b = await env.enviar(tenant, p, 'Lembrete: a visita é às 10h.');
  const ciclo = await env.ciclo(tenant);
  assert.ok(ciclo.activated >= 1, 'a contingência é acionada com o provider fora');
  assert.ok((await env.ativas(tenant)).some((x) => x.connectionId === c.id), 'ativa para a connection derrubada');
  // Domínio íntegro durante a queda: as duas mensagens seguem na fila, nenhuma entregue, nenhuma duplicada, nenhum envio confirmado.
  await env.rodarEnvios(tenant);
  const durante = await mensagensDa(p);
  assert.equal(durante.length, 2, 'nenhuma mensagem perdida nem duplicada');
  assert.deepEqual(durante.map((m) => m.delivery_status), ['QUEUED', 'QUEUED']);
  assert.ok(durante.every((m) => m.external_message_id === null), 'sem identificador do provider: nada foi entregue');
  for (const r of [a, b]) assert.notEqual((await env.envioDe(tenant, r.dispatchId)).status, 'CONFIRMED');
  // O provider volta: a contingência sai e a fila é drenada, as duas mensagens vão para SENT na ordem em que foram pedidas.
  await env.recuperar(tenant, c.id);
  const volta = await env.ciclo(tenant);
  assert.ok(volta.deactivated >= 1, 'a contingência é desativada na recuperação');
  await env.rodarEnvios(tenant);
  const depois = await mensagensDa(p);
  assert.deepEqual(depois.map((m) => m.id), durante.map((m) => m.id), 'as mesmas mensagens, na mesma ordem');
  assert.deepEqual(depois.map((m) => m.delivery_status), ['SENT', 'SENT'], 'a fila foi drenada');
  const envios = await Promise.all([a, b].map((r) => env.envioDe(tenant, r.dispatchId)));
  assert.ok(new Date(envios[0].created_at) <= new Date(envios[1].created_at));
});
