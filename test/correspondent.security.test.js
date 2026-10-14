'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const simulationsService = require('../src/features/correspondent/cases/simulations.service');
const { Person, FinancingCase, AuditLog } = require('../src/models');

/**
 * Marco 8 Fase 11 — Segurança/antifraude.
 *
 * A maioria dos itens já foi construída e já tem cobertura própria em fases anteriores — este
 * arquivo não duplica esses testes, só referencia onde cada um vive:
 *   - Webhook falso rejeitado / nunca processado: test/correspondent.webhooks.test.js
 *     (CORRESPONDENT-WEBHOOK-02).
 *   - Webhook duplicado aplica efeito uma única vez: idem (CORRESPONDENT-WEBHOOK-03).
 *   - Status fora de ordem não regride o case, histórico append-only: idem
 *     (CORRESPONDENT-WEBHOOK-04) + confirmado por leitura de código (webhooks.service.js só usa
 *     `ProviderStatusHistory.create`/`.findAll`, nunca `.update`/`.save`).
 *   - Submit duplicado resolvido por idempotência: test/correspondent.submissions.test.js
 *     (CORRESPONDENT-SUB-04).
 *   - NAY nunca decide/promete/escreve estado: test/correspondent.nay.test.js.
 *   - Token de provider nunca em log: confirmado por `grep -rn "logger\.\|console\.log"
 *     src/features/correspondent/` — zero ocorrências no módulo inteiro.
 *   - Criptografia de arquivo em repouso: GAP PRÉ-EXISTENTE DO PROJETO, não específico do Marco 8
 *     — `src/features/files/files.service.js` (storage genérico reusado por Jurídico/Obras/
 *     Correspondente) não criptografa conteúdo em repouso hoje. Não inventado isoladamente aqui
 *     pra não deixar o projeto inconsistente; avaliar como épico próprio se a Nayara exigir antes
 *     de produção.
 *
 * O que É novo nesta fase, e testado de verdade abaixo: sinalização de possível duplicata por
 * fingerprint (nunca bloqueia a criação), e confirmação de que bloqueio de eligibility audita.
 */

let tenant;
const createdFinancingCaseIds = [];

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  if (createdFinancingCaseIds.length > 0) {
    await FinancingCase.destroy({ where: { id: createdFinancingCaseIds } });
  }
  await sequelize.close();
});

async function createPrincipal(transaction, label) {
  return Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PF',
      legalName: `Proponente Security ${label} ${uniqueSuffix()}`,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

test('SEC-01: dois cases do mesmo proponente+imóvel no mesmo dia são sinalizados como possível duplicata, nunca bloqueados', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const principal = await createPrincipal(t, 'dup');
    const first = await financingCasesService.createFinancingCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'sandbox', applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] },
      tenant.userId,
      t
    );
    assert.equal(first.possibleDuplicateOfCaseId, null, 'primeiro case não deve achar duplicata de si mesmo');

    const second = await financingCasesService.createFinancingCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'sandbox', applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] },
      tenant.userId,
      t
    );
    // NUNCA bloqueia — a criação sempre tem sucesso.
    assert.ok(second.id, 'criação do segundo case nunca deve ser bloqueada pela duplicidade');
    assert.equal(second.possibleDuplicateOfCaseId, first.id, 'segundo case deve apontar pro primeiro como possível duplicata');
    assert.equal(second.duplicateFingerprint, first.duplicateFingerprint, 'fingerprint precisa bater entre os dois');

    const auditEntry = await AuditLog.findOne({
      where: { entityType: 'FinancingCase', entityId: second.id, action: 'correspondent.case.possible_duplicate' },
      transaction: t,
    });
    assert.ok(auditEntry, 'sinalização de duplicata precisa gerar entrada de auditoria pra revisão humana');
  });
});

test('SEC-02: proponentes diferentes no mesmo dia NÃO são sinalizados como duplicata (sem falso positivo)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const principalA = await createPrincipal(t, 'A');
    const principalB = await createPrincipal(t, 'B');
    await financingCasesService.createFinancingCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'sandbox', applicants: [{ personId: principalA.id, role: 'PRINCIPAL' }] },
      tenant.userId,
      t
    );
    const second = await financingCasesService.createFinancingCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'sandbox', applicants: [{ personId: principalB.id, role: 'PRINCIPAL' }] },
      tenant.userId,
      t
    );
    assert.equal(second.possibleDuplicateOfCaseId, null, 'proponentes diferentes não devem gerar falso positivo de duplicata');
  });
});

test('SEC-03: bloqueio de eligibility (provider inelegível) gera entrada de auditoria', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const principal = await createPrincipal(t, 'elig');
    const financingCase = await financingCasesService.createFinancingCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'sandbox', applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] },
      tenant.userId,
      t
    );
    await assert.rejects(() =>
      simulationsService.createSimulation(
        financingCase.id,
        { amount: 9999999, termMonths: 360 },
        tenant.userId,
        tenant.groupId,
        tenant.companyId,
        t
      )
    );
    const auditEntry = await AuditLog.findOne({
      where: { entityType: 'FinancingCase', entityId: financingCase.id, action: 'correspondent.eligibility.denied' },
      transaction: t,
    });
    assert.ok(auditEntry, 'bloqueio de eligibility precisa auditar o motivo');
  });
});
