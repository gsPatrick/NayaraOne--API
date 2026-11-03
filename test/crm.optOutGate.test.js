'use strict';

// Item 4 do ciclo de auditoria externa (Marco 3). Contrato bruto — Guia do Marcelo §11
// ("Consentimento"):
//   function canContact(person, channel, purpose) {
//       const consent = consentRepo.resolve(person.id, channel, purpose);
//       if (consent.status === 'OPT_OUT') return false;
//       if (purposeRequiresConsent(purpose) && consent.status !== 'OPT_IN') return false;
//       return true;
//   }
// §18: "❌ Não ignorar opt-out." / CRM-TS-009: "Opt-out — Cadência tenta enviar — Bloqueado."
//
// Até este ciclo só existia REGISTRO histórico (personConsents.service.js) sem NENHUM ponto
// de disparo consultando-o. Este teste prova: (1) canContact() implementa exatamente a regra
// do Caderno; (2) o gate está de fato plugado em messages.service.js.createMessage — o único
// ponto de disparo de mensagem existente no CRM hoje (não há cadência automática implementada
// ainda neste código).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const personService = require('../src/features/people/person.service');
const personConsentsService = require('../src/features/people/personConsents.service');
const messagesService = require('../src/features/crm/messages.service');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('canContact: OPT_OUT na mesma finalidade bloqueia; sem registro, TRANSACTIONAL é permitido e MARKETING é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const person = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Opt-out Gate ${suffix}` },
      tenant.userId,
      transaction
    );

    // Sem nenhum registro: finalidade operacional (TRANSACTIONAL) é permitida por padrão.
    assert.equal(await personConsentsService.canContact(person, 'WHATSAPP', 'TRANSACTIONAL', transaction), true);
    // Sem nenhum registro: finalidade de alto impacto (MARKETING) exige opt-in explícito.
    assert.equal(await personConsentsService.canContact(person, 'WHATSAPP', 'MARKETING', transaction), false);

    await personConsentsService.recordConsent(person.id, { channel: 'WHATSAPP', purpose: 'MARKETING', status: 'OPT_IN' }, tenant.userId, transaction);
    assert.equal(await personConsentsService.canContact(person, 'WHATSAPP', 'MARKETING', transaction), true);

    await personConsentsService.recordConsent(person.id, { channel: 'WHATSAPP', purpose: 'MARKETING', status: 'OPT_OUT' }, tenant.userId, transaction);
    assert.equal(
      await personConsentsService.canContact(person, 'WHATSAPP', 'MARKETING', transaction),
      false,
      'OPT_OUT mais recente precisa vencer, mesmo tendo havido um OPT_IN antes (histórico append-only)'
    );
    // OPT_OUT específico de MARKETING não deveria contaminar TRANSACTIONAL.
    assert.equal(await personConsentsService.canContact(person, 'WHATSAPP', 'TRANSACTIONAL', transaction), true);

    // OPT_OUT geral (purpose ALL) bloqueia qualquer finalidade no canal.
    await personConsentsService.recordConsent(person.id, { channel: 'WHATSAPP', purpose: 'ALL', status: 'OPT_OUT' }, tenant.userId, transaction);
    assert.equal(await personConsentsService.canContact(person, 'WHATSAPP', 'TRANSACTIONAL', transaction), false);
  });
});

test('messages.service.createMessage bloqueia envio OUTBOUND quando a pessoa está em opt-out (gate real, não só registro histórico)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const person = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Opt-out Msg ${suffix}` },
      tenant.userId,
      transaction
    );

    // Sem opt-out: envio TRANSACTIONAL passa.
    const sent = await messagesService.createMessage(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        channel: 'WHATSAPP',
        direction: 'OUTBOUND',
        authorType: 'EMPLOYEE',
        authorUserId: tenant.userId,
        body: 'Confirmação de visita agendada.',
        purpose: 'TRANSACTIONAL',
      },
      tenant.userId,
      transaction
    );
    assert.ok(sent.id);

    await personConsentsService.recordConsent(person.id, { channel: 'WHATSAPP', purpose: 'TRANSACTIONAL', status: 'OPT_OUT' }, tenant.userId, transaction);

    await assert.rejects(
      () =>
        messagesService.createMessage(
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            personId: person.id,
            channel: 'WHATSAPP',
            direction: 'OUTBOUND',
            authorType: 'EMPLOYEE',
            authorUserId: tenant.userId,
            body: 'Nova tentativa de contato — cadência.',
            purpose: 'TRANSACTIONAL',
          },
          tenant.userId,
          transaction
        ),
      (err) => { assert.equal(err.code, 'MESSAGE_BLOCKED_BY_CONSENT'); return true; },
      'CRM-TS-009: cadência/disparo que tenta enviar para pessoa em opt-out precisa ser bloqueado'
    );

    // Mensagem INBOUND (recebida DO cliente) nunca é bloqueada por consentimento de saída.
    const inbound = await messagesService.createMessage(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        channel: 'WHATSAPP',
        direction: 'INBOUND',
        authorType: 'CLIENT',
        body: 'Cliente entrando em contato espontaneamente.',
      },
      tenant.userId,
      transaction
    );
    assert.ok(inbound.id);
  });
});
