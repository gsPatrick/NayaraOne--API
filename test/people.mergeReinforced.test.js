'use strict';

// Item 1 do ciclo de auditoria externa (Marco 3). Contrato bruto — Caderno Pessoas/Imóveis/
// CRM/Radar §29 ("Merge seguro de Pessoas"):
//   "1. Detectar possível duplicidade e abrir merge_case."
//   "2. Bloquear merge automático se houver conflito de CPF/CNPJ, contratos ativos
//       incompatíveis ou restrição jurídica."
//   "4. Criar snapshot das duas pessoas e referências afetadas."
//   "8. Gerar evento person.merged e audit log com mapa de referências."
//   "9. Permitir reversão somente por processo técnico supervisionado; nunca botão comum."
//
// Até este ciclo, mergePersons só bloqueava conflito de documento — este teste prova: abertura
// de merge_case (registrado em audit_log), bloqueio por contrato ativo compartilhado entre as
// duas pessoas, snapshot completo (não só ids), mapa de referências remapeadas no evento/
// auditoria, e a reversão supervisionada (função separada, com reason obrigatório).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const personService = require('../src/features/people/person.service');
const { mergePersons, reverseMergeSupervised } = require('../src/features/people/personMerge.service');
const { AuditLog, OutboxEvent, Contract, ContractParty } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('mergePersons abre merge_case em audit_log ANTES de qualquer checagem de conflito', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const canonical = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Canônica MergeCase ${suffix}` },
      tenant.userId,
      transaction
    );
    const absorbed = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Absorvida MergeCase ${suffix}` },
      tenant.userId,
      transaction
    );

    await mergePersons(canonical.id, absorbed.id, tenant.userId, transaction);

    const mergeCase = await AuditLog.findOne({
      where: { action: 'person.merge_case.opened', entityId: canonical.id },
      transaction,
    });
    assert.ok(mergeCase, 'abertura de merge_case precisa estar registrada mesmo quando o merge é bem-sucedido');
    assert.equal(mergeCase.afterJson.absorbedId, absorbed.id);
  });
});

test('mergePersons bloqueia quando as duas pessoas são partes do MESMO contrato ATIVO (contratos ativos incompatíveis)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const personA = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Parte A Contrato ${suffix}` },
      tenant.userId,
      transaction
    );
    const personB = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Parte B Contrato ${suffix}` },
      tenant.userId,
      transaction
    );

    const contract = await Contract.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractType: 'SALE',
        contractNumber: `MERGE-TST-${suffix}`,
        status: 'ACTIVE',
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );
    await ContractParty.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, personId: personA.id, partyRole: 'BUYER', createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    await ContractParty.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, personId: personB.id, partyRole: 'SELLER', createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );

    await assert.rejects(
      () => mergePersons(personA.id, personB.id, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'PERSON_MERGE_CONFLICT_ACTIVE_CONTRACT'); return true; },
      'comprador e vendedor do MESMO contrato ativo nunca podem ser fundidos em uma pessoa só'
    );
  });
});

test('mergePersons grava snapshot COMPLETO das duas pessoas e mapa de referências remapeadas (evento person.merged + audit_log)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const canonical = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Canônica Snapshot ${suffix}` },
      tenant.userId,
      transaction
    );
    const absorbed = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Absorvida Snapshot ${suffix}` },
      tenant.userId,
      transaction
    );

    const result = await mergePersons(canonical.id, absorbed.id, tenant.userId, transaction);
    assert.ok(result.remappedReferences, 'resultado do merge precisa incluir o mapa de referências remapeadas');

    const event = await OutboxEvent.findOne({ where: { eventType: 'person.merged', aggregateId: canonical.id }, transaction });
    assert.ok(event, 'evento person.merged precisa ter sido publicado');
    assert.ok(event.payloadJson.remappedReferences || event.payload || true); // tolera nome exato da coluna json
    const eventPayload = event.payloadJson || event.payload;
    assert.ok(eventPayload.remappedReferences, 'payload do evento precisa trazer o mapa de referências');

    const finalAudit = await AuditLog.findOne({ where: { action: 'person.merge', entityId: canonical.id }, transaction });
    assert.ok(finalAudit, 'auditoria final do merge precisa existir');
    assert.ok(finalAudit.beforeJson.canonical, 'snapshot precisa conter o estado completo da pessoa canônica');
    assert.ok(finalAudit.beforeJson.absorbed, 'snapshot precisa conter o estado completo da pessoa absorvida');
    assert.equal(finalAudit.beforeJson.canonical.legalName, canonical.legalName);
    assert.ok(finalAudit.afterJson.remappedReferences, 'audit_log final precisa conter o mapa de referências remapeadas');
  });
});

test('reverseMergeSupervised exige reason real e nunca é um "desfazer" trivial; sem reason, rejeita', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const canonical = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Canônica Reversao ${suffix}` },
      tenant.userId,
      transaction
    );
    const absorbed = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Absorvida Reversao ${suffix}` },
      tenant.userId,
      transaction
    );

    await mergePersons(canonical.id, absorbed.id, tenant.userId, transaction);

    await assert.rejects(
      () => reverseMergeSupervised(canonical.id, absorbed.id, '', tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'PERSON_MERGE_REVERSAL_REASON_REQUIRED'); return true; }
    );
    await assert.rejects(
      () => reverseMergeSupervised(canonical.id, absorbed.id, 'erro', tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'PERSON_MERGE_REVERSAL_REASON_REQUIRED'); return true; },
      'reason curta/trivial também precisa ser rejeitada'
    );

    const reversed = await reverseMergeSupervised(
      canonical.id,
      absorbed.id,
      'Merge revertido por processo técnico supervisionado: cliente comprovou que são pessoas distintas (RG anexado ao ticket 12345).',
      tenant.userId,
      transaction
    );
    assert.equal(reversed.status, 'ACTIVE');

    const auditEntry = await AuditLog.findOne({ where: { action: 'person.merge.reversed_supervised', entityId: absorbed.id }, transaction });
    assert.ok(auditEntry, 'reversão supervisionada precisa gerar sua própria trilha de auditoria distinta');
  });
});
