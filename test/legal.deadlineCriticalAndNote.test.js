'use strict';

/**
 * Auditoria da cliente, Marco 5 (achados 2 e 3):
 *  - prazo CRITICAL exige responsavel efetivo e destino de escalonamento desde a criacao;
 *  - nota de conclusao so com espacos nao vale como evidencia.
 * Cada cenario tem o caso negativo (recusa e nada gravado) e o positivo (fluxo legitimo).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const legalCasesService = require('../src/features/legal/legalCases.service');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const AppError = require('../src/utils/AppError');
const { LegalDeadline } = require('../src/models');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});

const FUTURE = () => new Date(Date.now() + 20 * 86400000);

function createCase(transaction, extra = {}) {
  return legalCasesService.createLegalCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `Critico ${uniqueSuffix()}`, ...extra },
    tenant.userId,
    transaction
  );
}

function criticalPayload(extra = {}) {
  return { description: `Prazo critico ${uniqueSuffix()}`, dueAt: FUTURE(), sourceEvent: 'teste', criticality: 'CRITICAL', ...extra };
}

function expectCode(code, status) {
  return (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, code);
    if (status) assert.equal(err.statusCode, status);
    return true;
  };
}

test('CRITICAL futuro sem responsavel no prazo nem no processo: recusado (422) e nada gravado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const legalCase = await createCase(transaction, { escalationUserId: tenant.userId });
    const before = await LegalDeadline.count({ where: { legalCaseId: legalCase.id }, transaction });
    await assert.rejects(
      () => legalDeadlinesService.createLegalDeadline(legalCase.id, criticalPayload(), tenant.userId, transaction),
      expectCode('LEGAL_DEADLINE_CRITICAL_RESPONSIBLE_REQUIRED', 422)
    );
    assert.equal(await LegalDeadline.count({ where: { legalCaseId: legalCase.id }, transaction }), before);
  });
});

test('CRITICAL sem destino de escalonamento no processo: recusado (422)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const legalCase = await createCase(transaction, { responsibleUserId: tenant.userId });
    await assert.rejects(
      () => legalDeadlinesService.createLegalDeadline(legalCase.id, criticalPayload({ responsibleUserId: tenant.userId }), tenant.userId, transaction),
      expectCode('LEGAL_DEADLINE_CRITICAL_ESCALATION_REQUIRED', 422)
    );
  });
});

test('CRITICAL com responsavel do processo + escalonamento, ou responsavel do prazo + escalonamento: aceito; MEDIUM segue sem exigencia', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const comResp = await createCase(transaction, { responsibleUserId: tenant.userId, escalationUserId: tenant.userId });
    const d1 = await legalDeadlinesService.createLegalDeadline(comResp.id, criticalPayload(), tenant.userId, transaction);
    assert.equal(d1.criticality, 'CRITICAL');
    const semResp = await createCase(transaction, { escalationUserId: tenant.userId });
    const d2 = await legalDeadlinesService.createLegalDeadline(semResp.id, criticalPayload({ responsibleUserId: tenant.userId }), tenant.userId, transaction);
    assert.equal(d2.responsibleUserId, tenant.userId);
    const livre = await createCase(transaction);
    const d3 = await legalDeadlinesService.createLegalDeadline(livre.id, { description: 'comum', dueAt: FUTURE(), sourceEvent: 'teste' }, tenant.userId, transaction);
    assert.equal(d3.criticality, 'MEDIUM');
  });
});

test('Processo com prazo CRITICAL pendente nao pode perder responsavel nem escalonamento (caminho vizinho)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const legalCase = await createCase(transaction, { responsibleUserId: tenant.userId, escalationUserId: tenant.userId });
    await legalDeadlinesService.createLegalDeadline(legalCase.id, criticalPayload(), tenant.userId, transaction);
    await assert.rejects(
      () => legalCasesService.updateLegalCase(legalCase.id, { escalationUserId: null }, tenant.userId, transaction),
      expectCode('LEGAL_DEADLINE_CRITICAL_ESCALATION_REQUIRED', 422)
    );
    await assert.rejects(
      () => legalCasesService.updateLegalCase(legalCase.id, { responsibleUserId: null }, tenant.userId, transaction),
      expectCode('LEGAL_DEADLINE_CRITICAL_RESPONSIBLE_REQUIRED', 422)
    );
    const ok = await legalCasesService.updateLegalCase(legalCase.id, { summary: 'novo resumo' }, tenant.userId, transaction);
    assert.equal(ok.summary, 'novo resumo');
  });
});

async function pendingDeadline(transaction) {
  const legalCase = await createCase(transaction, { responsibleUserId: tenant.userId });
  return legalDeadlinesService.createLegalDeadline(
    legalCase.id,
    { description: `Prazo ${uniqueSuffix()}`, dueAt: FUTURE(), sourceEvent: 'teste' },
    tenant.userId,
    transaction
  );
}

test('Concluir com nota so de espacos (ou quebras de linha/tabs): recusado (422), prazo continua PENDING', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const d = await pendingDeadline(transaction);
    for (const nota of ['   ', '\n\t  \n', '']) {
      await assert.rejects(
        () => legalDeadlinesService.updateLegalDeadline(d.id, { status: 'DONE', conclusionNote: nota }, tenant.userId, transaction),
        expectCode('LEGAL_DEADLINE_CONCLUSION_PROOF_REQUIRED', 422)
      );
    }
    const fresh = await LegalDeadline.findByPk(d.id, { transaction });
    assert.equal(fresh.status, 'PENDING');
    assert.equal(fresh.conclusionNote, null);
  });
});

test('Nota normalizada (trim) ao concluir; nota valida continua aceita', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const d = await pendingDeadline(transaction);
    const done = await legalDeadlinesService.updateLegalDeadline(d.id, { status: 'DONE', conclusionNote: '  Peticao protocolada.  ' }, tenant.userId, transaction);
    assert.equal(done.status, 'DONE');
    assert.equal(done.conclusionNote, 'Peticao protocolada.');
  });
});

test('Nota so de espacos gravada antes (PENDING) nao serve de prova ao concluir; prazo ja concluido nao e afetado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const d = await pendingDeadline(transaction);
    const semProva = await legalDeadlinesService.updateLegalDeadline(d.id, { conclusionNote: '   ' }, tenant.userId, transaction);
    assert.equal(semProva.conclusionNote, null, 'nota em branco e normalizada para vazio, nao vira prova');
    await assert.rejects(
      () => legalDeadlinesService.updateLegalDeadline(d.id, { status: 'DONE' }, tenant.userId, transaction),
      expectCode('LEGAL_DEADLINE_CONCLUSION_PROOF_REQUIRED', 422)
    );
    await legalDeadlinesService.updateLegalDeadline(d.id, { status: 'DONE', conclusionNote: 'Feito.' }, tenant.userId, transaction);
    // prazo ja concluido: ajuste de descricao nao reavalia a prova
    const again = await legalDeadlinesService.updateLegalDeadline(d.id, { description: 'descricao revisada' }, tenant.userId, transaction);
    assert.equal(again.status, 'DONE');
    assert.equal(again.description, 'descricao revisada');
    assert.equal(again.conclusionNote, 'Feito.');
  });
});

test('Nao e possivel esvaziar a nota de um prazo ja concluido que nao tem evidencia de arquivo (caminho vizinho)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const d = await pendingDeadline(transaction);
    await legalDeadlinesService.updateLegalDeadline(d.id, { status: 'DONE', conclusionNote: 'Feito.' }, tenant.userId, transaction);
    await assert.rejects(
      () => legalDeadlinesService.updateLegalDeadline(d.id, { conclusionNote: '   ' }, tenant.userId, transaction),
      expectCode('LEGAL_DEADLINE_CONCLUSION_PROOF_REQUIRED', 422)
    );
    const fresh = await LegalDeadline.findByPk(d.id, { transaction });
    assert.equal(fresh.conclusionNote, 'Feito.');
  });
});
