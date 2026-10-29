'use strict';

// M9-D419 — customer.opted_out: emitido UMA vez pelo serviço que registra o OPT_OUT (resposta SAIR, link, tela de Pessoas), na mesma
// transação do consentimento e da supressão, sem endereço no payload; supressão por outro motivo não emite; a criação da supressão
// não reemite. Banco descartável; transação com rollback; duas empresas.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { service: { suppress }, automatic } = require('../../../src/features/marketing/suppression');
const { recordConsent } = require('../../../src/features/people/personConsents.service');
const env = require('../_helpers/mktOptOut');

const { readyPerson, addContact, events, suppressions, optOutConsents } = env;
let A;
let B;
before(async () => { ({ a: A, b: B } = await env.tenants()); });
after(async () => { await sequelize.close(); });
const run = (fn) => withRollbackTenantTransaction(A, fn);

test('opt_out_emite_evento_sem_endereco', async () => {
  await run(async (t) => {
    const email = `qa-m9-optout-${env.uid().slice(0, 6)}@exemplo.test`;
    const p = await readyPerson(t, A, { email, phone: '11988887777' });
    await automatic.handleUnsubscribeLink({ personId: p, channel: 'EMAIL' }, A, t);
    const [event] = await events(t, p);
    const { payload, type, occurredAt, companyId } = event.payload_json;
    assert.deepEqual([type, companyId], ['customer.opted_out', A.companyId]);
    assert.deepEqual(Object.keys(payload).sort(), ['channel', 'occurredAt', 'personId', 'purpose', 'source']);
    assert.deepEqual([payload.personId, payload.channel, payload.purpose, payload.source], [p, 'EMAIL', 'ALL', 'UNSUBSCRIBE_LINK']);
    assert.ok(!Number.isNaN(Date.parse(payload.occurredAt)) && Date.parse(occurredAt) >= Date.parse(payload.occurredAt) - 1000);
    const wire = JSON.stringify(event.payload_json);
    assert.ok(!wire.includes(email) && !wire.includes('11988887777') && !wire.includes('@'), 'nenhum endereço no evento');
    assert.ok(!/\d{8,}/.test([payload.channel, payload.purpose, payload.source].join(' ')), 'nenhum número de telefone nos textos do evento');
    // mesma transação: consentimento OPT_OUT e supressão gravados junto com o evento
    assert.deepEqual(await optOutConsents(t, p), [{ channel: 'EMAIL', purpose: 'ALL', status: 'OPT_OUT' }]);
    assert.equal((await suppressions(t, p)).length, 1);
  });
});

test('opt_out_emite_um_unico_evento_e_a_supressao_nao_reemite', async () => {
  await run(async (t) => {
    // resposta SAIR: um registro, um evento; repetir não reemite
    const p = await readyPerson(t, A);
    await automatic.handleInboundReply({ personId: p, channel: 'WHATSAPP', text: 'SAIR' }, A, t);
    await automatic.handleInboundReply({ personId: p, channel: 'WHATSAPP', text: 'sair' }, A, t);
    assert.equal((await events(t, p)).length, 1);
    assert.equal((await suppressions(t, p)).length, 1);
    // outros motivos de supressão nunca emitem customer.opted_out
    for (const reason of ['BOUNCE', 'COMPLAINT', 'LEGAL', 'MANUAL']) {
      const other = await readyPerson(t, A);
      await suppress({ personId: other, channel: 'EMAIL', reason, source: `QA-M9-${reason}` }, A, t);
      assert.equal((await events(t, other)).length, 0, reason);
      assert.equal((await suppressions(t, other)).length, 1, reason);
    }
    // a supressão de OPT_OUT depois de um BOUNCE do mesmo endereço emite (é o primeiro OPT_OUT da pessoa) e só uma vez
    const mixed = await readyPerson(t, A);
    await suppress({ personId: mixed, channel: 'EMAIL', reason: 'BOUNCE', source: 'QA-M9' }, A, t);
    await suppress({ personId: mixed, channel: 'WHATSAPP', reason: 'OPT_OUT', source: 'QA-M9' }, A, t);
    assert.equal((await events(t, mixed)).length, 1);
  });
});

test('tela_de_pessoas_registra_opt_out_com_supressao_cancelamento_e_um_unico_evento', async () => {
  await run(async (t) => {
    const p = await readyPerson(t, A);
    await recordConsent(p, { channel: 'EMAIL', purpose: 'MARKETING', status: 'OPT_OUT' }, A.userId, t);
    const [row] = await suppressions(t, p);
    assert.deepEqual([row.reason, row.source, row.channel, row.purpose], ['OPT_OUT', 'PEOPLE_SCREEN', 'EMAIL', 'MARKETING']);
    assert.equal((await events(t, p)).length, 1, 'um registro de OPT_OUT, um evento');
    assert.equal((await optOutConsents(t, p)).length, 1, 'o consentimento não é gravado duas vezes');
    assert.equal((await events(t, p))[0].payload_json.payload.purpose, 'MARKETING');
    // OPT_IN da tela não emite
    const q2 = await readyPerson(t, A, { optIn: [] });
    await recordConsent(q2, { channel: 'EMAIL', purpose: 'MARKETING', status: 'OPT_IN' }, A.userId, t);
    assert.equal((await events(t, q2)).length, 0);
    // pessoa sem nenhum contato: o OPT_OUT fica registrado e o evento sai, sem linha de supressão (não há endereço)
    const bare = await env.makePerson(t, A);
    await recordConsent(bare, { channel: 'WHATSAPP', purpose: 'ALL', status: 'OPT_OUT' }, A.userId, t);
    assert.equal((await events(t, bare)).length, 1);
    assert.equal((await suppressions(t, bare)).length, 0);
    assert.equal((await optOutConsents(t, bare)).length, 1);
  });
});

test('evento_de_uma_empresa_nao_aparece_na_outra', async () => {
  const pA = await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    await automatic.handleUnsubscribeLink({ personId: p, channel: 'EMAIL' }, A, t);
    assert.equal((await events(t, p)).length, 1);
    return p;
  });
  await withRollbackTenantTransaction(B, async (t) => {
    assert.equal((await events(t, pA)).length, 0);
    const p = await env.makePerson(t, B);
    await addContact(t, B, p, 'EMAIL', `qa-m9-${env.uid().slice(0, 6)}@exemplo.test`);
    await recordConsent(p, { channel: 'EMAIL', purpose: 'ALL', status: 'OPT_OUT' }, B.userId, t);
    assert.equal((await events(t, p)).length, 1);
  });
});
