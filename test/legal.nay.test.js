'use strict';

// NAY Jurídica (Caderno Marco 5 §17, JUR-008, JUR-TS-012, Guia §10, DoD "NAY jurídica com
// confirmação humana em ações críticas"). Postgres real, NODE_ENV=test; serviço em transação com
// rollback e HTTP real (JWT + middlewares + rotas) com fixture commitada só no banco de teste.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.NAY_JUR_HTTP_TEST_PORT || '21642';

const app = require('../app'); // eslint-disable-line no-unused-vars
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { Company, Person } = require('../src/models');
const contractsService = require('../src/features/legal/contracts.service');
const contractVersionsService = require('../src/features/legal/contractVersions.service');
const requirementsService = require('../src/features/legal/requirements.service');
const guaranteesService = require('../src/features/legal/guarantees.service');
const legalCasesService = require('../src/features/legal/legalCases.service');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const evidencePackagesService = require('../src/features/legal/evidencePackages.service');
const contractClausesService = require('../src/features/legal/contractClauses.service');
const nay = require('../src/features/legal/legalNay.service');

let tenant;
let otherCompany;
let baseUrl;
const DAY = 86400000;

async function realCompany(groupId, name) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: groupId }, transaction });
    const [company] = await Company.findOrCreate({ where: { groupId, name }, defaults: { groupId, name }, transaction });
    return company;
  });
}

before(async () => {
  tenant = await getSeedTenant();
  const company = await realCompany(tenant.groupId, 'NAY-JUR empresa vizinha (teste)');
  otherCompany = { groupId: tenant.groupId, companyId: company.id };
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });

async function person(t, label) {
  return Person.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `${label} ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction: t }
  );
}

async function scenario(t) {
  const contract = await contractsService.createContract({ ...ctx(), contractType: 'LEASE_RESIDENTIAL', totalValue: 2500 }, tenant.userId, t);
  const locatario = await person(t, 'NAY-JUR Locatário');
  const fiador = await person(t, 'NAY-JUR Fiador');
  await contractsService.addContractParty(contract.id, { personId: locatario.id, partyRole: 'TENANT' }, tenant.userId, t);
  await contractsService.addContractParty(contract.id, { personId: fiador.id, partyRole: 'GUARANTOR' }, tenant.userId, t);
  const requirements = await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, t);
  const v1 = await contractVersionsService.createContractVersion(contract.id, { content: 'Cláusula 1 — objeto\nCláusula 2 — aluguel de R$ 2.000\nCláusula 3 — foro', requireDocument: false }, tenant.userId, t);
  const v2 = await contractVersionsService.createContractVersion(contract.id, { content: 'Cláusula 1 — objeto\nCláusula 2 — aluguel de R$ 2.500\nCláusula 3 — foro\nCláusula 4 — reajuste anual pelo IPCA', requireDocument: false }, tenant.userId, t);
  await guaranteesService.createGuarantee(contract.id, { guaranteeType: 'GUARANTOR', guarantorPersonId: fiador.id, startsAt: new Date(Date.now() - DAY), endsAt: new Date(Date.now() + 365 * DAY) }, tenant.userId, t);
  const legalCase = await legalCasesService.createLegalCase({ ...ctx(), contractId: contract.id, caseType: 'LITIGATION', caseNumber: `NAY-JUR-${uniqueSuffix()}`, summary: 'Despejo por falta de pagamento' }, tenant.userId, t);
  const deadline = await legalDeadlinesService.createLegalDeadline(legalCase.id, { description: 'Contestação', dueAt: new Date(Date.now() + 10 * DAY), sourceDocument: 'Mandado de citação' }, tenant.userId, t);
  const pkg = await evidencePackagesService.createEvidencePackage(legalCase.id, [{ type: 'FILE', description: 'Contrato assinado', referenceId: v2.id, hash: v2.contentHash }], tenant.userId, t);
  return { contract, locatario, fiador, requirements, v1, v2, legalCase, deadline, pkg };
}

async function fingerprint(t) {
  const [row] = await sequelize.query(
    `SELECT
      (SELECT COUNT(*) FROM legal.contract_versions)::int AS versions,
      (SELECT md5(COALESCE(string_agg(id::text || status, ',' ORDER BY id), '')) FROM legal.contracts) AS contracts,
      (SELECT md5(COALESCE(string_agg(id::text || status || due_at::text, ',' ORDER BY id), '')) FROM legal.legal_deadlines) AS deadlines,
      (SELECT md5(COALESCE(string_agg(id::text || status, ',' ORDER BY id), '')) FROM legal.contract_requirements) AS requirements,
      (SELECT md5(COALESCE(string_agg(id::text || COALESCE(condition_status,'') || is_active::text, ',' ORDER BY id), '')) FROM legal.contract_clauses) AS clauses,
      (SELECT md5(COALESCE(string_agg(id::text || package_hash, ',' ORDER BY id), '')) FROM legal.evidence_packages) AS packages`,
    { transaction: t, type: sequelize.QueryTypes.SELECT }
  );
  return row;
}

test('NAY-JUR-01: resumo do contrato traz status, partes, versão vigente com hash, garantias, documentos faltantes e prazos abertos, com fontes e aviso', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const s = await scenario(t);
    const out = await nay.summarizeContract(ctx(), s.contract.id, tenant.userId, t);
    assert.equal(out.contrato.status, s.contract.status);
    assert.equal(out.contrato.tipo, 'LEASE_RESIDENTIAL');
    assert.deepEqual(out.partes.map((p) => p.papel).sort(), ['GUARANTOR', 'TENANT']);
    assert.ok(out.partes.some((p) => p.nome === s.locatario.legalName));
    assert.equal(out.versaoVigente.numero, s.v2.versionNumber);
    assert.equal(out.versaoVigente.contentHash, s.v2.contentHash);
    assert.equal(out.totalVersoes, 2);
    assert.equal(out.garantias.length, 1);
    assert.equal(out.garantias[0].tipo, 'GUARANTOR');
    const pending = s.requirements.filter((r) => r.status === 'PENDING').length;
    assert.ok(pending > 0);
    assert.equal(out.documentosFaltantes.length, pending);
    assert.ok(out.pontosDeAtencao.some((p) => /documento\(s\) obrigatório\(s\) pendente/.test(p)));
    assert.deepEqual(out.prazosAbertos.map((d) => d.id), [s.deadline.id]);
    assert.ok(out.fontes.some((f) => f.tabela === 'legal.contract_versions' && f.contentHash === s.v2.contentHash));
    assert.match(out.aviso, /não é conclusão jurídica definitiva; requer validação profissional/i);

    const cs = await nay.summarizeCase(ctx(), s.legalCase.id, tenant.userId, t);
    assert.equal(cs.processo.numero, s.legalCase.caseNumber);
    assert.equal(cs.prazosAbertos.length, 1);
    assert.equal(cs.dossies[0].packageHash, s.pkg.packageHash);
    assert.match(cs.aviso, /validação profissional/);
  });
});

test('NAY-JUR-02: compara duas versões — linhas removidas/incluídas e hashes; versões iguais ou inexistentes são recusadas', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const s = await scenario(t);
    const out = await nay.compareContractVersions(ctx(), s.contract.id, s.v1.versionNumber, s.v2.versionNumber, tenant.userId, t);
    assert.deepEqual(out.linhasRemovidas, ['Cláusula 2 — aluguel de R$ 2.000']);
    assert.deepEqual(out.linhasIncluidas, ['Cláusula 2 — aluguel de R$ 2.500', 'Cláusula 4 — reajuste anual pelo IPCA']);
    assert.equal(out.hashIgual, false);
    assert.equal(out.de.contentHash, s.v1.contentHash);
    assert.equal(out.para.contentHash, s.v2.contentHash);
    await assert.rejects(() => nay.compareContractVersions(ctx(), s.contract.id, 1, 1, tenant.userId, t), (e) => e.code === 'LEGAL_NAY_COMPARE_VALIDATION');
    await assert.rejects(() => nay.compareContractVersions(ctx(), s.contract.id, 1, 99, tenant.userId, t), (e) => e.code === 'LEGAL_CONTRACT_VERSION_NOT_FOUND');
  });
});

test('NAY-JUR-03: minuta sugerida só com cláusulas homologadas — condição pendente de aprovação fica de fora', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const sfx = uniqueSuffix();
    const plain = await contractClausesService.createClause({ ...ctx(), code: `NAYJUR-P-${sfx}`, title: 'Foro', bodyText: 'Fica eleito o foro da comarca.', category: 'GENERAL' }, tenant.userId, t);
    const conditional = await contractClausesService.createClause(
      { ...ctx(), code: `NAYJUR-C-${sfx}`, title: 'Fiança', bodyText: 'O fiador responde solidariamente.', category: 'GENERAL', condition: { match: 'all', rules: [{ variable: 'hasGuarantor', operator: 'eq', value: true }] } },
      tenant.userId,
      t
    );
    assert.equal(conditional.conditionStatus, 'PENDING_APPROVAL');
    const out = await nay.suggestClauses(ctx(), { category: 'GENERAL' }, tenant.userId, t);
    const ids = out.clausulasSugeridas.map((c) => c.id);
    assert.ok(ids.includes(plain.id), 'cláusula ativa sem condição é sugerida');
    assert.ok(!ids.includes(conditional.id), 'condição não aprovada não entra');
    assert.ok(out.clausulasNaoHomologadasOmitidas >= 1);
    assert.match(out.aviso, /validação profissional/);
  });
});

test('NAY-JUR-04: prazos extraídos de texto são SUGESTÃO (PENDING_CONFIRMATION, não críticos) e nenhum prazo é criado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const s = await scenario(t);
    const [{ n: before }] = await sequelize.query('SELECT COUNT(*)::int AS n FROM legal.legal_deadlines', { transaction: t, type: sequelize.QueryTypes.SELECT });
    const out = await nay.suggestDeadlines(
      ctx(),
      { legalCaseId: s.legalCase.id, referenceDate: '2026-10-19T15:00:00Z', text: 'Fica o réu intimado para, no prazo de 15 dias úteis, apresentar contestação. Audiência designada para 10/12/2026.' },
      tenant.userId,
      t
    );
    assert.equal(out.sugestoes.length, 2);
    assert.ok(out.sugestoes.every((x) => x.status === 'PENDING_CONFIRMATION' && x.critico === false));
    const util = out.sugestoes.find((x) => x.tipo === 'PRAZO_DIAS_UTEIS');
    assert.equal(util.dias, 15);
    assert.equal(util.vencimentoSugerido.slice(0, 10), '2026-11-09');
    assert.equal(util.natureza, 'ESTIMADO');
    assert.equal(out.sugestoes.find((x) => x.tipo === 'DATA_EXPLICITA').vencimentoSugerido.slice(0, 10), '2026-12-10');
    assert.equal(out.prazosCriados, 0);
    const [{ n: afterCount }] = await sequelize.query('SELECT COUNT(*)::int AS n FROM legal.legal_deadlines', { transaction: t, type: sequelize.QueryTypes.SELECT });
    assert.equal(afterCount, before, 'sugestão não vira prazo');
    await assert.rejects(() => nay.suggestDeadlines(ctx(), { text: '   ' }, tenant.userId, t), (e) => e.code === 'LEGAL_NAY_TEXT_REQUIRED');
  });
});

test('NAY-JUR-05: dossiê organizado por fatos (ordem cronológica) e fontes, com sha256 de cada item do manifesto', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const s = await scenario(t);
    const out = await nay.organizeDossier(ctx(), s.legalCase.id, tenant.userId, t);
    const datas = out.fatos.map((f) => f.data);
    assert.deepEqual(datas, [...datas].sort());
    assert.ok(out.fatos.every((f) => f.fonte && f.fonte.tabela));
    assert.ok(out.fatos.some((f) => f.fonte.tabela === 'legal.evidence_packages' && f.fonte.sha256 === s.pkg.packageHash));
    assert.deepEqual(out.arquivos.map((a) => a.sha256), [s.v2.contentHash]);
    assert.match(out.aviso, /validação profissional/);
  });
});

test('NAY-JUR-06: não executa nada — versões, contratos, prazos, checklist, cláusulas e dossiês idênticos depois de todas as funções; só ai_runs cresce', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const s = await scenario(t);
    const before = await fingerprint(t);
    const [{ n: runsBefore }] = await sequelize.query("SELECT COUNT(*)::int AS n FROM ai.ai_runs WHERE agent_name = 'NAY_JURIDICA'", { transaction: t, type: sequelize.QueryTypes.SELECT });
    await nay.summarizeContract(ctx(), s.contract.id, tenant.userId, t);
    await nay.summarizeCase(ctx(), s.legalCase.id, tenant.userId, t);
    await nay.compareContractVersions(ctx(), s.contract.id, 1, 2, tenant.userId, t);
    await nay.suggestClauses(ctx(), {}, tenant.userId, t);
    await nay.suggestDeadlines(ctx(), { text: 'prazo de 5 dias' }, tenant.userId, t);
    await nay.organizeDossier(ctx(), s.legalCase.id, tenant.userId, t);
    assert.deepEqual(await fingerprint(t), before);
    const [{ n: runs }] = await sequelize.query("SELECT COUNT(*)::int AS n FROM ai.ai_runs WHERE agent_name = 'NAY_JURIDICA'", { transaction: t, type: sequelize.QueryTypes.SELECT });
    assert.equal(runs, runsBefore + 6);
  });
});

test('NAY-JUR-07 (HTTP): resumo e sugestão de prazos com legal:read = 200; sem legal:read = 403; contrato de outra empresa = 404', async () => {
  const token = (c, permissions) => signAccessToken({ sub: tenant.userId, group_id: c.groupId, company_id: c.companyId, roles: ['admin'], permissions });
  const http = async (tk, method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const writer = token(ctx(), ['legal:create', 'legal:read']);
  const created = await http(writer, 'POST', '/legal/contracts', { contractType: 'SERVICE', totalValue: 100 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;

  const ok = await http(token(ctx(), ['legal:read']), 'GET', `/legal/nay/contracts/${id}/summary`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.contrato.id, id);
  assert.match(ok.body.data.aviso, /validação profissional/);

  const denied = await http(token(ctx(), ['finance:read']), 'GET', `/legal/nay/contracts/${id}/summary`);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

  const cross = await http(token(otherCompany, ['legal:read']), 'GET', `/legal/nay/contracts/${id}/summary`);
  assert.equal(cross.status, 404, JSON.stringify(cross.body));
  assert.equal(cross.body.error.code, 'LEGAL_CONTRACT_NOT_FOUND');

  const sug = await http(token(ctx(), ['legal:read']), 'POST', '/legal/nay/deadline-suggestions', { text: 'Manifestar-se no prazo de 5 dias.' });
  assert.equal(sug.status, 200, JSON.stringify(sug.body));
  assert.equal(sug.body.data.prazosCriados, 0);
  assert.equal(sug.body.data.sugestoes[0].status, 'PENDING_CONFIRMATION');
  const sugDenied = await http(token(ctx(), []), 'POST', '/legal/nay/deadline-suggestions', { text: 'prazo de 5 dias' });
  assert.equal(sugDenied.status, 403);

  const clauses = await http(token(ctx(), ['legal:read']), 'GET', '/legal/nay/clause-suggestions');
  assert.equal(clauses.status, 200);
});
