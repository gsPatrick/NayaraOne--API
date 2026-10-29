'use strict';

/**
 * Auditoria da cliente, Marco 5 (achado 3, contorno): caracteres invisiveis e valores que nao
 * sao texto nao valem como nota de conclusao nem como texto obrigatorio do prazo.
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

function expectCode(code, status) {
  return (err) => {
    assert.ok(err instanceof AppError, String(err));
    assert.equal(err.code, code);
    assert.equal(err.statusCode, status);
    return true;
  };
}

async function newCase(transaction) {
  return legalCasesService.createLegalCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `Invisivel ${uniqueSuffix()}`, responsibleUserId: tenant.userId },
    tenant.userId,
    transaction
  );
}

async function pending(transaction) {
  const legalCase = await newCase(transaction);
  const d = await legalDeadlinesService.createLegalDeadline(legalCase.id, { description: `Prazo ${uniqueSuffix()}`, dueAt: FUTURE(), sourceEvent: 'teste' }, tenant.userId, transaction);
  return { legalCase, d };
}

const INVISIVEIS = [
  '​', '­', '‎', '⁠', '‌', '‍', '﻿', '᠎', '‪', '‫', '‬', '‭', '‮',
  '⁡', '⁢', '⁣', '⁤', ' ', ' ', '　', '\u0007', '\u0000', 'ㅤ', '͏',
];

test('Nota feita so de caractere invisivel (ZWSP, hifen suave, marcas, espacos Unicode, controles): recusada (422) ao concluir', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { d } = await pending(transaction);
    for (const c of INVISIVEIS) {
      await assert.rejects(
        () => legalDeadlinesService.updateLegalDeadline(d.id, { status: 'DONE', conclusionNote: ` ${c}${c}\n${c} ` }, tenant.userId, transaction),
        expectCode('LEGAL_DEADLINE_CONCLUSION_PROOF_REQUIRED', 422)
      );
    }
    const fresh = await LegalDeadline.findByPk(d.id, { transaction });
    assert.equal(fresh.status, 'PENDING');
    assert.equal(fresh.conclusionNote, null);
  });
});

test('Nota que nao e texto (0, false, {}, []): recusada (400), nunca convertida em texto', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { d } = await pending(transaction);
    for (const nota of [0, false, {}, [], 123, ['x']]) {
      await assert.rejects(
        () => legalDeadlinesService.updateLegalDeadline(d.id, { status: 'DONE', conclusionNote: nota }, tenant.userId, transaction),
        expectCode('LEGAL_DEADLINE_VALIDATION', 400)
      );
    }
    assert.equal((await LegalDeadline.findByPk(d.id, { transaction })).status, 'PENDING');
  });
});

test('Nota valida com invisiveis nas pontas e aceita e normalizada; evidencia sozinha continua valendo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { d, legalCase } = await pending(transaction);
    const done = await legalDeadlinesService.updateLegalDeadline(d.id, { status: 'DONE', conclusionNote: '​  Peticao protocolada. ‎' }, tenant.userId, transaction);
    assert.equal(done.conclusionNote, 'Peticao protocolada.');
    // esvaziar a nota de um prazo concluido com so invisivel: recusado
    await assert.rejects(
      () => legalDeadlinesService.updateLegalDeadline(d.id, { conclusionNote: '​⁠' }, tenant.userId, transaction),
      expectCode('LEGAL_DEADLINE_CONCLUSION_PROOF_REQUIRED', 422)
    );
    assert.equal((await LegalDeadline.findByPk(d.id, { transaction })).conclusionNote, 'Peticao protocolada.');
    assert.ok(legalCase.id);
  });
});

test('Mesma classe nos vizinhos: descricao, origem e motivo so com invisivel/nao-texto sao recusados; dueAt invalido tambem', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const legalCase = await newCase(transaction);
    const base = { description: 'Prazo ok', dueAt: FUTURE(), sourceEvent: 'teste' };
    const create = (extra) => legalDeadlinesService.createLegalDeadline(legalCase.id, { ...base, ...extra }, tenant.userId, transaction);
    await assert.rejects(() => create({ description: '​  ' }), expectCode('LEGAL_DEADLINE_VALIDATION', 400));
    await assert.rejects(() => create({ description: { a: 1 } }), expectCode('LEGAL_DEADLINE_VALIDATION', 400));
    await assert.rejects(() => create({ description: 'x'.repeat(256) }), expectCode('LEGAL_DEADLINE_VALIDATION', 400));
    await assert.rejects(() => create({ sourceEvent: '​' }), expectCode('LEGAL_DEADLINE_SOURCE_REQUIRED', 400));
    await assert.rejects(() => create({ sourceEvent: ['x'] }), expectCode('LEGAL_DEADLINE_VALIDATION', 400));
    await assert.rejects(() => create({ dueAt: 'nao-e-data' }), expectCode('LEGAL_DEADLINE_VALIDATION', 400));
    await assert.rejects(() => create({ criticality: { x: 1 } }), expectCode('LEGAL_DEADLINE_VALIDATION', 400));
    const ok = await create({ description: '​ Prazo valido  ', sourceEvent: undefined, sourceDocument: ' Intimacao ' });
    assert.equal(ok.description, 'Prazo valido');
    assert.equal(ok.sourceDocument, 'Intimacao');

    const upd = (p) => legalDeadlinesService.updateLegalDeadline(ok.id, p, tenant.userId, transaction);
    await assert.rejects(() => upd({ description: '' }), expectCode('LEGAL_DEADLINE_VALIDATION', 400));
    await assert.rejects(() => upd({ description: '​' }), expectCode('LEGAL_DEADLINE_VALIDATION', 400));
    await assert.rejects(() => upd({ dueAt: FUTURE().getTime() + 86400000, changeReason: '​ ⁠' }), expectCode('LEGAL_DEADLINE_CHANGE_REASON_REQUIRED', 400));
    await assert.rejects(() => upd({ dueAt: 'xx' }), expectCode('LEGAL_DEADLINE_VALIDATION', 400));
    await assert.rejects(() => upd({ conclusionEvidenceFileId: 'nao-uuid' }), expectCode('LEGAL_DEADLINE_VALIDATION', 400));
    const changed = await upd({ dueAt: new Date(Date.now() + 40 * 86400000), changeReason: ' Prorrogado pelo juizo ', description: 'Descricao nova' });
    assert.equal(changed.description, 'Descricao nova');
  });
});
