'use strict';

// Marco 9, M9-D226 — a fila e o prazo: o item que passa da idade máxima vira tarefa manual; o banco usa a régua única de max_pending_hours.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d226Env');

const { sequelize, carregarTenants, contingency, criar, chave, config, limparConfig } = env;
let tenant;

before(async () => { ({ tenant } = await carregarTenants()); contingency.installContingency(); });
beforeEach(async () => { await env.limparContingencias(tenant); await env.limparCircuito(tenant); await env.limparPendentes(tenant); await limparConfig(tenant, env.CHAVES); });
after(async () => { await env.limparContingencias(tenant); await env.limparCircuito(tenant); await env.limparPendentes(tenant); await limparConfig(tenant, env.CHAVES); await env.desativarConexoesDeTeste(tenant); await sequelize.close(); });

const msg = (conn) => criar(tenant, conn.id, chave(), { operation: 'sendText', snapshot: { to: '+5541999990000', text: 'Olá' }, criticalityOp: 'SAFE' }).then((r) => r.dispatch);
const pagamento = (conn) => criar(tenant, conn.id, chave(), { operation: 'submitPayment', snapshot: { amount: '10.00', payee: 'X' } }).then((r) => r.dispatch);
const eventosDo = async (id) => (await env.eventos(tenant, 'integration.contingency.manual_task')).filter((e) => e.payload_json.dispatchId === id);

test('contingencia_fila_vira_tarefa_manual_apos_idade_maxima', async () => {
  const c = await env.conexaoDe(tenant, 'messaging-sandbox');
  const velho = await msg(c);
  const novo = await msg(c);
  await env.envelhecer(tenant, velho.id, 25);
  await env.envelhecer(tenant, novo.id, 23);
  const r = await env.ciclo(tenant);
  assert.equal(r.manualTasks, 1, 'só o item com mais de 24 h vira tarefa');
  assert.equal((await eventosDo(velho.id)).length, 1);
  assert.equal((await eventosDo(novo.id)).length, 0, 'com 23 h ainda não vira');
  const ev = (await eventosDo(velho.id))[0].payload_json;
  assert.deepEqual([ev.mode, ev.assigneeRole, ev.operation], ['QUEUE_AND_ALTERNATE', 'ADMIN', 'sendText']);
  assert.match(ev.text, /canal alternativo/);
  assert.ok(new Date(ev.dueAt) > new Date(), 'a tarefa leva prazo');
  const ativa = (await env.ativas(tenant)).find((a) => a.connectionId === c.id);
  assert.ok(ativa && ativa.reasons.includes('QUEUE_AGE_EXCEEDED'), 'passar do prazo também é gatilho da contingência');

  // o consumidor cria a tarefa na caixa única, uma por envio, mesmo repetindo o evento e a rodada
  await env.consumir(tenant, 'integration.contingency.manual_task');
  await env.consumir(tenant, 'integration.contingency.manual_task');
  const tarefas = await env.tarefasDoEnvio(tenant, velho.id);
  assert.equal(tarefas.length, 1);
  assert.deepEqual([tarefas[0].status, tarefas[0].priority, tarefas[0].related_entity_type], ['OPEN', 'HIGH', 'integration.dispatches']);
  assert.ok(tarefas[0].due_at && tarefas[0].description.includes(velho.id));
  assert.equal((await env.tarefasDoEnvio(tenant, novo.id)).length, 0);
  const r2 = await env.ciclo(tenant);
  assert.equal(r2.manualTasks, 0, 'repetir a rodada não gera outra tarefa para o mesmo envio');
  assert.equal((await eventosDo(velho.id)).length, 1);

  // o prazo é do administrador: com 48 h o item de 25 h não vira tarefa
  await limparConfig(tenant, ['integration.contingency.queue_max_age_h.QUEUE_AND_ALTERNATE']);
  const c2 = await env.conexaoDe(tenant, 'messaging-sandbox');
  await config(tenant, 'integration.contingency.queue_max_age_h.QUEUE_AND_ALTERNATE', 48);
  const meio = await msg(c2);
  await env.envelhecer(tenant, meio.id, 25);
  await env.ciclo(tenant);
  assert.equal((await eventosDo(meio.id)).length, 0);
});

test('contingencia_banco_usa_a_regua_unica_max_pending_hours', async () => {
  const b = await env.conexaoDe(tenant, 'bank-sandbox', { contingencia: { queue_max_age_h: 1 } }); // ignorado: o banco lê só integration.bank.max_pending_hours
  const meio = await pagamento(b);
  const velho = await pagamento(b);
  await env.envelhecer(tenant, meio.id, 25);
  await env.envelhecer(tenant, velho.id, 73);
  const r = await env.ciclo(tenant);
  assert.equal(r.manualTasks, 1);
  assert.equal((await eventosDo(velho.id)).length, 1, 'pagamento pendente há 73 h (limite 72 h) vira tarefa ao financeiro');
  assert.equal((await eventosDo(meio.id)).length, 0, 'com 25 h ainda não vira');
  assert.match((await eventosDo(velho.id))[0].payload_json.text, /Consultar o banco/);
  assert.equal((await comTenantStatus(velho.id)), 'PENDING', 'nenhum pagamento é dado como pago');
});

const comTenantStatus = async (id) => (await env.ler(tenant, id)).status;

test('contingencia_drena_fila_respeitando_cota', async () => {
  const c = await env.conexaoDe(tenant, 'messaging-sandbox');
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const d = await msg(c);
    await env.envelhecer(tenant, d.id, 5 - i); // o primeiro criado é o mais antigo
    await env.forcar(tenant, d.id, "next_attempt_at = now() + interval '1 day'");
    ids.push(d.id);
  }
  await env.falhar(tenant, c.id, 5);
  assert.equal((await env.ativas(tenant)).filter((a) => a.connectionId === c.id).length, 1);
  await env.fecharCircuito(tenant, c.id);
  await env.checks(tenant, c.id, 3);
  // cota informada pelo fornecedor: restam 4 de 10; a reserva de 20% (2) fica de fora, então só 2 itens saem
  await env.comTenant(tenant, (t) => sequelize.query(
    `INSERT INTO integration.dispatch_attempts (group_id, company_id, dispatch_id, connection_id, provider_code, attempt_no, started_at, quota_limit, quota_remaining, quota_resets_at)
     VALUES (:g, :c, :d, :conn, 'messaging-sandbox', 1, now(), 10, 4, now() + interval '1 hour')`, { replacements: { g: tenant.groupId, c: tenant.companyId, d: ids[0], conn: c.id }, transaction: t },
  ));
  const r = await env.ciclo(tenant);
  assert.equal(r.deactivated >= 1, true);
  assert.equal(r.drained, 2, 'a cota limita o que a fila solta');
  const linhas = [];
  for (const id of ids) linhas.push(await env.ler(tenant, id));
  const vencidos = linhas.filter((l) => new Date(l.next_attempt_at) <= new Date());
  assert.deepEqual(vencidos.map((l) => l.id), [ids[0], ids[1]], 'saem os mais antigos, na ordem de criação');
  assert.ok(new Date(linhas[0].next_attempt_at) < new Date(linhas[1].next_attempt_at), 'a ordem de vencimento segue a de criação');
  assert.ok(linhas.slice(2).every((l) => new Date(l.next_attempt_at) > new Date()), 'o resto espera');
  assert.equal((await env.eventos(tenant, 'integration.contingency.deactivated')).length >= 1, true);
});
