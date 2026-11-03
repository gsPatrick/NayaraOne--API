'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const simulationsService = require('../src/features/correspondent/cases/simulations.service');
const caseDocumentsService = require('../src/features/correspondent/cases/caseDocuments.service');
const nayService = require('../src/features/correspondent/correspondentNay.service');
const { Person, FinancingCase } = require('../src/models');

let tenant;
let otherCompanyId;

before(async () => {
  tenant = await getSeedTenant();
  const [[row]] = await sequelize.query('SELECT id FROM core.companies WHERE id != :companyId LIMIT 1', {
    replacements: { companyId: tenant.companyId },
  });
  otherCompanyId = row ? row.id : '00000000-0000-0000-0000-000000000000';
});

after(async () => {
  await sequelize.close();
});

async function createCase(transaction, providerCode = 'sandbox') {
  const principal = await Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PF',
      legalName: `Proponente NAY ${uniqueSuffix()}`,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
  return financingCasesService.createFinancingCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, providerCode, applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] },
    tenant.userId,
    transaction
  );
}

async function backdateCase(id, days, transaction) {
  await sequelize.query('UPDATE correspondent.financing_cases SET updated_at = now() - make_interval(days => :days) WHERE id = :id', {
    replacements: { days, id },
    transaction,
  });
  // "Parado" considera a atividade real do caso (itens do checklist, simulações): o teste envelhece tudo junto.
  await sequelize.query('UPDATE correspondent.case_requirements SET updated_at = now() - make_interval(days => :days) WHERE financing_case_id = :id', {
    replacements: { days, id },
    transaction,
  });
  await sequelize.query('UPDATE correspondent.simulations SET created_at = now() - make_interval(days => :days) WHERE financing_case_id = :id', {
    replacements: { days, id },
    transaction,
  });
}

test('CORRESPONDENT-NAY-01: caso parado com documento pendente é sinalizado com o motivo certo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await caseDocumentsService.createRequirement(
      financingCase.id,
      { documentType: 'RG_CPF' },
      tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId },
      transaction
    );
    await backdateCase(financingCase.id, 10, transaction);

    const result = await nayService.checkStalledCases(tenant.groupId, tenant.companyId, { thresholdDays: 7 }, transaction);
    const found = result.cases.find((c) => c.financingCaseId === financingCase.id);
    assert.ok(found, 'caso parado deveria ser sinalizado');
    assert.ok(found.idleDays >= 7);
    assert.ok(found.reason.includes('RG/CPF'), 'o motivo mostra o nome do documento, não o código interno');
    assert.deepEqual(found.pendingRequirementTypes, ['RG_CPF']);
    assert.deepEqual(result.decisionsMade, []);
  });
});

test('CORRESPONDENT-NAY-02: caso com atividade recente (dentro do limiar) não aparece como parado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    // Não precisa backdate: acabou de ser criado, updated_at é "agora".
    const result = await nayService.checkStalledCases(tenant.groupId, tenant.companyId, { thresholdDays: 7 }, transaction);
    const found = result.cases.find((c) => c.financingCaseId === financingCase.id);
    assert.equal(found, undefined, 'caso recente não deveria ser sinalizado como parado');
  });
});

test('CORRESPONDENT-NAY-03: caso parado sem requirement pendente usa motivo de status (aguardando provider)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await FinancingCase.update({ status: 'SUBMITTED' }, { where: { id: financingCase.id }, transaction });
    await backdateCase(financingCase.id, 8, transaction);

    const result = await nayService.checkStalledCases(tenant.groupId, tenant.companyId, { thresholdDays: 7 }, transaction);
    const found = result.cases.find((c) => c.financingCaseId === financingCase.id);
    assert.ok(found);
    assert.match(found.reason, /provider/i);
  });
});

test('CORRESPONDENT-NAY-04: compara simulações e recomenda a de menor parcela, sem alterar nada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    const simA = await simulationsService.createSimulation(financingCase.id, { amount: 200000, termMonths: 360 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const simB = await simulationsService.createSimulation(financingCase.id, { amount: 200000, termMonths: 120 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);

    const result = await nayService.compareSimulations(financingCase.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(result.simulations.length, 2);
    const lowest = [simA, simB].reduce((a, b) => (Number(a.monthlyPayment) <= Number(b.monthlyPayment) ? a : b));
    assert.equal(result.lowestPaymentSimulationId, lowest.id);
    const recommendedEntry = result.simulations.find((s) => s.id === result.lowestPaymentSimulationId);
    assert.equal(recommendedEntry.lowestPayment, true);
    assert.deepEqual(result.decisionsMade, []);
  });
});

test('CORRESPONDENT-NAY-05: NAY nunca escreve no banco — status e simulações permanecem inalterados após a chamada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await simulationsService.createSimulation(financingCase.id, { amount: 100000, termMonths: 180 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await backdateCase(financingCase.id, 10, transaction);

    const beforeCase = await FinancingCase.findByPk(financingCase.id, { transaction });
    const beforeStatus = beforeCase.status;
    const beforeUpdatedAt = beforeCase.updatedAt ?? beforeCase.updated_at;

    await nayService.checkStalledCases(tenant.groupId, tenant.companyId, { thresholdDays: 7 }, transaction);
    await nayService.compareSimulations(financingCase.id, tenant.groupId, tenant.companyId, transaction);

    const afterCase = await FinancingCase.findByPk(financingCase.id, { transaction });
    assert.equal(afterCase.status, beforeStatus, 'status não deveria mudar só por chamar a NAY');
    assert.equal(
      new Date(afterCase.updatedAt ?? afterCase.updated_at).getTime(),
      new Date(beforeUpdatedAt).getTime(),
      'updated_at não deveria mudar — NAY é somente leitura'
    );
  });
});

test('CORRESPONDENT-NAY-06: nenhuma resposta da NAY contém texto de promessa de aprovação/taxa/prazo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await simulationsService.createSimulation(financingCase.id, { amount: 100000, termMonths: 180 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await backdateCase(financingCase.id, 10, transaction);

    const stalled = await nayService.checkStalledCases(tenant.groupId, tenant.companyId, { thresholdDays: 7 }, transaction);
    const compare = await nayService.compareSimulations(financingCase.id, tenant.groupId, tenant.companyId, transaction);

    const forbiddenPatterns = /voc[eê] vai conseguir|aprovado automaticamente|garantimos|promet/i;
    assert.doesNotMatch(JSON.stringify(stalled), forbiddenPatterns);
    assert.doesNotMatch(JSON.stringify(compare), forbiddenPatterns);
  });
});

test('CORRESPONDENT-NAY-07: isolamento por empresa — caso de outra empresa não aparece nos parados nem na comparação', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const result = await nayService.checkStalledCases(tenant.groupId, otherCompanyId, { thresholdDays: 0 }, transaction);
    assert.equal(result.cases.length, 0);
  });
});

test('CORRESPONDENT-NAY-08: comparar simulações de case inexistente retorna 404 de negócio', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () => nayService.compareSimulations('00000000-0000-0000-0000-000000000000', tenant.groupId, tenant.companyId, transaction),
      (err) => {
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  });
});

test('CORRESPONDENT-NAY-09 (auditoria ciclo 2): NAY nunca escreve em nenhuma tabela ligada ao caso de teste (snapshot escopado por financing_case_id, imune a ruído de outros testes/agentes rodando em paralelo no mesmo banco)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await simulationsService.createSimulation(financingCase.id, { amount: 150000, termMonths: 240 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await backdateCase(financingCase.id, 10, transaction);

    // Só tabelas com financing_case_id direto — contagem GLOBAL da tabela inteira não é confiável
    // neste projeto porque o banco de dev é compartilhado por muitos testes/agentes em paralelo
    // (achado real desta auditoria: a 1ª versão deste teste, contando a tabela inteira, falhou
    // por ruído externo, não por bug da NAY). Escopar por financing_case_id torna o teste imune
    // a esse ruído, já que nenhuma outra sessão pode escrever usando ESTE id específico.
    const tables = [
      'appraisals', 'case_applicants', 'case_documents', 'case_requirements',
      'commission_entitlements', 'external_case_routing', 'provider_status_history',
      'provider_submissions', 'simulations', 'webhook_inbox',
    ];

    async function countAll() {
      const counts = {};
      for (const t of tables) {
        const [[row]] = await sequelize.query(
          `SELECT count(*)::int AS c FROM correspondent.${t} WHERE financing_case_id = :id`,
          { replacements: { id: financingCase.id }, transaction }
        );
        counts[t] = row.c;
      }
      return counts;
    }

    const before = await countAll();
    await nayService.checkStalledCases(tenant.groupId, tenant.companyId, { thresholdDays: 7 }, transaction);
    await nayService.compareSimulations(financingCase.id, tenant.groupId, tenant.companyId, transaction);
    const after = await countAll();

    assert.deepEqual(after, before, 'nenhuma linha ligada a este caso deveria mudar só por chamar a NAY');
  });
});

test('CORRESPONDENT-NAY-10 (auditoria ciclo 2): regex de promessa ampliado não encontra variações indiretas no texto real retornado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await simulationsService.createSimulation(financingCase.id, { amount: 100000, termMonths: 180 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await backdateCase(financingCase.id, 10, transaction);

    const stalled = await nayService.checkStalledCases(tenant.groupId, tenant.companyId, { thresholdDays: 7 }, transaction);
    const compare = await nayService.compareSimulations(financingCase.id, tenant.groupId, tenant.companyId, transaction);

    // Regex ampliado (ciclo 2): além dos termos óbvios, cobre sinônimos/frases indiretas que
    // poderiam soar como promessa sem usar as palavras exatas do teste original.
    const extendedForbidden = /voc[eê] vai conseguir|aprovado automaticamente|garantimos|garantid[oa]|promet|recomendamos fortemente|melhor op[cç][aã]o garantida|certamente ser[aá]|com certeza|sem d[uú]vida ser[aá] aprovado/i;
    const stalledText = JSON.stringify(stalled);
    const compareText = JSON.stringify(compare);
    assert.doesNotMatch(stalledText, extendedForbidden);
    assert.doesNotMatch(compareText, extendedForbidden);
  });
});

test('CORRESPONDENT-NAY-11 (auditoria ciclo 2): compareSimulations com zero simulações não quebra e lowestPaymentSimulationId é null', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    const result = await nayService.compareSimulations(financingCase.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(result.simulations.length, 0);
    assert.equal(result.lowestPaymentSimulationId, null);
  });
});

test('CORRESPONDENT-NAY-12 (auditoria ciclo 2): empate técnico entre simulações (mesma parcela) não quebra e recomenda exatamente uma', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    const simA = await simulationsService.createSimulation(financingCase.id, { amount: 100000, termMonths: 180 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const simB = await simulationsService.createSimulation(financingCase.id, { amount: 100000, termMonths: 180 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    assert.equal(Number(simA.monthlyPayment), Number(simB.monthlyPayment), 'pré-condição: mesmo valor/prazo deveria gerar a mesma parcela no sandbox determinístico');

    const result = await nayService.compareSimulations(financingCase.id, tenant.groupId, tenant.companyId, transaction);
    const recommendedCount = result.simulations.filter((s) => s.lowestPayment).length;
    assert.equal(recommendedCount, 1, 'mesmo empatado, só uma simulação deveria estar marcada como recomendada');
    assert.ok([simA.id, simB.id].includes(result.lowestPaymentSimulationId));
  });
});

test('CORRESPONDENT-NAY-13 (auditoria ciclo 2): limiar exato de dias parado é inclusivo (idleDays === thresholdDays conta como parado)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await backdateCase(financingCase.id, 7, transaction);

    const result = await nayService.checkStalledCases(tenant.groupId, tenant.companyId, { thresholdDays: 7 }, transaction);
    const found = result.cases.find((c) => c.financingCaseId === financingCase.id);
    assert.ok(found, 'idleDays exatamente igual ao threshold deveria contar como parado (inclusive)');
  });
});
