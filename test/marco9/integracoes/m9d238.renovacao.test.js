'use strict';

// Marco 9, M9-D238 — a renovação inicia uma nova cotação pelo mesmo adapter (API ou fluxo manual), uma vez por apólice e vigência, e o aviso de seguro fora do ar não derruba a
// rotina. Banco descartável.
process.env.PORT = process.env.M9D238_RENOV_PORT || '24241';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d238Env');
const milestones = require('../../../src/features/procurement/insurance/insurance.milestones');
const tasks = require('../../../src/features/procurement/insurance/insurance.tasks');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.escolher(tenant, 'sandbox'); await env.config(tenant, 'integration.insurance.renewal_quote_enabled', true); await env.sequelize.close(); process.exit(0); });

const rodar = (hoje) => env.comTenant(tenant, (t) => milestones.publishDueMilestones(t, hoje));
const cotacoesDeRenovacao = async (id) => (await env.envios(tenant, id, 'quote')).filter((e) => e.idempotency_key.startsWith('insurance-renewal-quote:'));

/** Apólice vigente (emitida pelo provedor escolhido, com a vigência ajustada no banco) e cotada antes, para guardar o pedido da cotação original. */
async function vigente(expiryDate) {
  const a = await env.criarApolice(tenant);
  await env.cotar(tenant, a.id, { estimatedValue: 24000 });
  await env.emitir(tenant, a.id);
  await env.sql(tenant, 'UPDATE procurement.insurance_policies SET effective_date = :e, expiry_date = :x WHERE id = :id', { id: a.id, e: '2026-01-01', x: expiryDate });
  return a;
}

test('seguro_renovacao_inicia_nova_cotacao_pelo_mesmo_adapter_uma_vez', async () => {
  await env.config(tenant, 'integration.insurance.renewal_quote_enabled', true);
  await env.escolher(tenant, 'sandbox');
  await env.conectar(tenant, 'insurance-sandbox');
  const a = await vigente('2026-12-31');
  assert.equal((await env.apolice(tenant, a.id)).quote_request_json.insuredAmount, 24000, 'a apólice guarda o pedido da cotação original');
  const r0 = await rodar('2026-11-15'); // 46 dias: antes do prazo da cotação (30 dias)
  assert.equal(r0.renewalQuotes, 0);
  assert.equal((await cotacoesDeRenovacao(a.id)).length, 0);
  const r1 = await rodar('2026-12-01'); // 30 dias
  const [falhou] = await env.sql(tenant, "SELECT reason, after_json FROM audit.audit_log WHERE entity_id = :id AND action LIKE 'procurement.insurance_policy.renewal_quote%'", { id: a.id });
  assert.equal(r1.renewalQuotes, 1, JSON.stringify(falhou));
  const [pedido] = await cotacoesDeRenovacao(a.id);
  assert.equal(pedido.idempotency_key, `insurance-renewal-quote:${a.id}:2026-12-31`, 'uma cotação por apólice e vigência');
  assert.equal(pedido.purpose, 'INSURANCE_QUOTE');
  assert.equal(pedido.payload_snapshot.purposeKind, 'RENEWAL');
  assert.equal(pedido.payload_snapshot.insuredAmount, '24000', 'o mesmo pedido da cotação original');
  assert.equal(pedido.connection_id, (await env.envios(tenant, a.id, 'propose'))[0].connection_id, 'pelo mesmo adapter (a mesma connection)');
  const evento = await env.eventos(tenant, a.id, 'insurance.renewal.quote_received');
  assert.equal(evento.length, 1);
  assert.deepEqual([evento[0].payload_json.source, Number(evento[0].payload_json.premiumAmount), evento[0].payload_json.renewal], ['API', 240, true]);
  assert.equal((await env.apolice(tenant, a.id)).status, 'ACTIVE', 'a cotação de renovação não muda a apólice vigente');
  await rodar('2026-12-01');
  await rodar('2026-12-02');
  assert.equal((await cotacoesDeRenovacao(a.id)).length, 1, 'rodar de novo não pede outra cotação');
  // Desligada pela empresa: nenhuma cotação.
  await env.config(tenant, 'integration.insurance.renewal_quote_enabled', false);
  const b = await vigente('2027-03-31');
  await rodar('2027-03-01');
  assert.equal((await cotacoesDeRenovacao(b.id)).length, 0);
  await env.config(tenant, 'integration.insurance.renewal_quote_enabled', true);
  // Prazo da cotação é parâmetro: 45 dias.
  await env.config(tenant, 'integration.insurance.renewal_quote_days', 45);
  const c = await vigente('2027-05-31');
  await rodar('2027-04-16');
  assert.equal((await cotacoesDeRenovacao(c.id)).length, 1);
  await env.config(tenant, 'integration.insurance.renewal_quote_days', 30);
});

test('seguro_renovacao_sem_pedido_original_e_com_seguradora_fora_do_ar', async () => {
  await env.escolher(tenant, 'sandbox');
  await env.conectar(tenant, 'insurance-sandbox');
  const a = await vigente('2027-08-31');
  await env.sql(tenant, 'UPDATE procurement.insurance_policies SET quote_request_json = NULL WHERE id = :id', { id: a.id });
  await rodar('2027-08-01');
  assert.equal((await cotacoesDeRenovacao(a.id)).length, 0);
  const [auditoria] = await env.sql(tenant, "SELECT reason FROM audit.audit_log WHERE entity_id = :id AND action = 'procurement.insurance_policy.renewal_quote_skipped'", { id: a.id });
  assert.match(auditoria.reason, /pedido da cotação original/, 'sem o pedido original fica o rastro, nunca em silêncio');
  // Seguradora fora do ar: a rotina segue, o marco sai e a próxima rodada tenta de novo.
  const b = await vigente('2027-09-30');
  await env.conectar(tenant, 'insurance-sandbox', { config: { sandbox_fault: 'HTTP_503' } });
  const r = await rodar('2027-09-01');
  assert.equal(r.renewalQuotes, 0);
  assert.equal((await marcos(b)).length, 1, 'o evento de vencimento sai mesmo com a seguradora fora');
  const [falha] = await env.sql(tenant, "SELECT 1 FROM audit.audit_log WHERE entity_id = :id AND action = 'procurement.insurance_policy.renewal_quote_failed'", { id: b.id });
  assert.ok(falha);
  await env.conectar(tenant, 'insurance-sandbox');
  assert.equal((await rodar('2027-09-02')).renewalQuotes, 1, 'na rodada seguinte, com a seguradora de volta, a cotação sai');
});
const marcos = (a) => env.eventos(tenant, a.id, 'insurance.policy.expiring');

test('seguro_renovacao_sem_api_vira_tarefa_manual_de_cotacao', async () => {
  await env.escolher(tenant, 'sandbox');
  await env.conectar(tenant, 'insurance-sandbox');
  const a = await vigente('2027-12-31');
  await env.escolher(tenant, 'manual');
  const r = await rodar('2027-12-01');
  assert.equal(r.renewalQuotes, 1);
  const [tarefa] = (await env.tarefas(tenant, a.id)).filter((t) => t.purpose === 'RENEWAL');
  assert.equal(tarefa.kind, 'QUOTE_DOCUMENT');
  assert.equal(tarefa.status, 'OPEN');
  assert.equal(tarefa.request_json.insuredAmount, '24000', 'a tarefa leva o valor segurado do pedido original');
  await env.comTenant(tenant, (t) => tasks.completeTask(tarefa.id, { premiumAmount: 250 }, env.actorDe(tenant), t));
  const evento = await env.eventos(tenant, a.id, 'insurance.renewal.quote_received');
  assert.deepEqual([evento[0].payload_json.source, Number(evento[0].payload_json.premiumAmount), evento[0].payload_json.renewal], ['MANUAL', 250, true], 'o mesmo evento que a API produz, com a origem manual');
  const depois = await env.apolice(tenant, a.id);
  assert.equal(depois.status, 'ACTIVE');
  assert.equal(Number(depois.premium_amount), 240, 'o prêmio vigente não muda pela cotação de renovação');
  await rodar('2027-12-02');
  assert.equal((await env.tarefas(tenant, a.id)).filter((t) => t.purpose === 'RENEWAL').length, 1);
  await env.escolher(tenant, 'sandbox');
});
