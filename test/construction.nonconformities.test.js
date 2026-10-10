'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const nonconformitiesService = require('../src/features/construction/nonconformities.service');
const lossRecordsService = require('../src/features/construction/lossRecords.service');
const { LossRecord } = require('../src/models');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createTestProject(transaction) {
  const suffix = uniqueSuffix();
  return projectsService.createProject(
    { groupId: tenant.groupId, companyId: tenant.companyId, name: `HOMO QA Obra ${suffix}` },
    tenant.userId,
    transaction
  );
}

// M6-62/M6-24/M6-38/M6-86: fechar NC sem evidência "depois" tem que bloquear (fail-closed) —
// nunca fechar silenciosamente sem afterEvidenceFileIds.
test('M6-62: fechar não conformidade sem after_evidence_file_ids bloqueia', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const nc = await nonconformitiesService.createNonconformity(
      project.id,
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        severity: 'HIGH',
        description: 'Infiltração no banheiro da suíte 2.',
        responsibleUserId: tenant.userId,
        beforeEvidenceFileIds: ['11111111-1111-1111-1111-111111111111'],
      },
      tenant.userId,
      transaction
    );
    assert.equal(nc.status, 'OPEN');

    await assert.rejects(
      () => nonconformitiesService.closeNonconformity(nc.id, {}, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'NONCONFORMITY_CLOSE_REQUIRES_AFTER_EVIDENCE');
        return true;
      }
    );

    // Confirma que realmente não fechou (fail-closed de verdade, não só o erro lançado).
    const reloaded = await nonconformitiesService.getNonconformity(nc.id, transaction);
    assert.equal(reloaded.status, 'OPEN');
  });
});

// M6-24: NC com requiresAcceptance=true não pode fechar sem acceptedByUserId, mesmo com
// evidência "depois" preenchida.
test('M6-24: fechar NC com requiresAcceptance=true sem acceptedByUserId bloqueia', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const nc = await nonconformitiesService.createNonconformity(
      project.id,
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        severity: 'CRITICAL',
        description: 'Trinca estrutural na viga do 2º pavimento.',
        requiresAcceptance: true,
        responsibleUserId: tenant.userId,
        beforeEvidenceFileIds: ['22222222-2222-2222-2222-222222222222'],
      },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () =>
        nonconformitiesService.closeNonconformity(
          nc.id,
          { afterEvidenceFileIds: ['22222222-2222-2222-2222-222222222222'] },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'NONCONFORMITY_CLOSE_REQUIRES_ACCEPTANCE');
        return true;
      }
    );

    // Com aceite preenchido, agora fecha normalmente e dispara nonconformity.closed.
    const closed = await nonconformitiesService.closeNonconformity(
      nc.id,
      { afterEvidenceFileIds: ['22222222-2222-2222-2222-222222222222'], acceptedByUserId: tenant.userId },
      tenant.userId,
      transaction
    );
    assert.equal(closed.status, 'CLOSED');
    assert.equal(closed.acceptedByUserId, tenant.userId);
    assert.ok(closed.closedAt);
  });
});

// Fluxo feliz: NC com evidência "depois" preenchida e sem exigência de aceite fecha normalmente.
test('NC fecha normalmente quando after_evidence_file_ids está preenchido e não exige aceite', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const nc = await nonconformitiesService.createNonconformity(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, severity: 'LOW', description: 'Pintura com respingo na sala.', responsibleUserId: tenant.userId, beforeEvidenceFileIds: ['33333333-3333-3333-3333-333333333334'] },
      tenant.userId,
      transaction
    );
    const closed = await nonconformitiesService.closeNonconformity(
      nc.id,
      { afterEvidenceFileIds: ['33333333-3333-3333-3333-333333333333'] },
      tenant.userId,
      transaction
    );
    assert.equal(closed.status, 'CLOSED');
  });
});

// M6-29: perda de material acima da alçada não pode ser autoaprovada — nasce PENDING_APPROVAL
// e só vira APPROVED com aprovação explícita.
test('M6-29: perda de material acima da alçada exige aprovação explícita', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const threshold = await lossRecordsService.getApprovalThreshold(
      tenant.groupId,
      tenant.companyId,
      lossRecordsService.CONTEXT_MATERIAL_LOSS,
      transaction
    );

    const highValueLoss = await lossRecordsService.createLossRecord(
      project.id,
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        materialDescription: 'Cimento CPII 50kg',
        quantity: 100,
        estimatedValue: threshold + 5000,
        reason: 'Quebra no transporte do fornecedor.',
        idempotencyKey: `loss-${uniqueSuffix()}`,
      },
      tenant.userId,
      transaction
    );
    assert.equal(highValueLoss.status, 'PENDING_APPROVAL');
    assert.equal(highValueLoss.approvedByUserId, null);

    const approved = await lossRecordsService.approveLossRecord(highValueLoss.id, tenant.userId, transaction);
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.approvedByUserId, tenant.userId);

    // Abaixo da alçada: autoaprova sem chamada explícita.
    const lowValueLoss = await lossRecordsService.createLossRecord(
      project.id,
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        materialDescription: 'Prego 18x30',
        quantity: 5,
        estimatedValue: Math.max(threshold - 100, 1),
        reason: 'Perda pequena de estoque.',
        idempotencyKey: `loss-${uniqueSuffix()}`,
      },
      tenant.userId,
      transaction
    );
    assert.equal(lowValueLoss.status, 'APPROVED');
  });
});

// BUG REAL CORRIGIDO (varredura proativa pós-auditoria externa Nayara, 09/10/2026 —
// "idempotência obrigatória em operações reexecutáveis"): createLossRecord autoaprova perdas
// dentro da alçada SEM nenhum humano no caminho — reenviar o mesmo lançamento por timeout/
// retry/duplo-clique duplicava o valor de perda reportado (e a quantidade de material dado como
// perdido), afetando margem/custo da obra. Agora idempotencyKey é obrigatória e reenviar a
// MESMA chave devolve o registro já existente, nunca cria um segundo.
test('createLossRecord: idempotencyKey é obrigatória, e reenviar a MESMA chave devolve o registro original (sem duplicar perda)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);

    await assert.rejects(
      () =>
        lossRecordsService.createLossRecord(
          project.id,
          { groupId: tenant.groupId, companyId: tenant.companyId, materialDescription: 'Cimento', quantity: 3, estimatedValue: 50, reason: 'Perda em transporte.' },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LOSS_RECORD_IDEMPOTENCY_KEY_REQUIRED');
        return true;
      }
    );

    const idempotencyKey = `loss-regression-${uniqueSuffix()}`;
    const first = await lossRecordsService.createLossRecord(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, materialDescription: 'Cimento', quantity: 3, estimatedValue: 50, reason: 'Perda em transporte.', idempotencyKey },
      tenant.userId,
      transaction
    );

    const second = await lossRecordsService.createLossRecord(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, materialDescription: 'Cimento', quantity: 3, estimatedValue: 50, reason: 'Perda em transporte.', idempotencyKey },
      tenant.userId,
      transaction
    );

    assert.equal(second.id, first.id, 'reenviar a mesma idempotencyKey precisa devolver o registro original, nunca criar um segundo');

    const allWithKey = await LossRecord.findAll({ where: { companyId: tenant.companyId, idempotencyKey }, transaction });
    assert.equal(allWithKey.length, 1, 'só pode existir 1 registro de perda para esta idempotencyKey');
  });
});

// BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 11, Frente A, 09/10/2026): createLossRecord
// nunca validava que o projectId informado pertencia ao companyId/groupId também informados no
// payload — dava pra enviar projectId de uma obra junto com companyId/groupId de outra empresa.
test('createLossRecord recusa quando o projectId pertence a uma empresa diferente do companyId informado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const [[otherCompanyRow]] = await sequelize.query(
      'SELECT id, group_id AS "groupId" FROM core.companies WHERE id != :companyId LIMIT 1',
      { replacements: { companyId: tenant.companyId }, transaction }
    );
    if (!otherCompanyRow) return; // ambiente sem segunda empresa semeada — nada a testar aqui.

    await assert.rejects(
      () =>
        lossRecordsService.createLossRecord(
          project.id,
          {
            groupId: otherCompanyRow.groupId,
            companyId: otherCompanyRow.id,
            materialDescription: 'Cimento',
            quantity: 3,
            estimatedValue: 50,
            reason: 'Perda em transporte.',
            idempotencyKey: `loss-cross-company-${uniqueSuffix()}`,
          },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LOSS_RECORD_PROJECT_COMPANY_MISMATCH');
        return true;
      }
    );
  });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 59, 2026-10-06): upsertApprovalThreshold
// não validava Number.isFinite/teto — "Infinity"/"NaN" passava e quebrava a alçada (threshold
// Infinity faz tudo auto-aprovar).
test('upsertApprovalThreshold recusa valores Infinity/NaN/negativo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () => lossRecordsService.upsertApprovalThreshold(
        { groupId: tenant.groupId, companyId: tenant.companyId, context: 'MATERIAL_LOSS', maxAutoApproveAmount: Infinity },
        tenant.userId,
        transaction
      ),
      (err) => { assert.equal(err.code, 'APPROVAL_THRESHOLD_VALIDATION'); return true; }
    );
    await assert.rejects(
      () => lossRecordsService.upsertApprovalThreshold(
        { groupId: tenant.groupId, companyId: tenant.companyId, context: 'MATERIAL_LOSS', maxAutoApproveAmount: 'NaN' },
        tenant.userId,
        transaction
      ),
      (err) => { assert.equal(err.code, 'APPROVAL_THRESHOLD_VALIDATION'); return true; }
    );
    await assert.rejects(
      () => lossRecordsService.upsertApprovalThreshold(
        { groupId: tenant.groupId, companyId: tenant.companyId, context: 'MATERIAL_LOSS', maxAutoApproveAmount: -10 },
        tenant.userId,
        transaction
      ),
      (err) => { assert.equal(err.code, 'APPROVAL_THRESHOLD_VALIDATION'); return true; }
    );
  });
});

// M6-60: devolução de material gera movimento inverso e corrige o saldo calculado.
test('M6-60: devolução de material corrige o saldo (movimento inverso real)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const materialDescription = 'Telha cerâmica colonial';

    const loss = await lossRecordsService.createLossRecord(
      project.id,
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        materialDescription,
        quantity: 200,
        estimatedValue: 500,
        reason: 'Quebra no manuseio da entrega.',
        idempotencyKey: `loss-${uniqueSuffix()}`,
      },
      tenant.userId,
      transaction
    );
    assert.equal(loss.status, 'APPROVED'); // dentro da alçada padrão

    const balanceAfterLoss = await lossRecordsService.getMaterialBalance(project.id, materialDescription, transaction);
    assert.equal(balanceAfterLoss.quantityBalance, -200);
    assert.equal(balanceAfterLoss.valueBalance, -500);

    // Devolve só parte do material perdido (80 de 200) — movimento inverso parcial.
    const returned = await lossRecordsService.returnLossRecord(loss.id, { quantity: 80 }, tenant.userId, transaction);
    assert.equal(returned.movementType, 'RETURN');
    assert.equal(returned.relatedLossRecordId, loss.id);
    assert.equal(Number(returned.quantity), 80);

    const balanceAfterReturn = await lossRecordsService.getMaterialBalance(project.id, materialDescription, transaction);
    assert.equal(balanceAfterReturn.quantityBalance, -120); // -200 + 80
    assert.equal(balanceAfterReturn.valueBalance, -300); // -500 + 200 (80/200 * 500)

    // Devolução não apaga o registro original de perda (append-only) — continua existindo e
    // continua APPROVED, só o SALDO agregado é que reflete a correção.
    const originalStillThere = await lossRecordsService.getLossRecord(loss.id, transaction);
    assert.equal(originalStillThere.status, 'APPROVED');
    assert.equal(Number(originalStillThere.quantity), 200);

    // Não é possível devolver mais do que o total original.
    await assert.rejects(
      () => lossRecordsService.returnLossRecord(loss.id, { quantity: 1000 }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LOSS_RECORD_RETURN_QUANTITY_INVALID');
        return true;
      }
    );

    // M6-NOVO-3 (auditoria Marco 6, ciclo 1 novo, categoria 14 do catálogo): "quantity": "NaN"
    // não satisfaz nem `<= 0` nem `> remainingQuantity` — sem Number.isFinite, passava o guard
    // e criava um RETURN com quantity/estimatedValue = NaN.
    await assert.rejects(
      () => lossRecordsService.returnLossRecord(loss.id, { quantity: 'NaN' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LOSS_RECORD_RETURN_QUANTITY_INVALID');
        return true;
      }
    );
  });
});

// M6-57/M6-66 (cross-company via RLS): NC criada sob o tenant de seed não pode ser lida/fechada
// fora do contexto de tenant correto — comprova que a policy tenant_isolation está ativa na
// tabela nova.
test('RLS: não conformidade de uma empresa não é visível fora do contexto de tenant (SET LOCAL ausente)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const nc = await nonconformitiesService.createNonconformity(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, severity: 'LOW', description: 'RLS smoke test.', responsibleUserId: tenant.userId, beforeEvidenceFileIds: ['44444444-4444-4444-4444-444444444444'] },
      tenant.userId,
      transaction
    );

    // Nova transação SEM configurar app.company_id (equivalente a "outro tenant"/sessão sem
    // contexto) — a policy RLS deve esconder a linha mesmo sabendo o ID exato.
    await sequelize.transaction(async (rawTransaction) => {
      const { Nonconformity } = require('../src/models');
      const found = await Nonconformity.findByPk(nc.id, { transaction: rawTransaction });
      assert.equal(found, null);
    });
  });
});

// Bug real corrigido nesta auditoria (rodada 19, 2026-10-05): contrato diz "falha abre
// nonconformity" — checkQualityItem marcando um item NOT_OK precisa abrir a NC automaticamente,
// não depender de alguém lembrar de criar manualmente.
test('M6-12: marcar item de checklist de qualidade como NOT_OK abre Nonconformity automaticamente', async () => {
  const qualityChecklistService = require('../src/features/construction/qualityChecklist.service');
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const item = await qualityChecklistService.createQualityItem(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, item: 'Pintura da fachada sem falhas', category: 'PINTURA' },
      tenant.userId,
      transaction
    );

    const checked = await qualityChecklistService.checkQualityItem(
      item.id,
      { status: 'NOT_OK', notes: 'Manchas visíveis na fachada.', evidenceFileIds: ['55555555-5555-5555-5555-555555555555'] },
      tenant.userId,
      transaction
    );
    assert.equal(checked.status, 'NOT_OK');

    const ncs = await nonconformitiesService.listNonconformities(project.id, transaction);
    assert.equal(ncs.length, 1, 'item reprovado precisa abrir uma Nonconformity de verdade, não só mudar status');
    assert.match(ncs[0].description, /Pintura da fachada sem falhas/);
    assert.equal(ncs[0].status, 'OPEN');

    // Marcar OK não pode abrir NC nenhuma.
    const item2 = await qualityChecklistService.createQualityItem(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, item: 'Piso nivelado', category: 'ACABAMENTO' },
      tenant.userId,
      transaction
    );
    await qualityChecklistService.checkQualityItem(item2.id, { status: 'OK' }, tenant.userId, transaction);
    const ncsAfterOk = await nonconformitiesService.listNonconformities(project.id, transaction);
    assert.equal(ncsAfterOk.length, 1, 'marcar item OK não pode abrir nenhuma nonconformity');
  });
});

// BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 4, 2026-10-06): reenviar "check" NOT_OK duas
// vezes em sequência (reenvio de rede, duplo clique sem debounce, retry manual) para o MESMO
// item já reprovado abria uma SEGUNDA Nonconformity CRITICAL duplicada — como
// QualityChecklistItem não guarda nenhum vínculo de volta para a Nonconformity criada, as
// duplicatas nunca eram fechadas junto e ficavam bloqueando o gate de entrega para sempre, até
// depois do item ser corrigido. Só deve abrir NC nova ao TRANSICIONAR para NOT_OK.
test('M6-12 (ciclo 4): reenviar NOT_OK para o mesmo item já reprovado não duplica a Nonconformity', async () => {
  const qualityChecklistService = require('../src/features/construction/qualityChecklist.service');
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const item = await qualityChecklistService.createQualityItem(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, item: 'Tubulação hidráulica sem vazamento', category: 'HIDRAULICA' },
      tenant.userId,
      transaction
    );

    await qualityChecklistService.checkQualityItem(item.id, { status: 'NOT_OK', notes: 'Vazamento na conexão.', evidenceFileIds: ['66666666-6666-6666-6666-666666666666'] }, tenant.userId, transaction);
    let ncs = await nonconformitiesService.listNonconformities(project.id, transaction);
    assert.equal(ncs.length, 1, 'primeira reprovação precisa abrir exatamente uma Nonconformity');

    // Reenvio do mesmo "check" (status já era NOT_OK) — não pode abrir uma segunda NC.
    await qualityChecklistService.checkQualityItem(item.id, { status: 'NOT_OK', notes: 'Vazamento na conexão (reenvio).', evidenceFileIds: ['77777777-7777-7777-7777-777777777777'] }, tenant.userId, transaction);
    ncs = await nonconformitiesService.listNonconformities(project.id, transaction);
    assert.equal(ncs.length, 1, 'reenviar NOT_OK para o mesmo item já reprovado não pode duplicar a Nonconformity');

    // Depois de corrigido (OK) e reprovado de novo, uma NOVA NC legítima deve ser aberta.
    await qualityChecklistService.checkQualityItem(item.id, { status: 'OK' }, tenant.userId, transaction);
    await qualityChecklistService.checkQualityItem(item.id, { status: 'NOT_OK', notes: 'Voltou a vazar.', evidenceFileIds: ['88888888-8888-8888-8888-888888888888'] }, tenant.userId, transaction);
    ncs = await nonconformitiesService.listNonconformities(project.id, transaction);
    assert.equal(ncs.length, 2, 'uma nova reprovação genuína (após ter sido corrigida) precisa abrir uma NOVA Nonconformity');
  });
});
