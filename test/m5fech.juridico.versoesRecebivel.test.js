'use strict';

/**
 * Fechamento do Marco 5 — Jurídico, segunda onda: notificações versionadas (DoD "☐ Aditivos/notificações
 * versionados") e recebível do processo só quando juridicamente cabível (§14). Postgres real com RLS, rollback.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, createTestResultCenter } = require('./testHelpers');
const { newCase, fakeFile } = require('./m5fech.juridico.helpers');
const noticesService = require('../src/features/legal/notices.service');
const noticeVersions = require('../src/features/legal/noticeVersions.service');
const receivables = require('../src/features/legal/legalCaseReceivables.service');
const legalCasesService = require('../src/features/legal/legalCases.service');
const { FinancialEntry } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const codeIs = (code) => (err) => { assert.equal(err.code, code); return true; };

test('JR notificação versionada: a versão 1 nasce com a notificação; corrigir cria a versão 2 (a 1 fica intacta), volta a DRAFT e só a versão aprovada sai', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const notice = await noticesService.createNotice({ legalCaseId: legalCase.id, channel: 'EMAIL', content: 'Texto v1 da notificação', draftedByAi: true }, tenant.userId, t);
    let versions = await noticeVersions.listNoticeVersions(notice.id, t);
    assert.deepEqual(versions.map((v) => [v.versionNumber, v.content]), [[1, 'Texto v1 da notificação']]);
    assert.match(versions[0].contentSha256, /^[0-9a-f]{64}$/);
    await noticesService.submitNoticeForReview(notice.id, tenant.userId, t);
    await assert.rejects(noticeVersions.createNoticeVersion(notice.id, { content: 'Texto v2' }, tenant.userId, t), codeIs('LEGAL_NOTICE_VALIDATION'));
    await assert.rejects(noticeVersions.createNoticeVersion(notice.id, { content: 'Texto v1 da notificação', reason: 'nada mudou' }, tenant.userId, t), codeIs('LEGAL_NOTICE_VERSION_UNCHANGED'));
    const file = await fakeFile(tenant, t);
    const { notice: v2 } = await noticeVersions.createNoticeVersion(notice.id, { content: 'Texto v2 corrigido', contentFileId: file.id, reason: 'Correção do valor devido' }, tenant.userId, t);
    assert.deepEqual([v2.currentVersion, v2.status, v2.approvedVersion, v2.content], [2, 'DRAFT', null, 'Texto v2 corrigido']);
    versions = await noticeVersions.listNoticeVersions(notice.id, t);
    assert.deepEqual(versions.map((v) => [v.versionNumber, v.content, v.contentFileId]), [[1, 'Texto v1 da notificação', null], [2, 'Texto v2 corrigido', file.id]]);
    // Rascunho da IA: precisa de nova revisão humana; a aprovação grava a versão aprovada.
    await assert.rejects(noticesService.approveNotice(notice.id, tenant.userId, t), codeIs('LEGAL_NOTICE_REVIEW_REQUIRED'));
    await noticesService.submitNoticeForReview(notice.id, tenant.userId, t);
    const approved = await noticesService.approveNotice(notice.id, tenant.userId, t);
    assert.equal(approved.approvedVersion, 2);
    await assert.rejects(noticeVersions.createNoticeVersion(notice.id, { content: 'v3', reason: 'tarde demais' }, tenant.userId, t), codeIs('LEGAL_NOTICE_VERSION_LOCKED'));
    const sent = await noticesService.sendNotice(notice.id, tenant.userId, t);
    assert.equal(sent.status, 'SENT');
    // O banco recusa reescrever ou apagar uma versão (append-only).
    await assert.rejects(sequelize.query("UPDATE legal.notice_versions SET content = 'adulterado' WHERE notice_id = :id", { replacements: { id: notice.id }, transaction: t }), /append-only|permission denied/);
  });
});

test('JR notificação versionada: enviar exige que a versão vigente seja a aprovada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const notice = await noticesService.createNotice({ legalCaseId: legalCase.id, channel: 'POSTAL_MAIL', content: 'Aviso v1' }, tenant.userId, t);
    await noticesService.approveNotice(notice.id, tenant.userId, t);
    await sequelize.query('UPDATE legal.notices SET current_version = 2 WHERE id = :id', { replacements: { id: notice.id }, transaction: t });
    await assert.rejects(noticesService.sendNotice(notice.id, tenant.userId, t), codeIs('LEGAL_NOTICE_SEND_BLOCKED'));
  });
});

test('JR recebível do processo: estimativa nunca vira lançamento; o valor confirmado com base jurídica (acordo/sentença) vira UM recebível vinculado, e o confirmado não muda depois', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const rc = await createTestResultCenter(tenant, t);
    const legalCase = await newCase(tenant, t, { estimatedAmount: 50000 });
    const body = { basis: 'SETTLEMENT', basisReference: 'Acordo homologado fictício nº 123', dueAt: '2030-03-10', resultCenterId: rc.id };
    const entriesBefore = await FinancialEntry.count({ transaction: t });
    await assert.rejects(receivables.linkCaseReceivable(legalCase.id, body, tenant.userId, t), codeIs('LEGAL_CASE_RECEIVABLE_NOT_CONFIRMED'));
    await legalCasesService.updateLegalCase(legalCase.id, { confirmedAmount: 32000 }, tenant.userId, t);
    await assert.rejects(receivables.linkCaseReceivable(legalCase.id, { ...body, basis: 'ESTIMATIVA' }, tenant.userId, t), codeIs('LEGAL_CASE_RECEIVABLE_BASIS_INVALID'));
    await assert.rejects(receivables.linkCaseReceivable(legalCase.id, { ...body, basisReference: '  ' }, tenant.userId, t), codeIs('LEGAL_CASE_RECEIVABLE_BASIS_INVALID'));
    assert.equal(await FinancialEntry.count({ transaction: t }), entriesBefore, 'nenhuma recusa criou lançamento');
    const link = await receivables.linkCaseReceivable(legalCase.id, body, tenant.userId, t);
    const entry = await FinancialEntry.findByPk(link.financialEntryId, { transaction: t });
    assert.deepEqual([entry.nature, Number(entry.amount), entry.originRef], ['RECEIVABLE', 32000, `legal.legal_cases:${legalCase.id}`]);
    assert.equal(Number(link.amount), 32000, 'o valor é o CONFIRMADO, não o estimado (50000)');
    assert.equal(await FinancialEntry.count({ transaction: t }), entriesBefore + 1);
    await assert.rejects(receivables.linkCaseReceivable(legalCase.id, body, tenant.userId, t), codeIs('LEGAL_CASE_RECEIVABLE_DUPLICATE'));
    await assert.rejects(legalCasesService.updateLegalCase(legalCase.id, { confirmedAmount: 40000 }, tenant.userId, t), codeIs('LEGAL_CASE_RECEIVABLE_LOCKED'));
    assert.equal((await receivables.listCaseReceivables(legalCase.id, t)).length, 1);
    await assert.rejects(sequelize.query('DELETE FROM legal.case_receivables WHERE legal_case_id = :id', { replacements: { id: legalCase.id }, transaction: t }), /append-only|permission denied/);
  });
});
