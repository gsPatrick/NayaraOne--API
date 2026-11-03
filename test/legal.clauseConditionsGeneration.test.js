'use strict';

/**
 * F01 — cláusula condicional no CAMINHO REAL de geração do documento (revisão independente de
 * 19/10/2026 sobre a conferência Nayara de 18/10). test/legal.clauseConditions.test.js cobre o
 * motor de regras; aqui o foco é o que a revisão mostrou faltar: a ContractVersion emitida.
 *
 *  - B1: createContractVersion com `templateId` monta o texto no servidor — cláusula com
 *    condição pendente ou falsa nunca entra; texto/clauseVersionIds do cliente que divergem são
 *    recusados.
 *  - B2: o contexto vem do contrato (partes, garantias, imóvel, valor, prazo), nunca do corpo; o
 *    contexto usado e as cláusulas excluídas ficam gravados na versão.
 *  - I1: versão de cláusula substituída bloqueia o modelo em vez de sumir em silêncio.
 *  - I3: trigger de imutabilidade em legal.contract_clauses (SQL cru).
 *  - M1/M2: aprovação serializada, sem versão histórica e sem autor desconhecido.
 *  - HTTP: geração e aprovação pelas rotas reais (201/400/403/404).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.F01_GENERATION_HTTP_TEST_PORT || '21620';

const app = require('../app');
const {
  sequelize,
  getSeedTenant,
  withRollbackTenantTransaction,
  withTenantTransaction,
  uniqueSuffix,
} = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const contractClausesService = require('../src/features/legal/contractClauses.service');
const contractTemplatesService = require('../src/features/legal/contractTemplates.service');
const contractsService = require('../src/features/legal/contracts.service');
const contractVersionsService = require('../src/features/legal/contractVersions.service');
const guaranteesService = require('../src/features/legal/guarantees.service');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const { User, Company, ContractClause, ContractTemplate, ContractTemplateClause, ContractVersion, ContractParty, Contract } = require('../src/models');

void app;

let tenant;
let approver;
let baseUrl;
const committed = { clauseIds: [], templateIds: [], contractIds: [] };

const FIANCA = { match: 'all', rules: [{ variable: 'guaranteeType', operator: 'eq', value: 'GUARANTOR' }] };

before(async () => {
  tenant = await getSeedTenant();
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  [approver] = await User.findOrCreate({
    where: { email: 'homo-qa-f01-generation-approver@nayaraone.dev' },
    defaults: { name: 'HOMO QA — Aprovador F01 geração', passwordHash: 'x', status: 'ACTIVE' },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  try {
    await withTenantTransaction(tenant, async (t) => {
      if (committed.contractIds.length) {
        await ContractVersion.destroy({ where: { contractId: committed.contractIds }, transaction: t });
        await ContractParty.destroy({ where: { contractId: committed.contractIds }, force: true, transaction: t });
      }
      if (committed.templateIds.length) {
        await ContractTemplateClause.destroy({ where: { contractTemplateId: committed.templateIds }, transaction: t });
        await ContractTemplate.destroy({ where: { id: committed.templateIds }, transaction: t });
      }
      if (committed.clauseIds.length) await ContractClause.destroy({ where: { id: committed.clauseIds }, transaction: t });
      if (committed.contractIds.length) await Contract.destroy({ where: { id: committed.contractIds }, force: true, transaction: t });
    });
  } catch (err) {
    // Limpeza best-effort do banco de dev compartilhado; o resultado dos testes já foi decidido.
    console.warn('[F01 geração] limpeza parcial:', err.message);
  }
  await sequelize.close();
  process.exit(0);
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

async function createPerson(t, personType = 'PF') {
  return peopleService.createPerson(
    withTenant({ personType, legalName: `HOMO QA F01 ${personType} ${uniqueSuffix()}` }),
    tenant.userId,
    t
  );
}

async function createLease(t, fields = {}) {
  const contract = await contractsService.createContract(
    withTenant({ contractType: 'LEASE', totalValue: 1500, ...fields }),
    tenant.userId,
    t
  );
  const landlord = await createPerson(t, 'PF');
  const lessee = await createPerson(t, fields.lesseeType || 'PF');
  await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, t);
  await contractsService.addContractParty(contract.id, { personId: lessee.id, partyRole: 'TENANT' }, tenant.userId, t);
  return contract;
}

async function addGuarantor(t, contractId) {
  const guarantor = await createPerson(t, 'PF');
  return guaranteesService.createGuarantee(
    contractId,
    { guaranteeType: 'GUARANTOR', guarantorPersonId: guarantor.id, endsAt: '2030-12-31' },
    tenant.userId,
    t
  );
}

async function clause(t, { title, bodyText, condition, approve = true }) {
  const created = await contractClausesService.createClause(
    withTenant({ code: `F01G-${uniqueSuffix()}`, title, bodyText, category: 'GENERAL', condition }),
    tenant.userId,
    t
  );
  if (condition && approve) await contractClausesService.approveClauseCondition(created.id, approver.id, t);
  return created;
}

async function template(t, clauses, contractType = 'LEASE') {
  const tpl = await contractTemplatesService.createTemplate(
    withTenant({ contractType, name: `Modelo F01 ${uniqueSuffix()}` }),
    tenant.userId,
    t
  );
  for (const [index, c] of clauses.entries()) {
    await contractTemplatesService.addClauseToTemplate(tpl.id, { contractClauseId: c.id, sortOrder: index + 1 }, tenant.userId, t);
  }
  return tpl;
}

function generate(t, contractId, payload) {
  return contractVersionsService.createContractVersion(contractId, { requireDocument: false, ...payload }, tenant.userId, t);
}

async function savepointRejects(t, sql, replacements, pattern, message) {
  await sequelize.query('SAVEPOINT f01_guard', { transaction: t });
  await assert.rejects(() => sequelize.query(sql, { replacements, transaction: t }), pattern, message);
  await sequelize.query('ROLLBACK TO SAVEPOINT f01_guard', { transaction: t });
}

// ---------------------------------------------------------------------------------------------
// B1 / B2 — geração real
// ---------------------------------------------------------------------------------------------

test('F01-G1 (B1): cláusula com condição PENDENTE nunca entra no documento emitido — nem enviando o texto pronto', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const base = await clause(t, { title: 'DO OBJETO', bodyText: 'Texto base' });
    const pending = await clause(t, { title: 'DA FIANÇA', bodyText: 'Obrigações do fiador', condition: FIANCA, approve: false });
    const tpl = await template(t, [base, pending]);
    const contract = await createLease(t);
    await addGuarantor(t, contract.id);

    await assert.rejects(() => generate(t, contract.id, { templateId: tpl.id }), (err) => err.code === 'LEGAL_CLAUSE_CONDITION_NOT_APPROVED');
    await assert.rejects(
      () => generate(t, contract.id, {
        templateId: tpl.id,
        content: `${tpl.name}\n\nDO OBJETO\nTexto base\n\nDA FIANÇA\nObrigações do fiador`,
        clauseVersionIds: [base.id, pending.id],
      }),
      (err) => err.code === 'LEGAL_CLAUSE_CONDITION_NOT_APPROVED'
    );
    assert.equal(await ContractVersion.count({ where: { contractId: contract.id }, transaction: t }), 0, 'nenhuma versão gravada');
  });
});

test('F01-G2 (B1/B2): a condição é avaliada com os dados do PRÓPRIO contrato — sem garantia exclui a fiança, com fiador ativo inclui', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const base = await clause(t, { title: 'DO OBJETO', bodyText: 'Texto base' });
    const fianca = await clause(t, { title: 'DA FIANÇA', bodyText: 'Obrigações do fiador', condition: FIANCA });
    const tpl = await template(t, [base, fianca]);

    const semGarantia = await createLease(t);
    const v1 = await generate(t, semGarantia.id, { templateId: tpl.id });
    assert.ok(!v1.content.includes('Obrigações do fiador'), 'condição falsa: cláusula fora do documento');
    assert.deepEqual(v1.clauseVersionIds.map((c) => c.contractClauseId), [base.id]);
    assert.equal(v1.conditionContext.source, 'CONTRACT');
    assert.equal(v1.conditionContext.values.guaranteeType, 'NONE');
    assert.equal(v1.conditionContext.values.hasGuarantor, false);
    assert.deepEqual(v1.excludedClauses.map((c) => [c.contractClauseId, c.reason]), [[fianca.id, 'CONDITION_FALSE']]);

    const comFiador = await createLease(t);
    await addGuarantor(t, comFiador.id);
    const v2 = await generate(t, comFiador.id, { templateId: tpl.id });
    assert.ok(v2.content.includes('Obrigações do fiador'), 'condição verdadeira: cláusula no documento');
    assert.deepEqual(v2.clauseVersionIds.map((c) => c.contractClauseId), [base.id, fianca.id]);
    assert.equal(v2.conditionContext.values.guaranteeType, 'GUARANTOR');
    assert.deepEqual(v2.excludedClauses, []);

    // O que ficou gravado é o que o banco devolve (persistência, não só o objeto em memória).
    const stored = await ContractVersion.findByPk(v1.id, { transaction: t });
    assert.equal(stored.conditionContext.values.guaranteeType, 'NONE');
    assert.equal(stored.excludedClauses[0].reason, 'CONDITION_FALSE');
  });
});

test('F01-G3 (B2): contexto informado pelo cliente não decide nada — recusado no corpo da geração', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const fianca = await clause(t, { title: 'DA FIANÇA', bodyText: 'Obrigações do fiador', condition: FIANCA });
    const tpl = await template(t, [fianca]);
    const contract = await createLease(t);
    await assert.rejects(
      () => generate(t, contract.id, { templateId: tpl.id, conditionContext: { guaranteeType: 'GUARANTOR' } }),
      (err) => err.code === 'LEGAL_CONTRACT_VERSION_CONTEXT_NOT_ACCEPTED'
    );
  });
});

test('F01-G4 (B1): texto do cliente que inclui cláusula de condição falsa é recusado; o mesmo texto do servidor é aceito', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const base = await clause(t, { title: 'DO OBJETO', bodyText: 'Texto base' });
    const fianca = await clause(t, { title: 'DA FIANÇA', bodyText: 'Obrigações do fiador', condition: FIANCA });
    const tpl = await template(t, [base, fianca]);
    const contract = await createLease(t);

    await assert.rejects(
      () => generate(t, contract.id, { templateId: tpl.id, content: `${tpl.name}\n\nDO OBJETO\nTexto base\n\nDA FIANÇA\nObrigações do fiador` }),
      (err) => err.code === 'LEGAL_CONTRACT_VERSION_CONTENT_MISMATCH'
    );
    const ok = await generate(t, contract.id, { templateId: tpl.id, content: `${tpl.name}\n\nDO OBJETO\nTexto base` });
    assert.ok(!ok.content.includes('fiador'));
  });
});

test('F01-G5 (B2): variáveis derivadas do contrato — valor (DECIMAL), prazo, tipo de pessoa e finalidade', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const altoValor = await clause(t, { title: 'DO SEGURO OBRIGATÓRIO', bodyText: 'Valor alto', condition: { match: 'all', rules: [{ variable: 'totalValue', operator: 'gte', value: 5000 }] } });
    const longo = await clause(t, { title: 'DO REAJUSTE', bodyText: 'Prazo longo', condition: { match: 'all', rules: [{ variable: 'termMonths', operator: 'gte', value: 30 }] } });
    const pj = await clause(t, { title: 'DO REPRESENTANTE LEGAL', bodyText: 'Locatário PJ', condition: { match: 'all', rules: [{ variable: 'tenantPersonType', operator: 'eq', value: 'PJ' }] } });
    const comercial = await clause(t, { title: 'DO PONTO COMERCIAL', bodyText: 'Uso comercial', condition: { match: 'all', rules: [{ variable: 'propertyPurpose', operator: 'eq', value: 'COMMERCIAL' }] } });
    const tpl = await template(t, [altoValor, longo, pj, comercial], 'LEASE_COMMERCIAL');

    const contract = await createLease(t, {
      contractType: 'LEASE_COMMERCIAL',
      totalValue: '8000.50',
      startsAt: '2026-01-01T12:00:00Z',
      endsAt: '2028-12-31T12:00:00Z',
      lesseeType: 'PJ',
    });
    const version = await generate(t, contract.id, { templateId: tpl.id });
    const values = version.conditionContext.values;
    assert.equal(values.totalValue, 8000.5);
    assert.equal(typeof values.totalValue, 'number');
    assert.equal(values.termMonths, 36);
    assert.equal(values.tenantPersonType, 'PJ');
    assert.equal(values.propertyPurpose, 'COMMERCIAL');
    for (const text of ['Valor alto', 'Prazo longo', 'Locatário PJ', 'Uso comercial']) assert.ok(version.content.includes(text), text);

    // Finalidade pelo tipo do imóvel quando o contrato não traz subtipo.
    const property = await propertiesService.createProperty(
      withTenant({ title: `F01 imóvel ${uniqueSuffix()}`, internalCode: `F01-${uniqueSuffix()}`, propertyType: 'RESIDENTIAL' }),
      tenant.userId,
      t
    );
    const generic = await createLease(t, { propertyId: property.id, totalValue: 900 });
    const tplRes = await template(t, [comercial, altoValor]);
    const vRes = await generate(t, generic.id, { templateId: tplRes.id });
    assert.equal(vRes.conditionContext.values.propertyPurpose, 'RESIDENTIAL');
    assert.equal(vRes.content.includes('Uso comercial'), false);
    assert.equal(vRes.excludedClauses.length, 2);
  });
});

test('F01-G6 (B2): duas modalidades de garantia ativas — a cláusula que depende do tipo de garantia não é decidida às cegas', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const fianca = await clause(t, { title: 'DA FIANÇA', bodyText: 'Obrigações do fiador', condition: FIANCA });
    const tpl = await template(t, [fianca]);
    const contract = await createLease(t);
    await addGuarantor(t, contract.id);
    await guaranteesService.createGuarantee(contract.id, { guaranteeType: 'DEPOSIT', value: 3000 }, tenant.userId, t);
    await assert.rejects(
      () => generate(t, contract.id, { templateId: tpl.id }),
      (err) => err.code === 'LEGAL_CLAUSE_CONDITION_CONTEXT_AMBIGUOUS' && /8\.245/.test(err.message)
    );
  });
});

test('F01-G7: clauseVersionIds divergente é recusado; sem modelo, clauseVersionIds não pode ser informado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const base = await clause(t, { title: 'DO OBJETO', bodyText: 'Texto base' });
    const fianca = await clause(t, { title: 'DA FIANÇA', bodyText: 'Obrigações do fiador', condition: FIANCA });
    const tpl = await template(t, [base, fianca]);
    const contract = await createLease(t);
    await assert.rejects(
      () => generate(t, contract.id, { templateId: tpl.id, clauseVersionIds: [base.id, fianca.id] }),
      (err) => err.code === 'LEGAL_CONTRACT_VERSION_CLAUSES_MISMATCH'
    );
    await assert.rejects(
      () => generate(t, contract.id, { content: 'Documento avulso', clauseVersionIds: [base.id] }),
      (err) => err.code === 'LEGAL_CONTRACT_VERSION_VALIDATION'
    );
  });
});

// ---------------------------------------------------------------------------------------------
// I1 — versão de cláusula substituída / retirada
// ---------------------------------------------------------------------------------------------

test('F01-G8 (I1): versão substituída bloqueia o modelo; o upgrade é deliberado e a nova regra só vale depois de aprovada; documento emitido não muda', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const fianca = await clause(t, { title: 'DA FIANÇA', bodyText: 'Fiança v1', condition: FIANCA });
    const tpl = await template(t, [fianca]);
    const contract = await createLease(t);
    await addGuarantor(t, contract.id);
    const emitted = await generate(t, contract.id, { templateId: tpl.id });
    assert.ok(emitted.content.includes('Fiança v1'));

    const v2 = await contractClausesService.createClauseVersion(fianca.code, { bodyText: 'Fiança v2' }, tenant.userId, t);
    assert.equal(v2.conditionStatus, 'PENDING_APPROVAL', 'nova versão com regra nasce pendente');

    await assert.rejects(() => generate(t, contract.id, { templateId: tpl.id }), (err) => err.code === 'LEGAL_TEMPLATE_CLAUSE_SUPERSEDED');

    const upgraded = await contractTemplatesService.upgradeTemplateClause(tpl.id, fianca.id, tenant.userId, t);
    assert.equal(upgraded.to.id, v2.id);
    await assert.rejects(() => generate(t, contract.id, { templateId: tpl.id }), (err) => err.code === 'LEGAL_CLAUSE_CONDITION_NOT_APPROVED');

    await contractClausesService.approveClauseCondition(v2.id, approver.id, t);
    const second = await generate(t, contract.id, { templateId: tpl.id });
    assert.ok(second.content.includes('Fiança v2'));
    assert.deepEqual(second.clauseVersionIds.map((c) => c.versionNumber), [2]);

    const firstReloaded = await ContractVersion.findByPk(emitted.id, { transaction: t });
    assert.equal(firstReloaded.contentHash, emitted.contentHash, 'documento emitido preservado');
    assert.ok(firstReloaded.content.includes('Fiança v1'));
  });
});

test('F01-G9 (I1): cláusula retirada de circulação sai do documento e fica registrada com o motivo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const base = await clause(t, { title: 'DO OBJETO', bodyText: 'Texto base' });
    const retirada = await clause(t, { title: 'DA MULTA ANTIGA', bodyText: 'Multa antiga' });
    const tpl = await template(t, [base, retirada]);
    await contractClausesService.deactivateClause(retirada.id, tenant.userId, t);
    const contract = await createLease(t);
    const version = await generate(t, contract.id, { templateId: tpl.id });
    assert.ok(!version.content.includes('Multa antiga'));
    assert.deepEqual(version.excludedClauses.map((c) => [c.contractClauseId, c.reason]), [[retirada.id, 'CLAUSE_RETIRED']]);
  });
});

// ---------------------------------------------------------------------------------------------
// I3 — trigger de imutabilidade; M1/M2 — aprovação
// ---------------------------------------------------------------------------------------------

test('F01-G10 (I3): no BANCO, texto, regra, reativação e autoaprovação são recusados; a aprovação legítima passa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await clause(t, { title: 'DA FIANÇA', bodyText: 'Original', condition: FIANCA, approve: false });
    const sql = (set) => `UPDATE legal.contract_clauses SET ${set} WHERE id = :id`;

    await savepointRejects(t, sql("body_text = 'Adulterado'"), { id: c.id }, /append-only/, 'texto imutável');
    await savepointRejects(t, sql(`condition_json = '{"match":"all","rules":[{"variable":"guaranteeType","operator":"eq","value":"DEPOSIT"}]}'::jsonb`), { id: c.id }, /append-only/, 'regra imutável');
    await savepointRejects(
      t,
      sql("condition_status = 'APPROVED', condition_approved_by = created_by, condition_approved_at = now()"),
      { id: c.id },
      /aprovação da condição/,
      'autor não aprova a própria regra nem por SQL'
    );

    await sequelize.query(sql("condition_status = 'APPROVED', condition_approved_by = :approver, condition_approved_at = now()"), {
      replacements: { id: c.id, approver: approver.id },
      transaction: t,
    });
    await savepointRejects(t, sql("condition_status = 'PENDING_APPROVAL', condition_approved_by = NULL, condition_approved_at = NULL"), { id: c.id }, /aprovação da condição/, 'aprovação não volta atrás');

    await sequelize.query(sql('is_active = false'), { replacements: { id: c.id }, transaction: t });
    await savepointRejects(t, sql('is_active = true'), { id: c.id }, /não volta a ficar ativa/, 'versão retirada não reativa');
  });
});

test('F01-G11 (M1/M2): não aprova versão histórica, nem versão sem autor; segunda aprovação é recusada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const v1 = await clause(t, { title: 'DA FIANÇA', bodyText: 'v1', condition: FIANCA, approve: false });
    await contractClausesService.createClauseVersion(v1.code, { bodyText: 'v2' }, tenant.userId, t);
    await assert.rejects(() => contractClausesService.approveClauseCondition(v1.id, approver.id, t), (err) => err.code === 'LEGAL_CLAUSE_CONDITION_VERSION_INACTIVE');

    const semAutor = await contractClausesService.createClause(
      withTenant({ code: `F01G-NOAUTH-${uniqueSuffix()}`, title: 'X', bodyText: 'Y', category: 'GENERAL', condition: FIANCA }),
      null,
      t
    );
    await assert.rejects(() => contractClausesService.approveClauseCondition(semAutor.id, approver.id, t), (err) => err.code === 'LEGAL_CLAUSE_CONDITION_AUTHOR_UNKNOWN');

    const ok = await clause(t, { title: 'DA FIANÇA', bodyText: 'ok', condition: FIANCA, approve: false });
    await contractClausesService.approveClauseCondition(ok.id, approver.id, t);
    await assert.rejects(() => contractClausesService.approveClauseCondition(ok.id, approver.id, t), (err) => err.code === 'LEGAL_CLAUSE_CONDITION_ALREADY_APPROVED');
  });
});

// ---------------------------------------------------------------------------------------------
// HTTP real
// ---------------------------------------------------------------------------------------------

function token(ctx, permissions, sub = tenant.userId) {
  return signAccessToken({ sub, group_id: ctx.groupId, company_id: ctx.companyId, roles: ['f01'], permissions });
}

async function http(method, path, { ctx = tenant, permissions, sub, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(ctx, permissions, sub)}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function committedFixture() {
  return withTenantTransaction(tenant, async (t) => {
    const base = await clause(t, { title: 'DO OBJETO', bodyText: 'Texto base HTTP' });
    const fianca = await clause(t, { title: 'DA FIANÇA', bodyText: 'Fiança HTTP', condition: FIANCA });
    const pending = await clause(t, { title: 'DA CAUÇÃO', bodyText: 'Caução HTTP', condition: { match: 'all', rules: [{ variable: 'guaranteeType', operator: 'eq', value: 'DEPOSIT' }] }, approve: false });
    const tpl = await template(t, [base, fianca]);
    const contract = await createLease(t);
    committed.clauseIds.push(base.id, fianca.id, pending.id);
    committed.templateIds.push(tpl.id);
    committed.contractIds.push(contract.id);
    return { base, fianca, pending, tpl, contract };
  });
}

test('F01-H1 (HTTP): geração pela rota real monta o documento no servidor e grava contexto e excluídas; contexto no corpo dá 400', async () => {
  const fx = await committedFixture();
  const legal = ['legal:create', 'legal:read'];

  const rejected = await http('POST', `/legal/contracts/${fx.contract.id}/versions`, {
    permissions: legal,
    body: { templateId: fx.tpl.id, requireDocument: false, conditionContext: { guaranteeType: 'GUARANTOR' } },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'LEGAL_CONTRACT_VERSION_CONTEXT_NOT_ACCEPTED');

  const renderRejected = await http('POST', `/legal/contract-templates/${fx.tpl.id}/render`, {
    permissions: legal,
    body: { conditionContext: { guaranteeType: 'GUARANTOR' } },
  });
  assert.equal(renderRejected.status, 400);
  assert.equal(renderRejected.body.error.code, 'LEGAL_TEMPLATE_RENDER_CONTEXT_NOT_ACCEPTED');

  const preview = await http('POST', `/legal/contract-templates/${fx.tpl.id}/render`, { permissions: legal, body: { contractId: fx.contract.id } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.data.contextSource, 'CONTRACT');
  assert.equal(preview.body.data.simulation, false);
  assert.deepEqual(preview.body.data.excludedClauses.map((c) => c.contractClauseId), [fx.fianca.id]);

  const simulated = await http('POST', `/legal/contract-templates/${fx.tpl.id}/render`, { permissions: legal, body: { simulationContext: { guaranteeType: 'GUARANTOR' } } });
  assert.equal(simulated.status, 200);
  assert.equal(simulated.body.data.simulation, true);

  const created = await http('POST', `/legal/contracts/${fx.contract.id}/versions`, {
    permissions: legal,
    body: { templateId: fx.tpl.id, requireDocument: false, variables: {} },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.content, preview.body.data.content, 'geração real = preview do mesmo contrato');
  assert.ok(!created.body.data.content.includes('Fiança HTTP'));
  assert.equal(created.body.data.conditionContext.values.guaranteeType, 'NONE');
  assert.equal(created.body.data.excludedClauses[0].reason, 'CONDITION_FALSE');
});

test('F01-H2 (HTTP): aprovação — 403 sem legal:approve, 200 por outro usuário com legal:approve, 404 de outra empresa', async () => {
  const fx = await committedFixture();
  const path = `/legal/clauses/${fx.pending.id}/approve-condition`;

  const noPermission = await http('POST', path, { permissions: ['legal:read', 'legal:create'], sub: approver.id });
  assert.equal(noPermission.status, 403);

  const companyB = await sequelize.transaction(async (t) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: tenant.groupId }, transaction: t });
    const [company] = await Company.findOrCreate({
      where: { groupId: tenant.groupId, name: 'HOMO QA — F01 Empresa B (cláusulas)' },
      defaults: { groupId: tenant.groupId, name: 'HOMO QA — F01 Empresa B (cláusulas)' },
      transaction: t,
    });
    return company;
  });
  const crossTenant = await http('POST', path, { ctx: { groupId: tenant.groupId, companyId: companyB.id }, permissions: ['legal:approve'], sub: approver.id });
  assert.equal(crossTenant.status, 404);

  const ok = await http('POST', path, { permissions: ['legal:approve'], sub: approver.id });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.conditionStatus, 'APPROVED');
  assert.equal(ok.body.data.conditionApprovedBy, approver.id);
});
