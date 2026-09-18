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
const usersService = require('../src/features/users/users.service');
const commissionsService = require('../src/features/finance/commissions.service');
const { registrarAuditoria } = require('../src/engines/audit/auditLog.service');
const { publishDomainEvent } = require('../src/engines/events/outbox');
const { dispatchPendingEventsForCompany } = require('../src/engines/events/outbox-dispatcher');
const { runWithCorrelationId } = require('../src/middlewares/correlationId.middleware');
const { withTimeout, HEALTH_CHECK_TIMEOUT_MS } = require('../src/features/health/health.controller');
const authService = require('../src/features/auth/auth.service');
const { authMiddleware } = require('../src/middlewares/auth.middleware');
const { User, Session, Group, Company, AuditLog, File } = require('../src/models');
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
  // FIX AUD-008 (14/09/2026): assertDocumentGate agora exige um File real anexado
  // (documentFileId), não só um "content" textual — este teste precisa simular o mesmo caminho
  // que um caso real de produção seguiria (documento efetivamente carregado).
  const file = await File.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      storageKey: `homo-qa/contracts/${uniqueSuffix()}.pdf`,
      fileName: `contrato-${uniqueSuffix()}.pdf`,
      mimeType: 'application/pdf',
      uploadedByUserId: tenant.userId,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
  const version = await contractVersionsService.createContractVersion(
    contract.id,
    { content: `HOMO QA — corpo do contrato ${uniqueSuffix()}`, documentFileId: file.id },
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
    // M5-07: a criação de versão passou a exigir documentFileId por padrão. Este teste é sobre
    // a validação de `content` (AUD-008), então mantemos o cenário sem arquivo com o override
    // explícito `requireDocument: false` — o que está sob teste aqui é o conteúdo, não o gate
    // de documento (esse tem teste próprio em marco5.legal.test.js).
    const version = await contractVersionsService.createContractVersion(contract.id, { content: 'Texto real do contrato', requireDocument: false }, tenant.userId, transaction);
    assert.ok(version.contentHash);
  });
});

// --- AUD-2026-09-14: lançamento financeiro não pode aceitar um ano de vencimento absurdo
// (reportado pela cliente: sistema aceitou vencimento no ano "92026") ---
test('AUD financeiro rejeita dueAt com ano absurdo (ex.: 92026, dígito extra por engano) tanto na criação quanto na edição', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () =>
        financialEntriesService.createFinancialEntry(
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            entryType: 'DEBIT',
            nature: 'PAYABLE',
            amount: 100,
            dueAt: '92026-09-20',
          },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'FINANCE_ENTRY_VALIDATION');
        return true;
      }
    );

    // Data plausível continua funcionando normalmente.
    const entry = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        entryType: 'DEBIT',
        nature: 'PAYABLE',
        amount: 100,
        dueAt: '2026-09-20',
      },
      tenant.userId,
      transaction
    );
    assert.ok(entry.id);

    // Edição também precisa recusar o mesmo tipo de valor absurdo.
    await assert.rejects(
      () => financialEntriesService.updateFinancialEntry(entry.id, { dueAt: '92026-09-20' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_ENTRY_VALIDATION');
        return true;
      }
    );
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

// --- TEC-08: correlation ID amarra auditoria e evento à requisição que os originou ---
test('TEC-08 registrarAuditoria e publishDomainEvent gravam o correlationId da requisição em curso', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const correlationId = 'c0ffee00-0000-4000-8000-000000000001';
    const { auditRow, outboxRow } = await runWithCorrelationId(correlationId, async () => {
      const audit = await registrarAuditoria(
        {
          groupId: tenant.groupId,
          companyId: tenant.companyId,
          actorUserId: tenant.userId,
          action: 'homologacao.tec08_test',
          entityType: 'User',
          entityId: tenant.userId,
          reason: 'Teste automatizado TEC-08.',
        },
        transaction
      );
      const outbox = await publishDomainEvent(
        {
          groupId: tenant.groupId,
          companyId: tenant.companyId,
          aggregateType: 'User',
          aggregateId: tenant.userId,
          eventType: 'homologacao.tec08_test',
          payload: {},
          idempotencyKey: `homologacao.tec08_test:${uniqueSuffix()}`,
        },
        transaction
      );
      return { auditRow: audit, outboxRow: outbox };
    });

    assert.equal(auditRow.correlationId, correlationId, 'auditoria deve herdar o correlationId do contexto ativo, sem precisar que o chamador passe manualmente');
    assert.equal(outboxRow.correlationId, correlationId, 'evento do outbox deve herdar o mesmo correlationId');
  });
});

// --- TEC-12: suspender/excluir usuário revoga sessões ativas imediatamente ---
test('TEC-12 suspender um usuário revoga imediatamente todas as sessões ativas dele', async () => {
  const suffix = uniqueSuffix();
  const user = await User.create({
    name: `HOMO QA TEC-12 ${suffix}`,
    email: `homo-qa-tec12-${suffix}@nayaraone.dev`,
    passwordHash: 'x',
    status: 'ACTIVE',
  });
  const session = await withCommittedTenantTransaction(tenant, (t) =>
    Session.create(
      {
        userId: user.id,
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        refreshTokenHash: `fake-hash-${suffix}`,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      { transaction: t }
    )
  );

  try {
    assert.equal(session.revokedAt, null);

    await usersService.updateUser(user.id, { status: 'SUSPENDED' }, tenant.userId, {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
    });

    await withCommittedTenantTransaction(tenant, (t) => session.reload({ transaction: t }));
    assert.ok(session.revokedAt, 'sessão deve ser revogada assim que o usuário é suspenso — nunca continuar válida até expirar naturalmente');
  } finally {
    await withCommittedTenantTransaction(tenant, (t) => session.destroy({ force: true, transaction: t })).catch(() => {});
    await user.destroy({ force: true }).catch(() => {});
  }
});

// --- TEC-06/TEC-07: despachante do outbox processa por tenant e é RLS-safe ---
test('TEC-06/TEC-07 dispatchPendingEventsForCompany processa eventos PENDING do tenant e marca DISPATCHED', async () => {
  const idempotencyKey = `homologacao.tec06_test:${uniqueSuffix()}`;

  // Precisa de COMMIT real: dispatchPendingEventsForCompany abre sua própria transação (é
  // assim que roda em produção, fora de qualquer request HTTP) — dado gravado numa transação
  // que só existe pra ser revertida nunca seria visível pra ela (isolamento de transação).
  const t = await sequelize.transaction();
  let eventRow;
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
    eventRow = await publishDomainEvent(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        aggregateType: 'User',
        aggregateId: tenant.userId,
        eventType: 'homologacao.tec06_test',
        payload: {},
        idempotencyKey,
      },
      t
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  try {
    const group = await Group.findByPk(tenant.groupId);
    const company = await sequelize.transaction((ct) =>
      sequelize
        .query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: ct })
        .then(() => Company.findByPk(tenant.companyId, { transaction: ct }))
    );
    const result = await dispatchPendingEventsForCompany(group, company, { limit: 500 });
    assert.ok(result.dispatched >= 1, 'deve despachar ao menos o evento recém-criado deste teste');
  } finally {
    await sequelize.query('DELETE FROM integration.outbox_events WHERE id = :id', { replacements: { id: eventRow.id } });
  }
});

// --- TEC-19: failure drill — banco indisponível não deve travar o healthcheck ---
test('TEC-19 healthcheck nunca fica pendurado esperando o banco — responde em até HEALTH_CHECK_TIMEOUT_MS', async () => {
  // Simula exatamente o cenário do drill real (host de banco inalcançável): uma promise que
  // nunca resolve nem rejeita, representando um connect() TCP pendurado. Antes da correção,
  // isso travava /health por 20+ segundos num teste manual real contra um IP inalcançável.
  const neverResolves = new Promise(() => {});
  const startedAt = Date.now();

  await assert.rejects(() => withTimeout(neverResolves, 200));

  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 500, `deveria ter desistido perto de 200ms, levou ${elapsedMs}ms`);
});

test('TEC-19 healthcheck não trava quando a operação termina normalmente dentro do timeout', async () => {
  const fast = Promise.resolve('ok');
  const result = await withTimeout(fast, HEALTH_CHECK_TIMEOUT_MS);
  assert.equal(result, 'ok');
});

// --- ADV-12: sessão revogada não pode mais chamar a API, nem com o access token já emitido ---
function fakeReqRes(token) {
  const req = { header: (name) => (name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined) };
  const res = {};
  return { req, res };
}

test('ADV-12 authMiddleware bloqueia na hora um access token cuja sessão foi revogada — não espera expirar', async () => {
  const { accessToken, sessionId } = await authService.login({ email: 'admin@nayaraone.dev', password: 'DevAdmin#2026' });

  try {
    // Antes de revogar: o mesmo middleware usado em toda rota autenticada deve deixar passar.
    const { req: reqBefore, res: resBefore } = fakeReqRes(accessToken);
    let errBefore = 'not-called';
    await authMiddleware(reqBefore, resBefore, (err) => { errBefore = err; });
    assert.equal(errBefore, undefined, 'antes de revogar, o middleware deve chamar next() sem erro');
    assert.ok(reqBefore.auth, 'req.auth deve ser populado quando a sessão é válida');

    // Revoga a sessão (mesmo efeito de usersService.revokeAllSessionsForUser ao suspender —
    // exige contexto de tenant desde a correção TEC-03/04, RLS real de "core"."sessions").
    await withCommittedTenantTransaction(tenant, (t) =>
      Session.update({ revokedAt: new Date() }, { where: { id: sessionId }, transaction: t })
    );

    // Mesmo access token, mesma chamada — agora deve ser rejeitado imediatamente.
    const { req: reqAfter, res: resAfter } = fakeReqRes(accessToken);
    let errAfter = 'not-called';
    await authMiddleware(reqAfter, resAfter, (err) => { errAfter = err; });
    assert.notEqual(errAfter, undefined, 'depois de revogar, o middleware deve chamar next(err)');
    assert.equal(errAfter.code, 'SESSION_INVALID');
  } finally {
    await Session.destroy({ where: { id: sessionId }, force: true }).catch(() => {});
  }
});

// --- AUD-008 (reaberto pela cliente 14/09/2026): reproduz o caso real do contrato
// b7198a6c-7748-433b-9efc-331e1a87b64d — versão com content_hash calculado, mas sem documento
// real anexado (documentFileId null), avançando até SIGNING. O fix anterior só bloqueava
// content vazio; este teste prova que agora também é necessário um File real. ---
test('AUD-008b versão SEM documentFileId (documento real) não pode avançar o contrato para SIGNING', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseWithParties(transaction);
    await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, transaction);
    // Mesma reprodução do caso real: content textual "válido" (não vazio), mas SEM documentFileId.
    await contractVersionsService.createContractVersion(
      contract.id,
      // M5-07: hoje a criação já rejeitaria isso por padrão; o override explícito mantém o
      // cenário histórico do AUD-008b vivo para provar que o gate de SIGNING continua valendo
      // mesmo se um tenant desligar a exigência na criação.
      { content: `HOMO QA — corpo sem documento real ${uniqueSuffix()}`, requireDocument: false },
      tenant.userId,
      transaction
    );
    await contractsService.transitionContractStatus(contract, 'LEGAL_REVIEW', tenant.userId, transaction);
    await contractsService.transitionContractStatus(contract, 'APPROVED', tenant.userId, transaction);

    await assert.rejects(
      () => contractsService.transitionContractStatus(contract, 'SIGNING', tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_CONTRACT_DOCUMENT_GATE');
        return true;
      },
      'sem documentFileId real, o contrato não pode chegar a SIGNING — este era exatamente o defeito reportado'
    );
  });
});

// --- ADV-08: webhook de assinatura duplicado/fora de ordem não corrompe estado ---
test('ADV-08 webhook duplicado (mesma assinatura) é no-op idempotente — não reaplica efeito nem duplica auditoria', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { version, personIds } = await createSignableContractVersion(transaction);
    const [signatureA, signatureB] = await signaturesService.initiateSignature(version.id, personIds, tenant.userId, transaction);

    // Primeira entrega do webhook: aplica o efeito normalmente.
    const first = await signaturesService.handleSignatureWebhook(signatureA.externalSignatureId, {}, transaction);
    assert.equal(first.alreadyProcessed, false);
    assert.equal(first.contractTransitioned, false, 'ainda falta a signatureB assinar, contrato não pode transicionar');

    const auditCountBefore = await AuditLog.count({
      where: { entityType: 'Signature', entityId: signatureA.id },
      transaction,
    });

    // Provedor reenvia o MESMO webhook (duplicado) — não pode reaplicar nem duplicar auditoria.
    const duplicate = await signaturesService.handleSignatureWebhook(signatureA.externalSignatureId, {}, transaction);
    assert.equal(duplicate.alreadyProcessed, true, 'webhook duplicado deve ser reconhecido como já processado');
    assert.equal(duplicate.contractTransitioned, false);

    const auditCountAfter = await AuditLog.count({
      where: { entityType: 'Signature', entityId: signatureA.id },
      transaction,
    });
    assert.equal(auditCountAfter, auditCountBefore, 'webhook duplicado não pode gravar uma segunda linha de auditoria');

    // Fecha a assinatura restante: agora sim o contrato transiciona para SIGNED.
    const last = await signaturesService.handleSignatureWebhook(signatureB.externalSignatureId, {}, transaction);
    assert.equal(last.contractTransitioned, true);

    const contractAfterAllSigned = await contractsService.getContract(version.contractId, transaction);
    assert.equal(contractAfterAllSigned.status, 'SIGNED');

    // "Fora de ordem": o webhook da PRIMEIRA assinatura chega de novo, atrasado, depois que o
    // contrato inteiro já virou SIGNED. Não pode tentar retransicionar (o guard `contract.status
    // === 'SIGNING'` já barra isso) nem lançar erro — precisa continuar respondendo no-op limpo.
    const stale = await signaturesService.handleSignatureWebhook(signatureA.externalSignatureId, {}, transaction);
    assert.equal(stale.alreadyProcessed, true);
    assert.equal(stale.contractTransitioned, false, 'webhook atrasado não pode reacionar transição de contrato já SIGNED');

    const contractStillSigned = await contractsService.getContract(version.contractId, transaction);
    assert.equal(contractStillSigned.status, 'SIGNED', 'estado final do contrato não pode ser corrompido por webhook fora de ordem');
  });
});

// --- ADV-18: rateio (parcelamento de comissão) sempre fecha em R$0,00 de diferença, mesmo com dízima ---
test('ADV-18 parcelas geradas por generateInstallments sempre somam exatamente o totalAmount, mesmo com divisão não exata', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // 1000 / 3 = 333.333... — o caso clássico de dízima que quebra rateio ingênuo.
    // 100.01 / 7 — valor com centavo ímpar, ainda mais propenso a sobrar/faltar 1 centavo.
    const cases = [
      { baseAmount: 3000, percentage: 33.33333, installmentsCount: 3 }, // totalAmount ~999.9999 -> 1000.00 arredondado
      { baseAmount: 1000.07, percentage: 10, installmentsCount: 7 },
      { baseAmount: 50, percentage: 100, installmentsCount: 11 },
    ];

    for (const testCase of cases) {
      // eslint-disable-next-line no-await-in-loop
      const { commission, installments } = await commissionsService.createCommission(
        {
          groupId: tenant.groupId,
          companyId: tenant.companyId,
          beneficiaryUserId: tenant.userId,
          baseAmount: testCase.baseAmount,
          percentage: testCase.percentage,
          installmentsCount: testCase.installmentsCount,
        },
        tenant.userId,
        transaction
      );

      assert.equal(installments.length, testCase.installmentsCount);

      const sumInCents = installments.reduce((acc, i) => acc + Math.round(Number(i.amount) * 100), 0);
      const totalInCents = Math.round(Number(commission.totalAmount) * 100);
      assert.equal(
        sumInCents,
        totalInCents,
        `soma das ${testCase.installmentsCount} parcelas (${sumInCents} centavos) deve fechar exatamente com totalAmount (${totalInCents} centavos), sem sobra nem falta de 1 centavo`
      );

      // Nenhuma parcela individual pode ser negativa ou zero (rateio degenerado).
      installments.forEach((i) => assert.ok(Number(i.amount) > 0, 'nenhuma parcela do rateio pode ficar em R$0,00 ou negativa'));
    }
  });
});

// --- Processos jurídicos, prazos e alertas efetivamente utilizáveis (reportado pela cliente
// 14/09/2026) — o job de alerta precisa rodar de verdade (não só calcular severidade sob
// demanda), notificar o responsável e não reavisar do mesmo prazo/severidade repetidamente. ---
test('legalDeadlineAlertJob alerta prazo OVERDUE, notifica o responsável, e não reavisa duas vezes pela mesma severidade', async () => {
  const legalCasesService = require('../src/features/legal/legalCases.service');
  const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
  const { processLegalDeadlineAlertsForCompany } = require('../src/engines/jobs/legalDeadlineAlertJob');
  const { LegalCase, LegalDeadline, Notification, OutboxEvent } = require('../src/models');

  let legalCase;
  let deadline;
  try {
    legalCase = await withCommittedTenantTransaction(tenant, (t) =>
      legalCasesService.createLegalCase(
        { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', responsibleUserId: tenant.userId },
        tenant.userId,
        t
      )
    );
    deadline = await withCommittedTenantTransaction(tenant, (t) =>
      legalDeadlinesService.createLegalDeadline(
        legalCase.id,
        { description: `HOMO QA prazo vencido ${uniqueSuffix()}`, dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        tenant.userId,
        t
      )
    );

    const result = await processLegalDeadlineAlertsForCompany({ id: tenant.groupId }, { id: tenant.companyId });
    assert.ok(result.alerted >= 1);

    // Leituras de tabelas com RLS (legal_deadlines, notifications, outbox_events) exigem
    // contexto de tenant desde a correção TEC-03/04 (RLS real, sem bypass de superusuário).
    await withCommittedTenantTransaction(tenant, async (t) => {
      const reloaded = await LegalDeadline.findByPk(deadline.id, { transaction: t });
      assert.equal(reloaded.lastAlertedSeverity, 'OVERDUE');

      const notifications = await Notification.findAll({ where: { userId: tenant.userId, title: 'Prazo jurídico VENCIDO' }, transaction: t });
      assert.ok(notifications.some((n) => n.body.includes(deadline.description)));

      const events = await OutboxEvent.findAll({
        where: { aggregateType: 'LegalDeadline', aggregateId: deadline.id, eventType: 'legal.deadline.alert' },
        transaction: t,
      });
      assert.equal(events.length, 1, 'exatamente um evento de alerta deve ter sido publicado');
    });

    // Roda o job de novo: mesma severidade (OVERDUE), não pode reavisar nem duplicar o evento.
    await processLegalDeadlineAlertsForCompany({ id: tenant.groupId }, { id: tenant.companyId });
    await withCommittedTenantTransaction(tenant, async (t) => {
      const eventsAfter = await OutboxEvent.findAll({
        where: { aggregateType: 'LegalDeadline', aggregateId: deadline.id, eventType: 'legal.deadline.alert' },
        transaction: t,
      });
      assert.equal(eventsAfter.length, 1, 'segunda rodada do job não pode duplicar o alerta da mesma severidade');
    });
  } finally {
    await withCommittedTenantTransaction(tenant, async (t) => {
      if (deadline) await LegalDeadline.destroy({ where: { id: deadline.id }, force: true, transaction: t });
      if (legalCase) await LegalCase.destroy({ where: { id: legalCase.id }, force: true, transaction: t });
    }).catch(() => {});
  }
});

// --- Seletores operacionais (CRM/jurídico) não podem oferecer usuário suspenso como
// responsável/vendedor padrão — reportado pela cliente 18/09/2026. ---
test('usersService.listUsers filtra por status — usuário suspenso não aparece quando filtra ACTIVE', async () => {
  const usersService = require('../src/features/users/users.service');
  const suffix = uniqueSuffix();
  const activeUser = await User.create({ name: `HOMO QA status filter ativo ${suffix}`, email: `homo-qa-statusfilter-ativo-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' });
  const suspendedUser = await User.create({ name: `HOMO QA status filter suspenso ${suffix}`, email: `homo-qa-statusfilter-suspenso-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'SUSPENDED' });

  try {
    const activeOnly = await usersService.listUsers({ status: 'ACTIVE' });
    assert.ok(activeOnly.some((u) => u.id === activeUser.id), 'usuário ACTIVE deve aparecer no filtro status=ACTIVE');
    assert.ok(!activeOnly.some((u) => u.id === suspendedUser.id), 'usuário SUSPENDED não pode aparecer no filtro status=ACTIVE');

    const unfiltered = await usersService.listUsers();
    assert.ok(unfiltered.some((u) => u.id === suspendedUser.id), 'sem filtro, continua listando todos (comportamento de tela administrativa)');
  } finally {
    await activeUser.destroy({ force: true }).catch(() => {});
    await suspendedUser.destroy({ force: true }).catch(() => {});
  }
});
