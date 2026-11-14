'use strict';

/**
 * Fechamento do Marco 5 — Jurídico, processos (Caderno M5 §14). Postgres real com RLS, tudo em
 * transação desfeita no fim.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { newCase, newDeadline, fakeFile, FUTURE } = require('./m5fech.juridico.helpers');
const peopleService = require('../src/features/people/people.service');
const legalCasesService = require('../src/modules/legal/cases/legal-case.service');
const legalDeadlinesService = require('../src/modules/legal/cases/deadline.service');
const caseDocumentsService = require('../src/modules/legal/cases/legalCaseDocuments.service');
const timelineService = require('../src/modules/legal/cases/legalCaseTimeline.service');
const evidencePackagesService = require('../src/modules/legal/cases/evidence-package.service');
const noticesService = require('../src/modules/legal/contracts/application/notices.service');
const { FinancialEntry, LegalCase, OutboxEvent } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const codeIs = (code) => (err) => { assert.equal(err.code, code); return true; };

test('JR processo: tem número, órgão, classe, status, partes, valor, risco e responsável (§14)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t, { court: '1ª Vara Cível de Teste', caseClass: 'Despejo', estimatedAmount: 12500.5, riskLevel: 'high' });
    const person = await peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Réu JR ${uniqueSuffix()}` }, tenant.userId, t);
    await legalCasesService.addLegalCaseParty(legalCase.id, { personId: person.id, partyRole: 'DEFENDANT' }, tenant.userId, t);
    await assert.rejects(legalCasesService.addLegalCaseParty(legalCase.id, { personId: person.id, partyRole: 'DEFENDANT' }, tenant.userId, t), codeIs('LEGAL_CASE_PARTY_DUPLICATE'));
    await assert.rejects(legalCasesService.addLegalCaseParty(legalCase.id, { personId: person.id, partyRole: 'JUIZ' }, tenant.userId, t), codeIs('LEGAL_CASE_PARTY_VALIDATION'));
    const saved = await LegalCase.findByPk(legalCase.id, { transaction: t });
    assert.ok(saved.caseNumber && saved.caseNumber.startsWith('JR-'));
    assert.equal(saved.court, '1ª Vara Cível de Teste');
    assert.equal(saved.caseClass, 'Despejo');
    assert.equal(saved.status, 'OPEN');
    assert.equal(Number(saved.estimatedAmount), 12500.5);
    assert.equal(saved.riskLevel, 'HIGH');
    assert.equal(saved.responsibleUserId, tenant.userId);
    const parties = await legalCasesService.listLegalCaseParties(legalCase.id, t);
    assert.deepEqual(parties.map((p) => [p.personId, p.partyRole]), [[person.id, 'DEFENDANT']]);
    await assert.rejects(newCase(tenant, t, { riskLevel: 'ALTISSIMO' }), codeIs('LEGAL_CASE_VALIDATION'));
  });
});

test('JR processo: documento ligado por file_links entra no dossiê automático com hash, nome, data e origem do arquivo; arquivo inexistente é 404 (§14/§16)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const file = await fakeFile(tenant, t, { name: 'peticao-inicial.pdf' });
    const link = await caseDocumentsService.linkCaseDocument(legalCase.id, { fileId: file.id, purpose: 'petition' }, tenant.userId, t);
    assert.equal(link.purpose, 'PETITION');
    await assert.rejects(caseDocumentsService.linkCaseDocument(legalCase.id, { fileId: file.id }, tenant.userId, t), codeIs('LEGAL_CASE_DOCUMENT_DUPLICATE'));
    await assert.rejects(caseDocumentsService.linkCaseDocument(legalCase.id, { fileId: '00000000-0000-4000-8000-000000000000' }, tenant.userId, t), codeIs('LEGAL_CASE_DOCUMENT_FILE_NOT_FOUND'));
    const docs = await caseDocumentsService.listCaseDocuments(legalCase.id, t);
    assert.deepEqual(docs.map((d) => [d.fileId, d.checksumSha256]), [[file.id, file.checksumSha256]]);

    // Processo sem contrato: o dossiê automático monta só com os documentos do processo.
    const pkg = await evidencePackagesService.createEvidencePackageFromContractAttachments(legalCase.id, tenant.userId, t);
    assert.equal(pkg.manifestJson.length, 1);
    const item = pkg.manifestJson[0];
    assert.equal(item.type, 'CASE_DOCUMENT');
    assert.equal(item.fileId, file.id);
    assert.equal(item.hash, file.checksumSha256, 'hash real do arquivo, do servidor');
    assert.equal(item.originalName, 'peticao-inicial.pdf');
    assert.ok(item.createdAt && !Number.isNaN(Date.parse(item.createdAt)), 'data do arquivo no manifesto');
    assert.equal(item.source, 'people.file_links');
    assert.equal(item.referenceId, link.id, 'relação: o vínculo do processo');
    assert.equal(pkg.packageHash, evidencePackagesService.computePackageHash(pkg.manifestJson));
  });
});

test('JR processo: movimentação relevante (fase, legal hold, parte, documento, prazo, remarcação, conclusão, dossiê, notificação) aparece na linha do tempo (§14)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    await legalCasesService.updateLegalCase(legalCase.id, { phase: 'DISCOVERY' }, tenant.userId, t);
    const person = await peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Autor JR ${uniqueSuffix()}` }, tenant.userId, t);
    await legalCasesService.addLegalCaseParty(legalCase.id, { personId: person.id, partyRole: 'PLAINTIFF' }, tenant.userId, t);
    const file = await fakeFile(tenant, t);
    await caseDocumentsService.linkCaseDocument(legalCase.id, { fileId: file.id }, tenant.userId, t);
    const d = await newDeadline(legalCase.id, tenant, t);
    await legalDeadlinesService.updateLegalDeadline(d.id, { dueAt: FUTURE(30), changeReason: 'Prorrogação deferida pelo juízo' }, tenant.userId, t);
    await legalDeadlinesService.updateLegalDeadline(d.id, { status: 'DONE', conclusionNote: 'Manifestação protocolada.' }, tenant.userId, t);
    await evidencePackagesService.createEvidencePackage(legalCase.id, [{ type: 'NOTE', description: 'Nota fictícia' }], tenant.userId, t);
    await noticesService.createNotice({ legalCaseId: legalCase.id, recipientDescription: 'Destinatário de teste', channel: 'EMAIL', content: 'Notificação fictícia do processo' }, tenant.userId, t);
    await legalCasesService.setLegalHold(legalCase.id, { legalHold: true, reason: 'Preservação fictícia' }, tenant.userId, t);

    const { items } = await timelineService.getLegalCaseTimeline(legalCase.id, t);
    const types = new Set(items.map((i) => i.type));
    for (const type of ['CASE_OPENED', 'CASE_CHANGE', 'PARTY', 'DEADLINE', 'DEADLINE_CHANGE', 'EVIDENCE_PACKAGE', 'NOTICE']) assert.ok(types.has(type), `falta ${type} na linha do tempo`);
    const actions = items.map((i) => i.action).filter(Boolean);
    for (const action of ['legal.case.phase_change', 'legal.case.document_link', 'legal.case.legal_hold_set', 'legal.deadline.update']) assert.ok(actions.includes(action), `falta ${action}`);
    assert.ok(items.some((i) => i.type === 'DEADLINE_CHANGE' && /remarcado de .* — motivo: “Prorrogação deferida pelo juízo”/.test(i.summary) && i.details.changeReason === 'Prorrogação deferida pelo juízo'), 'a remarcação aparece com a justificativa');
    const times = items.map((i) => new Date(i.occurredAt).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => a - b), 'ordem cronológica');
    await assert.rejects(timelineService.getLegalCaseTimeline('00000000-0000-4000-8000-000000000000', t), codeIs('LEGAL_CASE_NOT_FOUND'));
  });
});

test('JR processo: valor estimado não vira recebível; valor confirmado fica separado do estimado (§14)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entriesBefore = await FinancialEntry.count({ transaction: t });
    const legalCase = await newCase(tenant, t, { estimatedAmount: 80000 });
    await legalCasesService.updateLegalCase(legalCase.id, { confirmedAmount: 50000 }, tenant.userId, t);
    const saved = await LegalCase.findByPk(legalCase.id, { transaction: t });
    assert.equal(Number(saved.estimatedAmount), 80000);
    assert.equal(Number(saved.confirmedAmount), 50000);
    assert.equal(await FinancialEntry.count({ transaction: t }), entriesBefore, 'nenhum lançamento/recebível nasce do processo');
    await assert.rejects(legalCasesService.updateLegalCase(legalCase.id, { estimatedAmount: -1 }, tenant.userId, t), codeIs('LEGAL_CASE_VALIDATION'));
  });
});

test('JR processo: o resumo da linha do tempo é português para gente — rótulos, nomes, data dd/mm/aaaa hh:mm de Brasília e origem descrita pelo arquivo/evento; códigos, ids e ISO ficam em details', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t, { caseType: 'LITIGATION' });
    await legalCasesService.updateLegalCase(legalCase.id, { phase: 'DISCOVERY' }, tenant.userId, t);
    const person = await peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Maria Réu ${uniqueSuffix()}` }, tenant.userId, t);
    await legalCasesService.addLegalCaseParty(legalCase.id, { personId: person.id, partyRole: 'DEFENDANT' }, tenant.userId, t);
    const file = await fakeFile(tenant, t, { name: 'intimacao-contestacao.pdf' });
    const byFile = await newDeadline(legalCase.id, tenant, t, { description: 'Contestação', dueAt: '2030-01-15T17:00:00-03:00', criticality: 'HIGH', sourceDocument: undefined, sourceFileId: file.id });
    const outbox = await OutboxEvent.findOne({ where: { aggregateId: legalCase.id, eventType: 'legal.case.created' }, transaction: t });
    await newDeadline(legalCase.id, tenant, t, { description: 'Réplica', sourceDocument: undefined, sourceFileId: undefined, sourceEventId: outbox.id });
    await legalDeadlinesService.updateLegalDeadline(byFile.id, { dueAt: '2030-01-20T17:00:00-03:00', changeReason: 'Prorrogação deferida' }, tenant.userId, t);
    await noticesService.createNotice({ legalCaseId: legalCase.id, recipientDescription: 'Destinatário de teste', channel: 'POSTAL_MAIL', content: 'Aviso' }, tenant.userId, t);
    await legalCasesService.setLegalHold(legalCase.id, { legalHold: true, reason: 'Preservação' }, tenant.userId, t);

    const { items } = await timelineService.getLegalCaseTimeline(legalCase.id, t);
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
    const CODES = /\b(LITIGATION|DISCOVERY|DEFENDANT|HIGH|MEDIUM|CRITICAL|POSTAL_MAIL|DRAFT|PENDING|DONE|legal\.[a-z_.]+|null|undefined)\b/;
    for (const item of items) {
      assert.doesNotMatch(item.summary, UUID, `id cru no resumo: ${item.summary}`);
      assert.doesNotMatch(item.summary, ISO, `data ISO no resumo: ${item.summary}`);
      assert.doesNotMatch(item.summary, CODES, `código cru no resumo: ${item.summary}`);
    }
    const text = items.map((i) => i.summary);
    assert.ok(text.includes(`Processo aberto (contencioso) nº ${legalCase.caseNumber}.`));
    assert.ok(text.includes('Fase do processo alterada de não informado para instrução.'));
    assert.ok(text.some((x) => x.startsWith(`Parte incluída: ${person.legalName} como réu`)));
    const deadlineText = text.find((x) => x.startsWith('Prazo cadastrado: “Contestação”'));
    assert.match(deadlineText, /vence em 15\/01\/2030 17:00 \(horário de Brasília\), criticidade alta/);
    assert.match(deadlineText, /origem: arquivo “intimacao-contestacao\.pdf”/);
    assert.match(text.find((x) => x.startsWith('Prazo cadastrado: “Réplica”')), /origem: evento do sistema \(abertura do processo em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\)/);
    assert.ok(text.includes('Prazo “Contestação”: remarcado de 15/01/2030 17:00 para 20/01/2030 17:00 — motivo: “Prorrogação deferida”.'));
    assert.ok(text.some((x) => x.startsWith('Notificação por correio — rascunho')));
    assert.ok(text.includes('Retenção legal (legal hold) ativada: “Preservação”.'));
    // Os dados crus continuam disponíveis, à parte.
    const deadlineItem = items.find((i) => i.type === 'DEADLINE' && i.referenceId === byFile.id);
    assert.deepEqual([deadlineItem.details.criticality, deadlineItem.details.sourceFileId], ['HIGH', file.id]);
    assert.match(deadlineItem.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(items.find((i) => i.action === 'legal.case.phase_change').details.to, 'DISCOVERY');
  });
});

