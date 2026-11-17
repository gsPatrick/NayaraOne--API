'use strict';

// M9-D420 A com a origem do lead obrigatória (segunda leva de 16/11/2026, item 7; DI-BI2-4; decisão do Patrick): quem escreve pela primeira vez no
// WhatsApp vira lead com origem WHATSAPP, e a automação pronta LEAD-NOVO passa a disparar para ele (confirmação no próprio WhatsApp e tarefa ao
// corretor da carteira), como o M9-D420 previa. Antes o lead do WhatsApp nascia sem origem e o filtro de origem não deixava a automação rodar.
// O caminho é o de produção: resolveSender (o mesmo do onInbound) cria a oportunidade, e o evento crm.opportunity.created gravado no outbox é o
// que o consumidor do runner recebe. Banco descartável:
// node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d420.leadWhatsapp.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, OutboxEvent } = require('../../../src/models');
const env = require('../_helpers/mktLeads');
const { resolveSender } = require('../../../src/features/crm/messaging/messaging.sender');
const { inputOf } = require('../../../src/features/marketing/automations/runner/runner.consumer');

let A;
let offVault;
before(async () => { ({ tenantA: A } = await env.prepararTenants()); offVault = env.useTempSecretStore(); });
after(async () => { offVault(); await sequelize.close(); });

const CODE = 'LEAD-NOVO';
const inRollback = (fn) => env.withRollbackTenantTransaction(A, fn);
const newNumber = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

/** Primeira mensagem de um número desconhecido: o lead provisório e o evento crm.opportunity.created que o CRM gravou no outbox. */
async function whatsappLead(t, name) {
  const quem = await resolveSender({ groupId: A.groupId, companyId: A.companyId }, { from: newNumber(), name }, t);
  assert.equal(quem.provisional, true, 'número desconhecido vira lead provisório');
  const outbox = await OutboxEvent.findOne({ where: { eventType: 'crm.opportunity.created', aggregateId: quem.opportunityId }, transaction: t });
  assert.ok(outbox, 'o CRM publicou crm.opportunity.created');
  return { ...quem, event: inputOf(outbox) };
}

test('lead_do_whatsapp_nasce_com_origem_e_dispara_o_lead_novo', async () => {
  await inRollback(async (t) => {
    await env.install(t, A, CODE);
    const lead = await whatsappLead(t, 'Bruno Lima');
    const [opp] = await env.q(t, 'SELECT lead_source, owner_user_id FROM crm.opportunities WHERE id = :id', { id: lead.opportunityId });
    assert.equal(opp.lead_source, 'WHATSAPP', 'o canal é a origem do lead');
    await env.openWindow(t, A, lead.personId); // a pessoa acabou de escrever: janela de atendimento aberta
    const out = await env.run(t, A, lead.event);
    assert.equal(out.runs.length, 1, 'WHATSAPP está na lista padrão de origens do lead novo: a automação dispara');
    const row = await env.runRow(t, out.runs[0].runId);
    assert.equal(row.status, 'COMPLETED');
    const send = env.sendEntry(row);
    assert.deepEqual([send.status, send.channel, send.purpose], ['OK', 'WHATSAPP', 'TRANSACTIONAL'], 'confirmação no próprio WhatsApp');
    const [message] = await env.outbound(t, lead.personId);
    assert.ok(message && message.body.includes('Recebemos seu interesse, Bruno.'), 'o texto da confirmação, com o primeiro nome');
    const task = (await env.tasksOf(t, A, lead.personId)).find((r) => r.title === 'Contatar lead novo');
    assert.ok(task, 'o corretor ganha a tarefa de contato');
    assert.equal(task.assigned_to_user_id, opp.owner_user_id, 'tarefa ao responsável da oportunidade');
  });
});

test('lead_do_whatsapp_fora_da_lista_de_origens_da_empresa_nao_dispara', async () => {
  await inRollback(async (t) => {
    await env.setParam(t, A, 'marketing.lead_novo.origens', 'FORM, SITE, PORTAL');
    await env.install(t, A, CODE);
    const lead = await whatsappLead(t, 'Carla Dias');
    const out = await env.run(t, A, lead.event);
    assert.equal(out.runs.length, 0, 'a empresa tirou WHATSAPP da lista: o lead do WhatsApp não recebe a confirmação automática');
    assert.equal((await env.tasksOf(t, A, lead.personId)).filter((r) => r.title === 'Contatar lead novo').length, 0);
  });
});
