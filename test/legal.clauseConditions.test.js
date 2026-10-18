'use strict';

/**
 * F01 (conferência Nayara 18/10/2026 — Caderno, Jurídico §6: "Cláusula condicional usa regras
 * declarativas, não texto livre executável"). Postgres real, RLS ativo, tudo em transação com
 * rollback. Cobre: condição verdadeira/falsa/ausente, all/any, cada operador, variáveis,
 * recusa de texto executável, ordem, aprovação com segregação, versão e preservação do
 * documento já emitido (hash).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const contractClausesService = require('../src/features/legal/contractClauses.service');
const contractTemplatesService = require('../src/features/legal/contractTemplates.service');
const contractsService = require('../src/features/legal/contracts.service');
const contractVersionsService = require('../src/features/legal/contractVersions.service');
const { evaluateCondition, validateCondition } = require('../src/features/legal/clauseConditions');
const { User, File } = require('../src/models');

let tenant;
let approverId;

before(async () => {
  tenant = await getSeedTenant();
  const [approver] = await User.findOrCreate({
    where: { email: 'homo-qa-clause-condition-approver@nayaraone.dev' },
    defaults: { name: 'HOMO QA — Aprovador de condição de cláusula', passwordHash: 'x', status: 'ACTIVE' },
  });
  approverId = approver.id;
});

after(async () => {
  await sequelize.close();
});

function expectCode(code) {
  return (err) => {
    assert.equal(err.code, code, `esperado ${code}, veio ${err.code}: ${err.message}`);
    return true;
  };
}

async function clause(transaction, { title, body, condition, approve = true }) {
  const created = await contractClausesService.createClause(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      code: `CND-${uniqueSuffix()}`,
      title,
      bodyText: body,
      category: 'GENERAL',
      condition,
    },
    tenant.userId,
    transaction
  );
  if (condition && approve) {
    return contractClausesService.approveClauseCondition(created.id, approverId, transaction);
  }
  return created;
}

async function templateWith(transaction, clauses) {
  const template = await contractTemplatesService.createTemplate(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', name: `Modelo condicional ${uniqueSuffix()}` },
    tenant.userId,
    transaction
  );
  let order = 1;
  for (const c of clauses) {
    await contractTemplatesService.addClauseToTemplate(template.id, { contractClauseId: c.id, sortOrder: order++ }, tenant.userId, transaction);
  }
  return template;
}

const FIADOR = { match: 'all', rules: [{ variable: 'guaranteeType', operator: 'eq', value: 'GUARANTOR' }] };

test('F01: condição verdadeira inclui, falsa exclui, sem condição inclui sempre', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const geral = await clause(transaction, { title: 'Objeto', body: 'Texto geral' });
    const fiador = await clause(transaction, { title: 'Fiança', body: 'Texto do fiador', condition: FIADOR });
    const template = await templateWith(transaction, [geral, fiador]);

    const comFiador = await contractTemplatesService.renderTemplate(template.id, transaction, {}, { guaranteeType: 'GUARANTOR' });
    assert.ok(comFiador.content.includes('Texto do fiador'));
    assert.ok(comFiador.content.includes('Texto geral'));
    assert.equal(comFiador.excludedClauses.length, 0);

    const comSeguro = await contractTemplatesService.renderTemplate(template.id, transaction, {}, { guaranteeType: 'INSURANCE' });
    assert.ok(!comSeguro.content.includes('Texto do fiador'), 'condição falsa exclui a cláusula');
    assert.ok(comSeguro.content.includes('Texto geral'), 'cláusula sem condição continua');
    assert.deepEqual(comSeguro.excludedClauses.map((c) => c.contractClauseId), [fiador.id], 'exclusão fica registrada');
  });
});

test('F01: combinação "all" exige todas as regras; "any" basta uma', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const rules = [
      { variable: 'propertyPurpose', operator: 'eq', value: 'COMMERCIAL' },
      { variable: 'termMonths', operator: 'gte', value: 60 },
    ];
    const todas = await clause(transaction, { title: 'Renovatória', body: 'Texto ALL', condition: { match: 'all', rules } });
    const qualquer = await clause(transaction, { title: 'Comercial ou longo', body: 'Texto ANY', condition: { match: 'any', rules } });
    const template = await templateWith(transaction, [todas, qualquer]);

    const soComercial = await contractTemplatesService.renderTemplate(template.id, transaction, {}, { propertyPurpose: 'COMMERCIAL', termMonths: 12 });
    assert.ok(!soComercial.content.includes('Texto ALL'));
    assert.ok(soComercial.content.includes('Texto ANY'));

    const ambas = await contractTemplatesService.renderTemplate(template.id, transaction, {}, { propertyPurpose: 'COMMERCIAL', termMonths: 60 });
    assert.ok(ambas.content.includes('Texto ALL'));
    assert.ok(ambas.content.includes('Texto ANY'));

    const nenhuma = await contractTemplatesService.renderTemplate(template.id, transaction, {}, { propertyPurpose: 'RESIDENTIAL', termMonths: 30 });
    assert.ok(!nenhuma.content.includes('Texto ALL'));
    assert.ok(!nenhuma.content.includes('Texto ANY'));
  });
});

test('F01: cada operador avalia como esperado (eq, neq, in, not_in, gt, gte, lt, lte, exists)', () => {
  const cases = [
    [{ variable: 'contractType', operator: 'eq', value: 'LEASE' }, { contractType: 'LEASE' }, true],
    [{ variable: 'contractType', operator: 'eq', value: 'LEASE' }, { contractType: 'SALE' }, false],
    [{ variable: 'hasGuarantor', operator: 'neq', value: true }, { hasGuarantor: false }, true],
    [{ variable: 'hasGuarantor', operator: 'neq', value: true }, { hasGuarantor: true }, false],
    [{ variable: 'tenantPersonType', operator: 'in', value: ['PJ'] }, { tenantPersonType: 'PJ' }, true],
    [{ variable: 'tenantPersonType', operator: 'in', value: ['PJ'] }, { tenantPersonType: 'PF' }, false],
    [{ variable: 'guaranteeType', operator: 'not_in', value: ['DEPOSIT', 'NONE'] }, { guaranteeType: 'INSURANCE' }, true],
    [{ variable: 'guaranteeType', operator: 'not_in', value: ['DEPOSIT', 'NONE'] }, { guaranteeType: 'DEPOSIT' }, false],
    [{ variable: 'totalValue', operator: 'gt', value: 1000 }, { totalValue: 1000.01 }, true],
    [{ variable: 'totalValue', operator: 'gt', value: 1000 }, { totalValue: 1000 }, false],
    [{ variable: 'termMonths', operator: 'gte', value: 30 }, { termMonths: 30 }, true],
    [{ variable: 'termMonths', operator: 'gte', value: 30 }, { termMonths: 29 }, false],
    [{ variable: 'termMonths', operator: 'lt', value: 12 }, { termMonths: 11 }, true],
    [{ variable: 'termMonths', operator: 'lt', value: 12 }, { termMonths: 12 }, false],
    [{ variable: 'termMonths', operator: 'lte', value: 12 }, { termMonths: 12 }, true],
    [{ variable: 'termMonths', operator: 'lte', value: 12 }, { termMonths: 13 }, false],
    [{ variable: 'guaranteeType', operator: 'exists', value: true }, { guaranteeType: 'DEPOSIT' }, true],
    [{ variable: 'guaranteeType', operator: 'exists', value: true }, {}, false],
    [{ variable: 'guaranteeType', operator: 'exists', value: false }, {}, true],
  ];
  for (const [rule, ctx, expected] of cases) {
    const cond = validateCondition({ match: 'all', rules: [rule] });
    assert.equal(evaluateCondition(cond, ctx), expected, `${rule.variable} ${rule.operator} ${JSON.stringify(rule.value)} com ${JSON.stringify(ctx)}`);
  }
});

test('F01: variável desconhecida, operador desconhecido e valor fora da lista são recusados na gravação', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, title: 'X', bodyText: 'Y', category: 'GENERAL' };
    await assert.rejects(
      () => contractClausesService.createClause({ ...base, code: `CND-${uniqueSuffix()}`, condition: { rules: [{ variable: 'saldoDevedor', operator: 'eq', value: 1 }] } }, tenant.userId, transaction),
      expectCode('LEGAL_CLAUSE_CONDITION_INVALID')
    );
    await assert.rejects(
      () => contractClausesService.createClause({ ...base, code: `CND-${uniqueSuffix()}`, condition: { rules: [{ variable: 'termMonths', operator: 'between', value: 1 }] } }, tenant.userId, transaction),
      expectCode('LEGAL_CLAUSE_CONDITION_INVALID')
    );
    await assert.rejects(
      () => contractClausesService.createClause({ ...base, code: `CND-${uniqueSuffix()}`, condition: { rules: [{ variable: 'contractType', operator: 'eq', value: 'ALUGUEL' }] } }, tenant.userId, transaction),
      expectCode('LEGAL_CLAUSE_CONDITION_INVALID')
    );
    await assert.rejects(
      () => contractClausesService.createClause({ ...base, code: `CND-${uniqueSuffix()}`, condition: { rules: [{ variable: 'termMonths', operator: 'in', value: [12] }] } }, tenant.userId, transaction),
      expectCode('LEGAL_CLAUSE_CONDITION_INVALID'),
      'operador incompatível com o tipo da variável'
    );
  });
});

test('F01: texto livre/executável é recusado — a regra só aceita dado estruturado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, title: 'X', bodyText: 'Y', category: 'GENERAL' };
    const tentativas = [
      'process.exit()',
      'contractType === "LEASE"',
      { rules: [{ variable: 'contractType', operator: 'eq', value: '${process.exit()}' }] },
      { rules: [{ variable: 'contractType', operator: 'eq', value: 'LEASE', expression: 'process.exit()' }] },
      { match: 'all', rules: [{ variable: 'contractType', operator: 'eq', value: 'LEASE' }], script: 'return true' },
      { match: 'eval', rules: [{ variable: 'contractType', operator: 'eq', value: 'LEASE' }] },
    ];
    for (const condition of tentativas) {
      await assert.rejects(
        () => contractClausesService.createClause({ ...base, code: `CND-${uniqueSuffix()}`, condition }, tenant.userId, transaction),
        expectCode('LEGAL_CLAUSE_CONDITION_INVALID'),
        `deveria recusar: ${JSON.stringify(condition)}`
      );
    }
  });
});

test('F01: ordem das cláusulas incluídas é preservada com cláusula excluída no meio', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const a = await clause(transaction, { title: 'A', body: 'Corpo A' });
    const b = await clause(transaction, { title: 'B', body: 'Corpo B', condition: FIADOR });
    const c = await clause(transaction, { title: 'C', body: 'Corpo C' });
    const d = await clause(transaction, { title: 'D', body: 'Corpo D', condition: { rules: [{ variable: 'hasGuarantor', operator: 'eq', value: false }] } });
    const template = await templateWith(transaction, [a, b, c, d]);

    const rendered = await contractTemplatesService.renderTemplate(template.id, transaction, {}, { guaranteeType: 'DEPOSIT', hasGuarantor: false });
    assert.deepEqual(rendered.clauses.map((x) => x.contractClauseId), [a.id, c.id, d.id]);
    assert.ok(rendered.content.indexOf('Corpo A') < rendered.content.indexOf('Corpo C'));
    assert.ok(rendered.content.indexOf('Corpo C') < rendered.content.indexOf('Corpo D'));
  });
});

test('F01: variável usada pela regra e ausente no contexto é erro, não exclusão silenciosa', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const fiador = await clause(transaction, { title: 'Fiança', body: 'Texto do fiador', condition: FIADOR });
    const template = await templateWith(transaction, [fiador]);
    await assert.rejects(
      () => contractTemplatesService.renderTemplate(template.id, transaction, {}, {}),
      expectCode('LEGAL_CLAUSE_CONDITION_CONTEXT_MISSING')
    );
    await assert.rejects(
      () => contractTemplatesService.renderTemplate(template.id, transaction, {}, { variavelInventada: 1 }),
      expectCode('LEGAL_CLAUSE_CONDITION_INVALID')
    );
  });
});

test('F01: condição não aprovada bloqueia a renderização; autor não aprova a própria condição', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const pendente = await clause(transaction, { title: 'Fiança', body: 'Texto do fiador', condition: FIADOR, approve: false });
    assert.equal(pendente.conditionStatus, 'PENDING_APPROVAL');
    const template = await templateWith(transaction, [pendente]);

    await assert.rejects(
      () => contractTemplatesService.renderTemplate(template.id, transaction, {}, { guaranteeType: 'GUARANTOR' }),
      expectCode('LEGAL_CLAUSE_CONDITION_NOT_APPROVED')
    );
    await assert.rejects(
      () => contractClausesService.approveClauseCondition(pendente.id, tenant.userId, transaction),
      expectCode('LEGAL_CLAUSE_CONDITION_SELF_APPROVAL_BLOCKED')
    );

    const aprovada = await contractClausesService.approveClauseCondition(pendente.id, approverId, transaction);
    assert.equal(aprovada.conditionStatus, 'APPROVED');
    assert.equal(aprovada.conditionApprovedBy, approverId);
    const rendered = await contractTemplatesService.renderTemplate(template.id, transaction, {}, { guaranteeType: 'GUARANTOR' });
    assert.ok(rendered.content.includes('Texto do fiador'));
  });
});

test('F01: mudar a condição cria nova versão; a versão anterior e o documento já emitido ficam intactos (hash igual)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const v1 = await clause(transaction, { title: 'Fiança', body: 'Texto do fiador', condition: FIADOR });
    const template = await templateWith(transaction, [v1]);
    const rendered = await contractTemplatesService.renderTemplate(template.id, transaction, {}, { guaranteeType: 'GUARANTOR' });

    const { contract } = await createLease(transaction);
    const suffix = uniqueSuffix();
    const file = await File.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, storageKey: `homo-qa/f01/${suffix}.pdf`, fileName: `contrato-${suffix}.pdf`, mimeType: 'application/pdf', uploadedByUserId: tenant.userId, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    const emitted = await contractVersionsService.createContractVersion(
      contract.id,
      { content: rendered.content, documentFileId: file.id, templateId: template.id, clauseVersionIds: rendered.clauses.map((c) => c.contractClauseId) },
      tenant.userId,
      transaction
    );
    const hashBefore = emitted.contentHash;

    const v2 = await contractClausesService.createClauseVersion(
      v1.code,
      { bodyText: 'Texto do fiador', condition: { rules: [{ variable: 'guaranteeType', operator: 'in', value: ['GUARANTOR', 'INSURANCE'] }] } },
      tenant.userId,
      transaction
    );
    assert.notEqual(v2.id, v1.id);
    assert.equal(v2.versionNumber, 2);
    assert.equal(v2.conditionStatus, 'PENDING_APPROVAL', 'regra nova nasce pendente de aprovação');

    const { ContractClause, ContractVersion } = require('../src/models');
    const v1Reloaded = await ContractClause.findByPk(v1.id, { transaction });
    assert.deepEqual(v1Reloaded.conditionJson, validateCondition(FIADOR), 'regra da v1 não foi reescrita');
    assert.equal(v1Reloaded.conditionStatus, 'APPROVED');

    const emittedReloaded = await ContractVersion.findByPk(emitted.id, { transaction });
    assert.equal(emittedReloaded.contentHash, hashBefore, 'documento emitido mantém o hash');
    assert.equal(emittedReloaded.content, rendered.content);
    assert.ok(emittedReloaded.clauseVersionIds.includes(v1.id));
    assert.ok(!emittedReloaded.clauseVersionIds.includes(v2.id));
  });
});

async function createLease(transaction) {
  const contract = await contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 2500 },
    tenant.userId,
    transaction
  );
  return { contract };
}
