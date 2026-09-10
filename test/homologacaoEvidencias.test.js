'use strict';

// Testes que cobrem, ponto a ponto, os itens de evidência pedidos pela cliente na rodada de
// homologação de 04/09/2026 sobre IPCA/IGPM (versão de regra), Clicksign/ZapSign (consulta de
// status e cancelamento) e MFA (bloqueio por tentativas falhas, sinalização de novo
// dispositivo). Ver test/billing.test.js, test/legal.contracts.test.js e
// test/finance.entries.test.js para os testes "base" já existentes de cada área — este arquivo
// não repete cobertura já feita lá, só fecha as lacunas específicas apontadas na homologação.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { authenticator } = require('otplib');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const contractsService = require('../src/features/legal/contracts.service');
const contractVersionsService = require('../src/features/legal/contractVersions.service');
const signaturesService = require('../src/features/legal/signatures.service');
const peopleService = require('../src/features/people/people.service');
const personContactsService = require('../src/features/people/personContacts.service');
const rentAdjustmentService = require('../src/features/billing/rentAdjustment.service');
const { createMockIndexSourceAdapter } = require('../src/features/billing/adapters/IndexSourceAdapter');
const mfaService = require('../src/features/users/mfa.service');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const { User } = require('../src/models');
const AppError = require('../src/utils/AppError');

// withCommittedTenantTransaction — diferente de withRollbackTenantTransaction: faz COMMIT de
// verdade. Só usado pelo teste de concorrência real abaixo (TEC-09), que precisa de duas
// transações independentes de fato concorrentes contra o MESMO registro já persistido — uma
// única transação (como o resto dos testes usa) não consegue simular concorrência real. O
// próprio teste limpa o registro criado ao final.
async function withCommittedTenantTransaction(tenantCtx, fn) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantCtx.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantCtx.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenantCtx.userId }, transaction: t });
    const result = await fn(t);
    await t.commit();
    return result;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createLeaseWithParties(transaction) {
  const suffix = uniqueSuffix();
  const contract = await contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
    tenant.userId,
    transaction
  );
  const landlord = await peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `HOMO QA Locador ${suffix}` },
    tenant.userId,
    transaction
  );
  const tenantPerson = await peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `HOMO QA Locatário ${suffix}` },
    tenant.userId,
    transaction
  );
  await personContactsService.createContact(landlord.id, { contactType: 'EMAIL', valueNormalized: `locador-${suffix}@homo.qa`, isPrimary: true }, tenant.userId, transaction);
  await personContactsService.createContact(tenantPerson.id, { contactType: 'EMAIL', valueNormalized: `locatario-${suffix}@homo.qa`, isPrimary: true }, tenant.userId, transaction);
  await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, transaction);
  await contractsService.addContractParty(contract.id, { personId: tenantPerson.id, partyRole: 'TENANT' }, tenant.userId, transaction);
  return contract;
}

async function createSignableContractVersion(transaction) {
  const contract = await createLeaseWithParties(transaction);
  await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, transaction);
  const version = await contractVersionsService.createContractVersion(
    contract.id,
    { content: `HOMO QA — corpo do contrato ${uniqueSuffix()}` },
    tenant.userId,
    transaction
  );
  await contractsService.transitionContractStatus(contract, 'LEGAL_REVIEW', tenant.userId, transaction);
  await contractsService.transitionContractStatus(contract, 'APPROVED', tenant.userId, transaction);
  await contractsService.transitionContractStatus(contract, 'SIGNING', tenant.userId, transaction);
  const parties = await contractsService.listContractParties(contract.id, transaction);
  return { contract, version, personIds: parties.map((p) => p.personId) };
}

// --- Item 1 (IPCA/IGPM): reajuste grava a versão da regra vigente, não só o cálculo ---
test('HOMO-01 reajuste aplicado grava ruleVersionId (evidência de qual versão da regra estava vigente)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseWithParties(transaction);
    const mockAdapter = createMockIndexSourceAdapter({ 'IPCA:2026-06': 0.16 });
    const adjustment = await rentAdjustmentService.requestRentAdjustment(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, indexCode: 'IPCA', period: '2026-06', oldRentAmount: 1000 },
      tenant.userId,
      transaction,
      mockAdapter
    );
    assert.equal(adjustment.status, 'APPLIED');
    assert.ok(adjustment.ruleVersionId, 'ruleVersionId não pode ser null quando REG-LOC-003 está semeada/publicada para o tenant');
  });
});

test('HOMO-01b reajuste PENDING_SOURCE também grava ruleVersionId quando a regra está publicada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseWithParties(transaction);
    const mockAdapter = createMockIndexSourceAdapter({}); // nenhuma chave cadastrada -> indisponível
    const adjustment = await rentAdjustmentService.requestRentAdjustment(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, indexCode: 'IPCA', period: '2026-06', oldRentAmount: 1000 },
      tenant.userId,
      transaction,
      mockAdapter
    );
    assert.equal(adjustment.status, 'PENDING_SOURCE');
    assert.ok(adjustment.ruleVersionId, 'mesmo indisponível, a versão da política vigente deve ficar registrada');
  });
});

// --- Item 3 (Clicksign/ZapSign): consulta de status e cancelamento ---
test('HOMO-02 assinatura grava o providerEnvelopeId e permite consultar status ativo no provedor', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { version, personIds } = await createSignableContractVersion(transaction);
    const [signature] = await signaturesService.initiateSignature(version.id, personIds, tenant.userId, transaction);
    assert.ok(signature.providerEnvelopeId, 'providerEnvelopeId precisa ser persistido para permitir consulta/cancelamento futuros');

    const { providerStatus, reconciled } = await signaturesService.checkSignatureStatus(signature.id, transaction);
    assert.equal(providerStatus.status, 'PENDING');
    assert.equal(reconciled, false);
  });
});

test('HOMO-03 cancelamento de assinatura pendente funciona, e assinatura já confirmada não pode ser cancelada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { version, personIds } = await createSignableContractVersion(transaction);
    const [signatureA, signatureB] = await signaturesService.initiateSignature(version.id, personIds, tenant.userId, transaction);

    const { signature: cancelled } = await signaturesService.cancelSignature(signatureA.id, tenant.userId, transaction);
    assert.equal(cancelled.status, 'CANCELLED');

    await signaturesService.handleSignatureWebhook(signatureB.externalSignatureId, {}, transaction);
    await assert.rejects(
      () => signaturesService.cancelSignature(signatureB.id, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_SIGNATURE_ALREADY_SIGNED');
        return true;
      }
    );
  });
});

// --- Item 4 (MFA): tentativas repetidas/falhas e novo dispositivo ---
async function createMfaEnabledUser(transaction) {
  const suffix = uniqueSuffix();
  const user = await User.create(
    { name: `HOMO QA MFA ${suffix}`, email: `homo-qa-mfa-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
    { transaction }
  );
  const { otpauthUri } = await mfaService.setupMfa(user.id, tenant, transaction);
  const secret = /[?&]secret=([^&]+)/.exec(otpauthUri)[1];
  await mfaService.confirmMfa(user.id, authenticator.generate(secret), tenant, transaction);
  return { userId: user.id, secret };
}

test('HOMO-04 MFA bloqueia após 5 tentativas seguidas de código inválido (fail closed, mesmo com código certo depois)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { userId, secret } = await createMfaEnabledUser(transaction);

    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(() => mfaService.verifyMfa(userId, '000000', tenant, transaction), (err) => {
        assert.equal(err.code, 'MFA_INVALID_CODE');
        return true;
      });
    }

    // 6ª tentativa, mesmo com o código TOTP correto, deve ser rejeitada por bloqueio.
    await assert.rejects(
      () => mfaService.verifyMfa(userId, authenticator.generate(secret), tenant, transaction),
      (err) => {
        assert.equal(err.code, 'MFA_LOCKED');
        return true;
      }
    );
  });
});

// --- AUD-008: versão de contrato sem conteúdo real não pode ser criada ---
test('AUD-008 criar versão de contrato com content vazio/só espaço é rejeitado (não gera hash de documento vazio)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseWithParties(transaction);
    await assert.rejects(
      () => contractVersionsService.createContractVersion(contract.id, { content: '' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_VERSION_VALIDATION');
        return true;
      }
    );
    await assert.rejects(
      () => contractVersionsService.createContractVersion(contract.id, { content: '   ' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_VERSION_VALIDATION');
        return true;
      }
    );
    // conteúdo real continua funcionando normalmente.
    const version = await contractVersionsService.createContractVersion(contract.id, { content: 'Texto real do contrato' }, tenant.userId, transaction);
    assert.ok(version.contentHash);
  });
});

// --- AUD-004: correção auditada de dados já gravados do contrato ---
test('AUD-004 correctContractData exige motivo, bloqueia campos não permitidos e audita a correção', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseWithParties(transaction);

    await assert.rejects(
      () => contractsService.correctContractData(contract.id, { startsAt: '2026-09-09T12:00:00.000Z' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_CORRECTION_VALIDATION');
        return true;
      }
    );

    await assert.rejects(
      () => contractsService.correctContractData(contract.id, { status: 'ACTIVE', reason: 'tentando burlar a máquina de estados' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_CORRECTION_FIELD_NOT_ALLOWED');
        return true;
      }
    );

    const corrected = await contractsService.correctContractData(
      contract.id,
      { startsAt: '2026-09-09T12:00:00.000Z', endsAt: '2027-09-09T12:00:00.000Z', reason: 'Vigência informada errada na criação' },
      tenant.userId,
      transaction
    );
    assert.equal(new Date(corrected.startsAt).toISOString(), '2026-09-09T12:00:00.000Z');
    assert.equal(new Date(corrected.endsAt).toISOString(), '2027-09-09T12:00:00.000Z');
  });
});

test('HOMO-05 verificação MFA de origem/dispositivo diferente é sinalizada (isNewDevice), sem bloquear a ação', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { userId, secret } = await createMfaEnabledUser(transaction);

    const first = await mfaService.verifyMfa(userId, authenticator.generate(secret), tenant, transaction, {
      ip: '203.0.113.10',
      userAgent: 'HomoQA/1.0 (primeiro dispositivo)',
    });
    assert.equal(first.isNewDevice, false, 'primeira verificação não tem "última origem conhecida" para comparar');

    const second = await mfaService.verifyMfa(userId, authenticator.generate(secret), tenant, transaction, {
      ip: '198.51.100.20',
      userAgent: 'HomoQA/1.0 (segundo dispositivo)',
    });
    assert.equal(second.isNewDevice, true, 'origem diferente da última conhecida deve ser sinalizada');

    const third = await mfaService.verifyMfa(userId, authenticator.generate(secret), tenant, transaction, {
      ip: '198.51.100.20',
      userAgent: 'HomoQA/1.0 (segundo dispositivo)',
    });
    assert.equal(third.isNewDevice, false, 'mesma origem da verificação anterior não deve ser sinalizada de novo');
  });
});

// --- TEC-09: concorrência real em liquidação de lançamento financeiro ---
test('TEC-09 duas liquidações simultâneas do mesmo lançamento: só uma tem sucesso (lockVersion otimista)', async () => {
  const tenantCtx = tenant;
  const entry = await withCommittedTenantTransaction(tenantCtx, (t) =>
    financialEntriesService.createFinancialEntry(
      { groupId: tenantCtx.groupId, companyId: tenantCtx.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 500, description: 'TEC-09 concorrência (teste automatizado)' },
      tenantCtx.userId,
      t
    )
  );

  try {
    const results = await Promise.allSettled([
      withCommittedTenantTransaction(tenantCtx, (t) => financialEntriesService.settleFinancialEntry(entry.id, tenantCtx.userId, t)),
      withCommittedTenantTransaction(tenantCtx, (t) => financialEntriesService.settleFinancialEntry(entry.id, tenantCtx.userId, t)),
    ]);

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    assert.equal(succeeded, 1, 'exatamente uma das duas tentativas simultâneas deve ter sucesso');
    assert.equal(failed, 1, 'a outra deve falhar (conflito de versão ou status já SETTLED) — nunca as duas passarem');
  } finally {
    // Limpeza: este teste precisa de commit real (concorrência de verdade não é simulável numa
    // única transação), então remove explicitamente o registro criado — nunca fica no banco.
    await sequelize.query('DELETE FROM finance.financial_entries WHERE id = :id', { replacements: { id: entry.id } });
  }
});
