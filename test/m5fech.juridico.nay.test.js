'use strict';

/**
 * Fechamento do Marco 5 — Jurídico, NAY Jurídica (Caderno M5 §17, JUR-008, JUR-TS-012, Guia §16
 * "NAY não transforma sugestão em decisão jurídica automática"). Postgres real com RLS.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { newCase, newDeadline } = require('./m5fech.juridico.helpers');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');
const requirementsService = require('../src/modules/legal/contracts/application/requirement.service');
const legalDeadlinesService = require('../src/modules/legal/cases/deadline.service');
const legalNay = require('../src/modules/legal/cases/legalNay.service');
const { LegalDeadline, ContractRequirement, LegalCase } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const snapshot = async (caseId, contractId, t) => ({
  deadlines: (await LegalDeadline.findAll({ where: { legalCaseId: caseId }, transaction: t })).map((d) => `${d.id}:${d.status}:${d.criticality}`).sort(),
  requirements: (await ContractRequirement.findAll({ where: { contractId }, transaction: t })).map((r) => `${r.id}:${r.status}`).sort(),
  legalCase: JSON.stringify((await LegalCase.findByPk(caseId, { transaction: t })).toJSON()),
});

test('JR NAY: resumo do processo aponta documentos faltantes (checklist do contrato, processo sem documento, prazo concluído sem evidência), com aviso e fontes, sem alterar nada (§17)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const contract = await contractsService.createContract({ groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1500 }, tenant.userId, t);
    await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, t);
    const pending = (await requirementsService.listRequirements(contract.id, t)).filter((r) => r.status === 'PENDING');
    assert.ok(pending.length > 0);
    const legalCase = await newCase(tenant, t, { contractId: contract.id });
    const d = await newDeadline(legalCase.id, tenant, t);
    await legalDeadlinesService.updateLegalDeadline(d.id, { status: 'DONE', conclusionNote: 'Feito por telefone.' }, tenant.userId, t);
    const before = await snapshot(legalCase.id, contract.id, t);

    const r = await legalNay.summarizeCase(tenant, legalCase.id, tenant.userId, t);
    assert.match(r.aviso, /Não é conclusão jurídica definitiva; requer validação profissional/);
    assert.deepEqual(r.documentosFaltantes.map((x) => x.id).sort(), pending.map((x) => x.id).sort());
    assert.ok(r.pontosDeAtencao.some((p) => /checklist do contrato/.test(p)));
    assert.ok(r.pontosDeAtencao.some((p) => /sem nenhum documento/.test(p)));
    assert.ok(r.pontosDeAtencao.some((p) => /sem evidência anexada/.test(p)));
    assert.ok(r.fontes.some((f) => f.tabela === 'legal.contract_requirements'));
    assert.ok(r.aiRunId, 'execução auditada em ai_runs');
    assert.deepEqual(await snapshot(legalCase.id, contract.id, t), before, 'a NAY não alterou prazo, checklist nem processo');
  });
});

test('JUR-TS-012: data errada extraída pela NAY não vira prazo crítico sem confirmação — sugestão PENDING_CONFIRMATION, não crítica, nenhum prazo criado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const countBefore = await LegalDeadline.count({ transaction: t });
    const r = await legalNay.suggestDeadlines(tenant, {
      legalCaseId: legalCase.id,
      // 31/02 não existe (descartada); 13/11 foi lida do texto e pode estar errada: continua só sugestão.
      text: 'Audiência remarcada para 31/02/2026. Intime-se para manifestação até 13/11/2026, no prazo de 5 dias úteis.',
      referenceDate: '2026-11-03T12:00:00-03:00',
    }, tenant.userId, t);
    assert.ok(r.sugestoes.length >= 2);
    assert.ok(!r.sugestoes.some((s) => s.vencimentoSugerido.startsWith('2026-03-03') || s.vencimentoSugerido.startsWith('2026-02-31')), 'data inexistente não vira sugestão');
    for (const s of r.sugestoes) {
      assert.equal(s.status, 'PENDING_CONFIRMATION');
      assert.equal(s.critico, false);
      assert.match(s.confirmacao, /quando uma pessoa o cadastra/);
    }
    assert.equal(r.prazosCriados, 0);
    assert.equal(await LegalDeadline.count({ transaction: t }), countBefore, 'nenhum prazo criado pela NAY');
  });
});

test('JR NAY: o serviço não expõe nenhuma ação de escrita jurídica (não cria prazo, não altera contrato assinado, não exclui prova) (§17/Guia §19)', () => {
  const exported = Object.keys(legalNay).filter((name) => typeof legalNay[name] === 'function');
  const writes = exported.filter((name) => /^(create|update|delete|remove|approve|sign|confirm|send|set|alter|edit)/i.test(name));
  assert.deepEqual(writes, []);
  assert.deepEqual(exported.sort(), ['compareContractVersions', 'contentLines', 'multisetDiff', 'organizeDossier', 'suggestClauses', 'suggestDeadlines', 'summarizeCase', 'summarizeContract']);
});
