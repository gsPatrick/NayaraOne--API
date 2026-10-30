'use strict';

// Marco 9, M9-D252 — teste adversarial 14 do livro (seção 19): a mesma suíte de cenários em dois adapters de mensageria (messaging-sandbox e messaging-alt-sandbox) dá o mesmo resultado interno e os
// mesmos eventos; o contrato de cada adapter também passa. Banco descartável (os testes COMMITAM).
process.env.PORT = process.env.M9D252_SWAP_PORT || '25253';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d230Env');

let tenant;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { await env.pausar(tenant); await env.sequelize.close(); process.exit(0); });

/** Uma conversa completa num fornecedor: envio, aceite, entrega por webhook (repetido), mensagem recebida (repetida). Devolve só o que é INTERNO. */
async function cenario(provider) {
  const canal = await env.conectar(tenant, provider);
  const p = await env.pessoa(tenant);
  const r = await env.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: p.phone, text: 'Olá' });
  const filas = [(await env.mensagem(tenant, r.message.id)).delivery_status];
  await env.rodarEnvios(tenant);
  const aceita = await env.mensagem(tenant, r.message.id);
  filas.push(aceita.delivery_status);
  const evento = env.eventoStatus(canal, aceita.external_message_id, 'DELIVERED');
  await env.postar(canal, evento);
  await env.postar(canal, evento);
  await env.rodar(tenant);
  await env.rodar(tenant);
  filas.push((await env.mensagem(tenant, r.message.id)).delivery_status);
  const [inbox] = await env.sql(tenant, 'SELECT id FROM integration.webhook_inbox WHERE company_id = :c AND provider_code = :p AND resource_ref = :r AND applied IS TRUE', { c: tenant.companyId, p: canal.provider, r: aceita.external_message_id });
  const eventos = (await env.outboxDe(tenant, inbox.id)).map((e) => e.event_type);
  const alt = canal.provider === 'messaging-alt-sandbox';
  const entrada = alt ? env.inboundB(`in-${env.uniqueSuffix()}`, p.phone.slice(1), 'Tenho interesse') : env.inboundA(`in-${env.uniqueSuffix()}`, p.phone, 'Tenho interesse');
  await env.postar(canal, entrada);
  await env.postar(canal, { ...entrada, ...(alt ? { event_id: `evt-b-${env.uniqueSuffix()}` } : { id: `evt-${env.uniqueSuffix()}` }) });
  await env.rodar(tenant);
  const mensagens = await env.mensagensDa(tenant, p.id);
  const envio = await env.envioDe(tenant, r.dispatchId);
  return { statusDaMensagem: filas, estadoDoEnvio: envio.status, eventosInternos: eventos, direcoes: mensagens.map((m) => m.direction), textoRecebido: mensagens.find((m) => m.direction === 'INBOUND').body };
}

test('adv_provider_swap_mesmo_resultado_contract', async () => {
  const a = await cenario('messaging-sandbox');
  const b = await cenario('messaging-alt-sandbox');
  assert.deepEqual(a.statusDaMensagem, ['QUEUED', 'SENT', 'DELIVERED']);
  assert.equal(a.estadoDoEnvio, 'CONFIRMED');
  assert.deepEqual(a.eventosInternos, ['integration.messaging.message.status']);
  assert.deepEqual([...a.direcoes].sort(), ['INBOUND', 'OUTBOUND'], 'a entrada repetida vira uma só mensagem');
  assert.deepEqual(b, a, 'mesmo resultado interno, mesmos eventos e mesmos estados de envio nos dois fornecedores');

  // O contrato: os dois adapters passam a mesma suíte de contrato (10 cenários) e o relatório diz PASSED.
  const contract = require('../../../src/features/integrations/contract');
  const resultados = [];
  for (const provider of ['messaging-sandbox', 'messaging-alt-sandbox']) {
    const alvo = contract.listTargets().find((x) => x.providerCode === provider);
    assert.ok(alvo, `${provider} tem suíte de contrato`);
    const rel = await contract.runSuite(alvo);
    assert.equal(rel.status, 'PASSED', `${provider}: contrato`);
    assert.equal(rel.passed, rel.executions, `${provider}: todas as execuções passam`);
    resultados.push(rel.scenarios.map((x) => x.name || x.id || x.scenario).join(','));
  }
  assert.equal(resultados[0], resultados[1], 'os dois adapters passam os mesmos cenários de contrato');
});
