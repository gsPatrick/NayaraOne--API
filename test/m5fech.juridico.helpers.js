'use strict';

// Apoio dos testes do fechamento do Marco 5, área Jurídico (não é teste): usuário, processo, prazo e arquivo fictícios.
const crypto = require('node:crypto');
const { uniqueSuffix } = require('./testHelpers');
const legalCasesService = require('../src/modules/legal/cases/legal-case.service');
const legalDeadlinesService = require('../src/modules/legal/cases/deadline.service');
const { File, User, UserMembership, OutboxEvent } = require('../src/models');
const { origemNaTransacao } = require('./helpers/prazoOrigem');

const FUTURE = (days = 20) => new Date(Date.now() + days * 86400000);
const PAST = (days = 3) => new Date(Date.now() - days * 86400000);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function newUser(tenant, transaction) {
  const sfx = uniqueSuffix();
  const user = await User.create({ name: `JR ${sfx}`, email: `jr-${sfx}@example.test`, passwordHash: 'x', status: 'ACTIVE' }, { transaction });
  await UserMembership.create({ userId: user.id, groupId: tenant.groupId, companyId: tenant.companyId, status: 'ACTIVE' }, { transaction });
  return user;
}

async function newCase(tenant, transaction, overrides = {}) {
  return legalCasesService.createLegalCase(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      caseType: 'LITIGATION',
      caseNumber: `JR-${uniqueSuffix()}`,
      summary: `Processo fictício JR ${uniqueSuffix()}`,
      responsibleUserId: tenant.userId,
      escalationUserId: tenant.userId,
      ...overrides,
    },
    tenant.userId,
    transaction
  );
}

/** Prazo com origem verificável (arquivo íntegro da empresa, Guia §12); `overrides` pode tirar a origem (sourceFileId: undefined). */
async function newDeadline(legalCaseId, tenant, transaction, overrides = {}) {
  return legalDeadlinesService.createLegalDeadline(
    legalCaseId,
    { description: `Prazo JR ${uniqueSuffix()}`, dueAt: FUTURE(), sourceDocument: 'Intimação fictícia JR', sourceFileId: await origemNaTransacao(tenant, transaction), ...overrides },
    tenant.userId,
    transaction
  );
}

/** Metadado de arquivo (sem bytes em disco) com SHA-256 conhecido, como os demais testes do Jurídico. */
async function fakeFile(tenant, transaction, { name, hash } = {}) {
  const sfx = uniqueSuffix();
  return File.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      storageKey: `jr/${sfx}.pdf`,
      fileName: name || `jr-prova-${sfx}.pdf`,
      mimeType: 'application/pdf',
      checksumSha256: hash || sha256(`jr-${sfx}`),
      uploadedByUserId: tenant.userId,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

async function outboxTypes(aggregateId, transaction) {
  const rows = await OutboxEvent.findAll({ where: { aggregateId }, transaction });
  return rows.map((r) => r.eventType).sort();
}

module.exports = { FUTURE, PAST, sha256, newUser, newCase, newDeadline, fakeFile, outboxTypes };
