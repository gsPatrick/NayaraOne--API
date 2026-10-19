'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const contractsService = require('../src/features/legal/contracts.service');
const guaranteesService = require('../src/features/legal/guarantees.service');
const inspectionsService = require('../src/features/legal/inspections.service');
const keyDeliveriesService = require('../src/features/legal/keyDeliveries.service');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createActiveLeaseWithInspection(transaction) {
  const suffix = uniqueSuffix();
  const property = await propertiesService.createProperty(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      propertyType: 'RESIDENTIAL',
      title: `KD QA ${suffix}`,
      internalCode: `KDQA-${suffix}`,
    },
    tenant.userId,
    transaction
  );
  const contract = await contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', propertyId: property.id, totalValue: 1000 },
    tenant.userId,
    transaction
  );
  contract.status = 'ACTIVE';
  await contract.save({ transaction });

  const landlord = await peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `KD QA Locador ${suffix}` },
    tenant.userId,
    transaction
  );
  const tenantPerson = await peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `KD QA Locatário ${suffix}` },
    tenant.userId,
    transaction
  );
  await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, transaction);
  await contractsService.addContractParty(contract.id, { personId: tenantPerson.id, partyRole: 'TENANT' }, tenant.userId, transaction);

  const inspection = await inspectionsService.createInspection(
    { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, contractId: contract.id, inspectionType: 'CHECK_IN' },
    tenant.userId,
    transaction
  );
  await inspectionsService.completeInspection(inspection.id, tenant.userId, transaction);
  await inspectionsService.signInspection(inspection.id, { partyRole: 'LANDLORD', signaturePayload: 'kd-qa-locador' }, tenant.userId, transaction);
  await inspectionsService.signInspection(inspection.id, { partyRole: 'TENANT', signaturePayload: 'kd-qa-locatario' }, tenant.userId, transaction);

  return { contract, inspection, landlord, tenantPerson };
}

// Caderno Anexo I "10. Entrega de chaves": "Exigir documentos e garantias válidos."
// ACHADO REAL (auditoria técnica independente da Nayara, A04): o job que marca garantia vencida
// como EXPIRED roda periodicamente — entre o vencimento real (endsAt no passado) e o job rodar,
// o status no banco ainda podia estar ACTIVE, liberando a chave indevidamente. Reproduz
// exatamente o cenário do achado: startsAt=2019-01-01, endsAt=2020-01-01, status ainda ACTIVE.
test('releaseKeyDelivery bloqueia garantia com endsAt vencido mesmo com status ainda ACTIVE (A04)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'DEPOSIT', value: 500, status: 'ACTIVE', startsAt: '2019-01-01', endsAt: '2020-01-01' },
      tenant.userId,
      transaction
    );
    const keyDelivery = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: tenantPerson.id },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => keyDeliveriesService.releaseKeyDelivery(keyDelivery.id, { keysCount: 1, termSignedByPersonId: tenantPerson.id }, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_KEY_DELIVERY_GUARANTEE_INVALID');
        return true;
      }
    );
  });
});

test('releaseKeyDelivery bloqueia quando existe garantia cadastrada mas nenhuma ACTIVE', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'DEPOSIT', value: 500, status: 'CANCELLED' },
      tenant.userId,
      transaction
    );
    const keyDelivery = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: tenantPerson.id },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => keyDeliveriesService.releaseKeyDelivery(keyDelivery.id, { keysCount: 1, termSignedByPersonId: tenantPerson.id }, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_KEY_DELIVERY_GUARANTEE_INVALID');
        return true;
      }
    );
  });
});

test('releaseKeyDelivery libera normalmente com garantia ACTIVE válida', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'DEPOSIT', value: 500, status: 'ACTIVE' },
      tenant.userId,
      transaction
    );
    const keyDelivery = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: tenantPerson.id },
      tenant.userId,
      transaction
    );

    const released = await keyDeliveriesService.releaseKeyDelivery(
      keyDelivery.id,
      { keysCount: 3, keysIdentification: '2 chaves + 1 controle', termSignedByPersonId: tenantPerson.id },
      tenant.userId,
      transaction
    );
    assert.equal(released.status, 'RELEASED');
    assert.equal(released.keysCount, 3);
    assert.equal(released.termSignedByPersonId, tenantPerson.id);
    assert.ok(released.termSignedAt);

    // GAP REAL (verificação cética Marco 5, ciclo 4): o model KeyDelivery nunca declarava
    // keysCount/keysIdentification/photosFileIds/termType/termSignedByPersonId/termSignedAt —
    // a atribuição na instância passava na asserção acima mesmo sem persistir nada de verdade
    // (Sequelize só grava atributo declarado). Reler do banco é o que de fato prova o fix.
    const reloaded = await keyDeliveriesService.getKeyDelivery(keyDelivery.id, transaction);
    assert.equal(reloaded.keysCount, 3);
    assert.equal(reloaded.keysIdentification, '2 chaves + 1 controle');
    assert.equal(reloaded.termSignedByPersonId, tenantPerson.id);
    assert.ok(reloaded.termSignedAt);
  });
});

// Caderno Anexo I "10. Entrega de chaves": "Registrar quantidade/identificação de
// chaves/controles", "Assinatura do termo de entrega."
test('releaseKeyDelivery exige keysCount e termSignedByPersonId (JUR-TS-004 "Chave cedo")', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    const keyDelivery = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: tenantPerson.id },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => keyDeliveriesService.releaseKeyDelivery(keyDelivery.id, { termSignedByPersonId: tenantPerson.id }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_KEY_DELIVERY_VALIDATION');
        return true;
      },
      'sem keysCount, não pode liberar'
    );

    await assert.rejects(
      () => keyDeliveriesService.releaseKeyDelivery(keyDelivery.id, { keysCount: 2 }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_KEY_DELIVERY_VALIDATION');
        return true;
      },
      'sem termSignedByPersonId (assinatura do termo), não pode liberar'
    );
  });
});

// Frente 5: a política de fotos é do SERVIDOR (imóvel usado exige fotos); o cliente não manda
// mais "photosRequired" — se mandar, 400 LEGAL_KEY_DELIVERY_SERVER_POLICY.
test('releaseKeyDelivery exige fotos quando a política do servidor exige (imóvel usado)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    const keyDelivery = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: tenantPerson.id, termType: 'USED_PROPERTY_DELIVERY' },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => keyDeliveriesService.releaseKeyDelivery(keyDelivery.id, { keysCount: 1, termSignedByPersonId: tenantPerson.id, photosRequired: false }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_KEY_DELIVERY_SERVER_POLICY');
        return true;
      }
    );

    await assert.rejects(
      () =>
        keyDeliveriesService.releaseKeyDelivery(
          keyDelivery.id,
          { keysCount: 1, termSignedByPersonId: tenantPerson.id },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'LEGAL_KEY_DELIVERY_PHOTOS_REQUIRED');
        return true;
      }
    );

    const released = await keyDeliveriesService.releaseKeyDelivery(
      keyDelivery.id,
      { keysCount: 1, termSignedByPersonId: tenantPerson.id, photosFileIds: ['11111111-1111-1111-1111-111111111111'] },
      tenant.userId,
      transaction
    );
    assert.equal(released.status, 'RELEASED');
    assert.equal(released.photosRequired, true);
    assert.equal(released.photoPolicy, 'REQUIRED_USED_PROPERTY');
  });
});

// F6 (auditoria M45, 19/10/2026): recebedor e signatário precisam ser partes do contrato.
test('F6: createKeyDelivery recusa recebedor que não é parte do contrato (400)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection } = await createActiveLeaseWithInspection(transaction);
    const outsider = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `KD QA Estranho ${uniqueSuffix()}` },
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => keyDeliveriesService.createKeyDelivery(
        { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: outsider.id },
        tenant.userId,
        transaction
      ),
      (err) => err.statusCode === 400 && err.code === 'LEGAL_KEY_DELIVERY_RECIPIENT_NOT_PARTY'
    );
  });
});

test('F6: releaseKeyDelivery recusa signatário que não é parte do contrato (400)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    const outsider = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `KD QA Estranho ${uniqueSuffix()}` },
      tenant.userId,
      transaction
    );
    const kd = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: tenantPerson.id },
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => keyDeliveriesService.releaseKeyDelivery(kd.id, { keysCount: 2, termSignedByPersonId: outsider.id }, tenant.userId, transaction),
      (err) => err.statusCode === 400 && err.code === 'LEGAL_KEY_DELIVERY_TERM_SIGNER_INVALID'
    );
  });
});

// F7: prévia do termo antes de liberar e termo gravado depois.
test('F7: prévia do termo KD-TERM-v2 antes de liberar e termo gravado com hash depois', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, landlord, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    const kd = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: tenantPerson.id },
      tenant.userId,
      transaction
    );
    const prev = await keyDeliveriesService.previewKeyDeliveryTerm(kd.id, { keysCount: '3', termSignedByPersonId: landlord.id }, transaction);
    assert.equal(prev.preview, true);
    assert.equal(prev.termVersion, 'KD-TERM-v2');
    assert.match(prev.termText, /TERMO DE ENTREGA DE CHAVES/);
    assert.match(prev.termText, /Quantidade entregue: 3 chaves\/controles/);
    assert.match(prev.termText, /PRÉVIA/);
    await keyDeliveriesService.releaseKeyDelivery(kd.id, { keysCount: 3, termSignedByPersonId: landlord.id }, tenant.userId, transaction);
    const after = await keyDeliveriesService.previewKeyDeliveryTerm(kd.id, {}, transaction);
    assert.equal(after.preview, false);
    assert.match(after.termHash, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(after.termText, /PRÉVIA/);
  });
});

// KD-TERM-v2 (M45 19/10/2026): texto 100% humano — sem UUID, sem ENUM, sem data ISO.
function randomCpf() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const dv = (arr) => { const f = arr.length + 1; const r = (arr.reduce((acc, d, i) => acc + d * (f - i), 0) * 10) % 11; return r === 10 ? 0 : r; };
  n.push(dv(n)); n.push(dv(n));
  return n.join('');
}
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
test('KD-TERM-v2: termo humano (rótulo do tipo, imóvel por nome, política em frase, CPF formatado, data BR) e hash', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, landlord, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    const cpf = randomCpf();
    const cpfFmt = `${cpf.slice(0, 3)}\\.${cpf.slice(3, 6)}\\.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
    await sequelize.query('UPDATE people.persons SET tax_id_normalized = :cpf WHERE id = :id', { replacements: { cpf, id: landlord.id }, transaction });
    const kd = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: tenantPerson.id },
      tenant.userId,
      transaction
    );
    const prev = await keyDeliveriesService.previewKeyDeliveryTerm(kd.id, { keysCount: '1', termSignedByPersonId: landlord.id }, transaction);
    assert.equal(prev.termVersion, 'KD-TERM-v2');
    assert.doesNotMatch(prev.termText, UUID_RE);
    assert.match(prev.termText, /Locação/);
    assert.doesNotMatch(prev.termText, /\bLEASE\b|NOT_REQUIRED|REQUIRED_|CHECK_IN|LANDLORD|TENANT/);
    assert.match(prev.termText, /Imóvel: KD QA /);
    assert.match(prev.termText, /Fotos não obrigatórias nesta entrega/);
    assert.match(prev.termText, /1 chave\/controle\b/);
    assert.match(prev.termText, new RegExp(`CPF ${cpfFmt}`));
    assert.match(prev.termText, /Locatário\(a\) no contrato/);
    assert.match(prev.termText, /concluída em \d{2}\/\d{2}\/\d{4}/);

    const released = await keyDeliveriesService.releaseKeyDelivery(kd.id, { keysCount: 1, keysIdentification: 'Porta principal', termSignedByPersonId: landlord.id }, tenant.userId, transaction);
    assert.equal(released.termVersion, 'KD-TERM-v2');
    assert.doesNotMatch(released.termText, UUID_RE);
    assert.doesNotMatch(released.termText, /\d{4}-\d{2}-\d{2}T/);
    assert.match(released.termText, new RegExp(`Assinado por KD QA Locador .* \\(CPF ${cpfFmt}\\) — Locador\\(a\\) no contrato em \\d{2}/\\d{2}/\\d{4} às \\d{2}:\\d{2}`));
    const crypto = require('crypto');
    assert.equal(released.termHash, crypto.createHash('sha256').update(released.termText, 'utf8').digest('hex'));
  });
});

test('KD-TERM-v2: rótulo de venda com permuta e formatação de CNPJ', () => {
  const policy = keyDeliveriesService.resolveKeyDeliveryPhotoPolicy({ contractType: 'SALE_TRADE' }, { termType: null });
  const text = keyDeliveriesService.buildKeyDeliveryTermV2({
    contract: { contractNumber: 'VEN-2026-0007', contractType: 'SALE_TRADE', startsAt: '2026-03-05T12:00:00Z' },
    keyDelivery: { termType: null },
    keysCount: 2,
    keysIdentification: null,
    checkIn: null,
    policy,
    signedAt: null,
    ctx: { propertyText: 'Casa Azul, Rua A, 10 — Centro — Goiânia/GO', recipientText: 'Fulano (CNPJ 11.222.333/0001-81)', signerText: null, checkInDate: null },
  });
  assert.match(text, /Contrato: VEN-2026-0007 — Venda com permuta \(início em 05\/03\/2026\)/);
  assert.match(text, /Fotos obrigatórias: por se tratar de entrega de imóvel vendido/);
  assert.equal(keyDeliveriesService.formatTaxId('11222333000181'), 'CNPJ 11.222.333/0001-81');
});

test('KD-TERM-v1 continua válido: termo já gravado em v1 é devolvido intacto (texto e hash)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, landlord, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    const kd = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: tenantPerson.id },
      tenant.userId,
      transaction
    );
    await keyDeliveriesService.releaseKeyDelivery(kd.id, { keysCount: 2, termSignedByPersonId: landlord.id }, tenant.userId, transaction);
    // simula um termo legado gravado em v1
    const legacyText = 'TERMO DE ENTREGA DE CHAVES (KD-TERM-v1)\nContrato: X (LEASE)';
    const legacyHash = require('crypto').createHash('sha256').update(legacyText, 'utf8').digest('hex');
    await sequelize.query('UPDATE legal.key_deliveries SET term_text = :t, term_version = :v, term_hash = :h WHERE id = :id', {
      replacements: { t: legacyText, v: 'KD-TERM-v1', h: legacyHash, id: kd.id }, transaction,
    });
    const view = await keyDeliveriesService.previewKeyDeliveryTerm(kd.id, {}, transaction);
    assert.equal(view.termVersion, 'KD-TERM-v1');
    assert.equal(view.termText, legacyText);
    assert.equal(view.termHash, legacyHash);
  });
});

test('M45: cancelamento de entrega de chaves exige motivo, é auditado e bloqueia liberação', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, landlord, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    const kd = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: tenantPerson.id },
      tenant.userId,
      transaction
    );
    await assert.rejects(() => keyDeliveriesService.cancelKeyDelivery(kd.id, { reason: '' }, tenant.userId, transaction),
      (err) => err.statusCode === 400 && err.code === 'LEGAL_KEY_DELIVERY_CANCEL_REASON_REQUIRED');
    const cancelled = await keyDeliveriesService.cancelKeyDelivery(kd.id, { reason: 'Recebedor não é parte do contrato' }, tenant.userId, transaction);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.cancelReason, 'Recebedor não é parte do contrato');
    const [rows] = await sequelize.query(
      "SELECT reason FROM audit.audit_log WHERE entity_id = :id AND action = 'legal.key_delivery.cancel'",
      { replacements: { id: kd.id }, transaction }
    );
    assert.equal(rows.length, 1);
    await assert.rejects(() => keyDeliveriesService.releaseKeyDelivery(kd.id, { keysCount: 1, termSignedByPersonId: landlord.id }, tenant.userId, transaction),
      (err) => err.statusCode === 409 && err.code === 'LEGAL_KEY_DELIVERY_CANCELLED');
    await assert.rejects(() => keyDeliveriesService.cancelKeyDelivery(kd.id, { reason: 'de novo, outra vez' }, tenant.userId, transaction),
      (err) => err.statusCode === 409);
  });
});
