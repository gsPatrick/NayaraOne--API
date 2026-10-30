'use strict';

// M9-D809 — AUD-020 (JUR-014): evento como integração. Contrato assinado (término vira item de renovação), prazo jurídico e entrega de chaves publicam o seu evento no outbox, na transação
// da operação; o calendário cria o item uma única vez, mesmo com replay. Banco descartável, dentro de transação com rollback.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d802Env');
const origin = require('../_helpers/m9d802Origins');
const { locacaoAtiva } = require('../_helpers/m9d809Lease');
const guaranteesService = require('../../../src/features/legal/guarantees.service');
const keyDeliveriesService = require('../../../src/features/legal/keyDeliveries.service');
const deadlines = require('../../../src/features/legal/legalDeadlines.service');
const { publishContractRenewalChange } = require('../../../src/features/legal/legalDeadlineCalendarEvents.service');
const { OutboxEvent } = require('../../../src/models');

require('../../../src/features/core-governance'); // carrega o módulo como em produção: registra o projetor no outbox
let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });

const publicados = (aggregateId, eventType, tx) => OutboxEvent.count({ where: { aggregateId, eventType }, transaction: tx });

test('m9d809 AUD-020 evento de contrato assinado, chaves entregues e prazo gera item de calendário uma única vez, mesmo em replay', { skip: skip() }, async () => {
  const t = tenants.A;
  await env.withRollbackTenantTransaction(t, async (tx) => {
    const { contract, inspection, tenantPerson } = await locacaoAtiva(t, tx, { status: 'SIGNED', endsAt: '2028-06-30' });
    await guaranteesService.createGuarantee(contract.id, { guaranteeType: 'DEPOSIT', value: 500, status: 'ACTIVE' }, t.userId, tx);

    // contrato assinado -> renovação; prazo jurídico -> prazo; chaves -> keys.delivered (e legal.key_delivery.released)
    const renovacao = await publishContractRenewalChange(contract, tx);
    assert.ok(renovacao, 'contrato assinado com término publica o evento de renovação');
    const lc = await origin.legalCase(t, tx);
    const prazo = await deadlines.createLegalDeadline(lc.id, { description: 'Contestação QA-M9', dueAt: origin.future(10), sourceEvent: 'teste', responsibleUserId: t.userId }, t.userId, tx);
    const entrega = await keyDeliveriesService.createKeyDelivery({ groupId: t.groupId, companyId: t.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: tenantPerson.id }, t.userId, tx);
    await keyDeliveriesService.releaseKeyDelivery(entrega.id, { keysCount: 2, termSignedByPersonId: tenantPerson.id }, t.userId, tx);

    // cada operação publicou o seu evento UMA vez, na mesma transação
    assert.equal(await publicados(contract.id, 'contract.renewal.upserted', tx), 1);
    assert.equal(await publicados(prazo.id, 'legal.deadline.created', tx), 1);
    assert.equal(await publicados(entrega.id, 'keys.delivered', tx), 1);
    assert.equal(await publicados(entrega.id, 'legal.key_delivery.released', tx), 1);

    // o calendário projeta: um item de renovação do contrato e um do prazo
    const entregues = await env.drain(t, tx);
    assert.ok(entregues.some((e) => e.eventType === 'keys.delivered'), 'o evento das chaves também passa pelo despachante');
    assert.equal(await env.countItems(t, 'RENEWAL', contract.id, tx), 1);
    assert.equal(await env.countItems(t, 'LEGAL_DEADLINE', prazo.id, tx), 1);
    const itemContrato = await env.itemOf(t, 'RENEWAL', contract.id, tx);
    assert.equal(itemContrato.source_kind, 'CONTRACT_RENEWAL');
    assert.equal(itemContrato.status, 'OPEN');
    const itemPrazo = await env.itemOf(t, 'LEGAL_DEADLINE', prazo.id, tx);
    assert.equal(itemPrazo.status, 'OPEN');
    const [versaoContrato, versaoPrazo] = [itemContrato.projection_version, itemPrazo.projection_version];

    // replay: reentregar os mesmos eventos (mesmo event_id e id novo com o mesmo conteúdo) não duplica nem sobe a versão
    for (const e of await OutboxEvent.findAll({ where: { companyId: t.companyId, eventType: ['contract.renewal.upserted', 'legal.deadline.created'] }, transaction: tx })) {
      const copia = { id: e.id, eventType: e.eventType, groupId: e.groupId, companyId: e.companyId, occurredAt: e.occurredAt || e.createdAt || new Date('2026-10-20T12:00:00Z'), payloadJson: e.payloadJson };
      assert.equal((await env.projectEvent(copia, tx)).duplicate, true, `${e.eventType}: o mesmo event_id é duplicado`);
      await env.projectEvent({ ...copia, id: env.randomUUID() }, tx);
    }
    await env.drain(t, tx);
    assert.equal(await env.countItems(t, 'RENEWAL', contract.id, tx), 1);
    assert.equal(await env.countItems(t, 'LEGAL_DEADLINE', prazo.id, tx), 1);
    assert.equal((await env.itemOf(t, 'RENEWAL', contract.id, tx)).projection_version, versaoContrato);
    assert.equal((await env.itemOf(t, 'LEGAL_DEADLINE', prazo.id, tx)).projection_version, versaoPrazo);
    // as chaves entregues não são fonte do calendário no livro: o evento é publicado uma vez e não cria item
    assert.equal(await env.countItems(t, 'RENEWAL', entrega.id, tx) + await env.countItems(t, 'LEGAL_DEADLINE', entrega.id, tx), 0);
  });
});
