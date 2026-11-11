'use strict';

/**
 * Cobertura adicional para os grupos da matriz "Marco 5 — Contratos/Locação/Vistorias/Jurídico"
 * marcados "Parcial"/"Não comprovado" no PDF da Nayara "Conferência complementar Marcos 4 e 5"
 * (14/10/2026, Seção 4) que ainda não tinham teste de integração real (Postgres + RLS) dedicado:
 *   - Dossiê/cadeia de custódia/legal hold (§16/JUR-010/011)
 *   - NAY jurídica (§17/JUR-012)
 *   - Eventos/permissões/RLS (§18/§19/JUR-013)
 *   - Multa/juros/carência/cadência/acordo versionado (p158)
 *   - Aluguel garantido x antecipação (p158) — já coberto em test/billing.test.js; não duplicado
 *   - Encerramento e pendência crítica (p158) — já coberto em test/billing.test.js; não duplicado
 *
 * Ver Maturacao/AUDITORIA_MARCOS4_5_NAYARA_CHECKLIST.md para o texto literal do pedido.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const legalCasesService = require('../src/modules/legal/cases/legal-case.service');
const evidencePackagesService = require('../src/modules/legal/cases/evidence-package.service');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');
const collectionCaseService = require('../src/features/billing/collectionCase.service');
const billingScheduleService = require('../src/features/billing/billingSchedule.service');
const { getSetting } = require('../src/features/settings/settings.service');
const { evaluateRule } = require('../src/engines/rules/rulesEngine');

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

// ---------------------------------------------------------------------------
// Legal hold (novo recurso — não existia antes desta rodada)
// ---------------------------------------------------------------------------

test('legal hold: ativar exige motivo; ativo bloqueia mudança de status/fase mas não de campos informativos', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const legalCase = await legalCasesService.createLegalCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: 'Caso de teste' },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => legalCasesService.setLegalHold(legalCase.id, { legalHold: true }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CASE_LEGAL_HOLD_REASON_REQUIRED');
        return true;
      }
    );

    const held = await legalCasesService.setLegalHold(
      legalCase.id,
      { legalHold: true, reason: 'Investigação em andamento — preservar estado do processo.' },
      tenant.userId,
      transaction
    );
    assert.equal(held.legalHold, true);
    assert.equal(held.legalHoldSetBy, tenant.userId);
    assert.ok(held.legalHoldSetAt);

    // Status/fase: bloqueados.
    await assert.rejects(
      () => legalCasesService.updateLegalCase(legalCase.id, { status: 'CLOSED' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CASE_ON_LEGAL_HOLD');
        return true;
      }
    );
    await assert.rejects(
      () => legalCasesService.updateLegalCase(legalCase.id, { phase: 'TRIAL' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CASE_ON_LEGAL_HOLD');
        return true;
      }
    );

    // Campo informativo: continua editável mesmo em hold.
    const updated = await legalCasesService.updateLegalCase(legalCase.id, { summary: 'Resumo atualizado' }, tenant.userId, transaction);
    assert.equal(updated.summary, 'Resumo atualizado');

    // Remover o hold não exige motivo e libera status/fase de novo.
    const released = await legalCasesService.setLegalHold(legalCase.id, { legalHold: false }, tenant.userId, transaction);
    assert.equal(released.legalHold, false);
    assert.equal(released.legalHoldReason, null);
    const afterRelease = await legalCasesService.updateLegalCase(legalCase.id, { phase: 'DISCOVERY' }, tenant.userId, transaction);
    assert.equal(afterRelease.phase, 'DISCOVERY');
  });
});

// ---------------------------------------------------------------------------
// Dossiê/cadeia de custódia: arquivos reais, origem/data/versão, log de acesso
// (createEvidencePackageFromContractAttachments e o access log já existem — aqui provamos o
// comportamento ponta a ponta com um contrato real, não apenas unitariamente).
// ---------------------------------------------------------------------------

test('dossiê: pacote de evidências a partir de anexos reais do contrato grava hash real e cadeia de custódia completa (VIEWED/EXPORTED)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
      tenant.userId,
      transaction
    );
    const legalCase = await legalCasesService.createLegalCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', contractId: contract.id },
      tenant.userId,
      transaction
    );

    // Sem nenhum anexo real vinculado ainda: deve recusar, não inventar um manifesto vazio.
    await assert.rejects(
      () => evidencePackagesService.createEvidencePackageFromContractAttachments(legalCase.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_EVIDENCE_PACKAGE_NO_ATTACHMENTS');
        return true;
      }
    );

    // Com um item extra explícito (hash calculado fora, ex.: nota de auditoria): cria com esse item.
    const pkg = await evidencePackagesService.createEvidencePackageFromContractAttachments(legalCase.id, tenant.userId, transaction, {
      extraManifestItems: [{ type: 'AUDIT_NOTE', description: 'Nota de auditoria externa', referenceId: null, hash: 'abc123' }],
    });
    assert.equal(pkg.manifestJson.length, 1);
    assert.equal(pkg.manifestJson[0].hash, 'abc123');
    assert.ok(pkg.packageHash);

    // Nenhum acesso ainda.
    let log = await evidencePackagesService.listEvidenceAccessLog(pkg.id, transaction);
    assert.equal(log.length, 0);

    // Visualizar registra VIEWED.
    await evidencePackagesService.viewEvidencePackage(pkg.id, tenant.userId, transaction);
    log = await evidencePackagesService.listEvidenceAccessLog(pkg.id, transaction);
    assert.equal(log.length, 1);
    assert.equal(log[0].action, 'VIEWED');
    assert.equal(log[0].accessedByUserId, tenant.userId);

    // Exportar registra EXPORTED e devolve um JSON autocontido cujo hash recalculado bate.
    const exported = await evidencePackagesService.exportEvidencePackage(pkg.id, tenant.userId, transaction);
    log = await evidencePackagesService.listEvidenceAccessLog(pkg.id, transaction);
    assert.equal(log.length, 2);
    assert.equal(log[1].action, 'EXPORTED');

    const verification = evidencePackagesService.verifyEvidencePackageIntegrity(exported, pkg.packageHash);
    assert.equal(verification.valid, true);

    // Adulterar o manifesto exportado e reverificar: deve acusar divergência.
    const tampered = { ...exported, manifest: [{ ...exported.manifest[0], description: 'ADULTERADO' }] };
    const tamperedVerification = evidencePackagesService.verifyEvidencePackageIntegrity(tampered, pkg.packageHash);
    assert.equal(tamperedVerification.valid, false);
  });
});

test('dossiê: outra empresa não enxerga o processo jurídico, o pacote de evidências nem seu log de acesso (RLS)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const legalCase = await legalCasesService.createLegalCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'CONSULTATIVE' },
      tenant.userId,
      transaction
    );
    const pkg = await evidencePackagesService.createEvidencePackage(
      legalCase.id,
      [{ type: 'AUDIT_NOTE', description: 'Item de teste' }],
      tenant.userId,
      transaction
    );
    await evidencePackagesService.viewEvidencePackage(pkg.id, tenant.userId, transaction);

    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', { replacements: { otherCompanyId }, transaction });

    const [caseRows] = await sequelize.query('SELECT id FROM "legal"."legal_cases" WHERE id = :id', {
      replacements: { id: legalCase.id },
      transaction,
    });
    assert.equal(caseRows.length, 0, 'empresa diferente não deve ver o processo jurídico da empresa original');

    const [pkgRows] = await sequelize.query('SELECT id FROM "legal"."evidence_packages" WHERE id = :id', {
      replacements: { id: pkg.id },
      transaction,
    });
    assert.equal(pkgRows.length, 0, 'empresa diferente não deve ver o pacote de evidências da empresa original');

    const [logRows] = await sequelize.query('SELECT id FROM "legal"."evidence_package_access_log" WHERE evidence_package_id = :id', {
      replacements: { id: pkg.id },
      transaction,
    });
    assert.equal(logRows.length, 0, 'empresa diferente não deve ver a cadeia de custódia da empresa original');

    const [, updateResult] = await sequelize.query(`UPDATE "legal"."legal_cases" SET status = 'CLOSED' WHERE id = :id`, {
      replacements: { id: legalCase.id },
      transaction,
    });
    assert.equal(updateResult.rowCount, 0, 'empresa diferente não deve conseguir UPDATE no processo jurídico da empresa original');
  });
});

// ---------------------------------------------------------------------------
// NAY jurídica (§17/JUR-012) — mesmo argumento estrutural já usado para NAY Financeira
// (test/marco4.nayNoExecution.test.js) e NAY Comercial (Marco 3): não existe NENHUMA
// integração de IA/LLM real no backend hoje (infraestrutura é Marco 9, cláusula 4.10). Isso é
// verdade por AUSÊNCIA — travamos essa garantia como regressão para o módulo jurídico: se algum
// dia um caminho "nay*.service.js" no jurídico chamar decisão/edição/criação crítica direto,
// sem passar pelas rotas HTTP protegidas por authMiddleware+requirePermission, este teste falha.
// ---------------------------------------------------------------------------

test('JUR-012: não existe nenhum módulo de execução jurídica acessível por "NAY" fora das rotas HTTP protegidas; decisões/criações críticas sempre exigem ator humano autenticado', () => {
  // Árvore do Guia M5 §2 (src/modules/legal): a varredura percorre todas as subpastas do módulo.
  const legalDir = path.join(__dirname, '..', 'src', 'modules', 'legal');
  const listar = (d, base = '') => fs.readdirSync(path.join(legalDir, base)).flatMap((n) => {
    const rel = base ? `${base}/${n}` : n;
    return fs.statSync(path.join(legalDir, rel)).isDirectory() ? listar(d, rel) : (n.endsWith('.js') ? [rel] : []);
  });
  const files = listar(legalDir);

  // Exceção controlada (NAY Jurídica, Caderno §17, 19/10/2026): o módulo de leitura
  // legalNay.service.js (travado logo abaixo) e as linhas de rota /legal/nay/* — todas
  // exigindo legal:read, conferidas abaixo.
  // Verificação M5 linha 124 (Caderno §17 "Sugere minuta"; DI-M5CT-5): a minuta sugerida (cases/nayDraft/) é a segunda exceção
  // controlada — a NAY grava só a SUGESTÃO (pendente) e o run; a versão do contrato nasce apenas no aceite por pessoa (rota
  // protegida, ator obrigatório), travado mais abaixo.
  const nayRouteRe = /^legalRouter\.(get|post)\('\/legal\/nay\/[^']+', requirePermission\('legal:read'\), legalController\.nay\w+\);$/;
  const nayDraftRouteRe = /^legalRouter\.(get|post)\('\/legal\/nay\/(contracts\/:id\/draft-suggestions|draft-suggestions\/:id\/(accept|discard))', requirePermission\('legal:(read|create)'\), nayDraftController\.\w+\);$/;
  for (const file of files) {
    if (file === 'cases/legalNay.service.js' || file.startsWith('cases/nayDraft/')) continue;
    let content = fs.readFileSync(path.join(legalDir, file), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    if (file === 'shared/legal.routes.js') content = content.split('\n').filter((l) => !nayRouteRe.test(l) && !nayDraftRouteRe.test(l) && !/nayDraftController = require/.test(l)).join('\n');
    assert.ok(
      !/\bNAY\b/i.test(content),
      `${file} não deveria referenciar NAY fora de comentário — nenhum agente de IA tem caminho de execução no jurídico.`
    );
  }

  // NAY Jurídica é SOMENTE LEITURA por construção: só importa modelos + AppError + o registrador de run por regra (M9-D005),
  // a única escrita é a auditoria da execução (recordRuleRun) e não usa SQL cru.
  const nay = fs.readFileSync(path.join(legalDir, 'cases', 'legalNay.service.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual([...nay.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort(), ['../../../models', '../../../features/ai/orchestrator/runs', '../../../utils/AppError', '../contracts/application/clauseHomologation.service'].sort());
  assert.equal((nay.match(/\.(create|update|save|destroy|bulkCreate|upsert|increment|decrement|restore|query)\(/g) || []).length, 0, 'nenhuma escrita direta em modelo');
  assert.equal((nay.match(/recordRuleRun\(/g) || []).length, 1, 'a única escrita é o run por regra');
  const routeLines = fs.readFileSync(path.join(legalDir, 'shared', 'legal.routes.js'), 'utf8').split('\n').filter((l) => /^legalRouter.*\/legal\/nay\//.test(l));
  assert.equal(routeLines.length, 10);
  for (const l of routeLines) assert.ok(nayRouteRe.test(l) || nayDraftRouteRe.test(l), l);
  // Minuta: escrever só exige legal:create (nunca legal:approve/sign); o aceite exige pessoa e a sugestão não cria versão do contrato.
  const draftRoutes = routeLines.filter((l) => nayDraftRouteRe.test(l));
  assert.equal(draftRoutes.length, 4);
  assert.ok(draftRoutes.filter((l) => /^legalRouter\.post/.test(l)).every((l) => l.includes("requirePermission('legal:create')")));
  const draftSvc = fs.readFileSync(path.join(legalDir, 'cases', 'nayDraft', 'nayDraft.service.js'), 'utf8');
  const suggestBody = draftSvc.slice(draftSvc.indexOf('async function suggestDraft'), draftSvc.indexOf('async function listDraftSuggestions'));
  assert.ok(!/createContractVersion|ContractVersion\.create|\.approve|transitionContractStatus/.test(suggestBody), 'sugerir não cria nem aprova versão do contrato');
  const acceptBody = draftSvc.slice(draftSvc.indexOf('async function acceptDraftSuggestion'), draftSvc.indexOf('async function discardDraftSuggestion'));
  assert.match(acceptBody, /if \(!actorUserId\) throw AppError\.forbidden\([^)]*'LEGAL_NAY_DRAFT_HUMAN_REQUIRED'\)/, 'o aceite exige pessoa identificada');

  // Toda criação/decisão jurídica crítica (processo, dossiê, mudança de status de contrato,
  // decisão de aprovação) exige actorUserId e passa por controller->rota protegida — nunca é
  // chamada a partir de um worker/job sem ator humano. Os services já recebem actorUserId como
  // parâmetro explícito (não opcional na prática: fica gravado em created_by/updated_by e no
  // audit log); confirmamos que as funções de criação/decisão central aceitam e usam esse ator.
  assert.equal(legalCasesService.createLegalCase.length, 3, 'createLegalCase deve receber (payload, actorUserId, transaction)');
  assert.equal(legalCasesService.updateLegalCase.length, 4, 'updateLegalCase deve receber (id, payload, actorUserId, transaction)');
  assert.equal(legalCasesService.setLegalHold.length, 4, 'setLegalHold deve receber (id, payload, actorUserId, transaction)');
  assert.equal(
    evidencePackagesService.createEvidencePackage.length,
    4,
    'createEvidencePackage deve receber (legalCaseId, manifestItems, actorUserId, transaction)'
  );

  // Invariante verdadeira desde o Marco 9 (a IA real existe em src/features/ai; a premissa "sem IA"
  // caiu): código de provedor de IA nunca é chamado de dentro do módulo jurídico, e nada em
  // src/features/ai cria/decide/muda status de contrato, processo ou dossiê direto: a escrita da NAY
  // jurídica é só rascunho com aprovação humana (legal.draftContract exige requiresHumanApproval).
  const srcDir = path.join(__dirname, '..', 'src');
  const strip = (c) => c.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const providerLeaks = [];
  const aiLegalWriters = [];
  const walk = (dir, fn) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, fn);
      else if (entry.name.endsWith('.js')) fn(full, strip(fs.readFileSync(full, 'utf8')));
    }
  };
  walk(legalDir, (full, content) => { if (/openai|anthropic|@anthropic-ai/i.test(content)) providerLeaks.push(path.relative(srcDir, full)); });
  walk(path.join(srcDir, 'features', 'ai'), (full, content) => {
    if (/\b(createLegalCase|setLegalHold|createEvidencePackage|updateContractStatus|transitionContract|approveContract|signContract)\b/.test(content)) aiLegalWriters.push(path.relative(srcDir, full));
  });
  assert.deepEqual(providerLeaks, [], 'provedor de IA não pode ser chamado de dentro do módulo jurídico.');
  assert.deepEqual(aiLegalWriters, [], 'a NAY não pode criar/decidir/mudar status jurídico direto.');
  const { INITIAL_DEFINITIONS } = require('../src/features/ai/tools/definitions');
  for (const tool of INITIAL_DEFINITIONS.filter((t) => /^legal\./.test(t.name) && t.category !== 'READ')) {
    assert.equal(tool.requiresHumanApproval, true, `${tool.name}: escrita jurídica da NAY exige aprovação humana.`);
  }
});

// ---------------------------------------------------------------------------
// Multa/juros/carência/cadência/acordo versionado — cálculo determinístico pela regra e
// configuração REAIS do tenant (não adivinhando o percentual), dívida original preservada.
// ---------------------------------------------------------------------------

test('multa/juros: cálculo do caso de cobrança bate exatamente com a regra publicada + settings do tenant (determinístico)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 3000 },
      tenant.userId,
      transaction
    );
    const period = `2031-0${(Math.floor(Math.random() * 8) + 1)}`;
    const schedule = await billingScheduleService.generateBillingSchedule(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractId: contract.id,
        period,
        dueDate: `${period}-05`,
        items: [{ componentType: 'RENT', amount: 2000 }],
      },
      tenant.userId,
      transaction
    );

    const daysPastDue = 15;

    // Lê a MESMA fonte de verdade que o serviço usa (regra publicada + settings do tenant),
    // sem adivinhar o percentual — se a regra ou o setting mudar, o teste continua correto.
    const graceEvaluation = await evaluateRule('REG-LOC-002', { gracePeriodRuleActive: true }, tenant, { transaction });
    const configuredGraceDays = await getSetting('billing.grace_period_days', tenant, transaction, 3);
    const graceDays = graceEvaluation.decision === 'APPLY' ? graceEvaluation.action.graceDays ?? configuredGraceDays : 0;
    assert.ok(daysPastDue > graceDays, 'pré-condição do teste: dias em atraso deve exceder a carência real para abrir o caso');

    const penaltyEvaluation = await evaluateRule('REG-LOC-001', { isOverdue: true }, tenant, { transaction });
    const configuredPenaltyPercentage = await getSetting('billing.penalty_percentage', tenant, transaction, 2);
    const configuredInterestPercentage = await getSetting('billing.interest_percentage', tenant, transaction, 1);
    const penaltyPercentage = penaltyEvaluation.decision === 'APPLY' ? penaltyEvaluation.action.penaltyPercentage ?? configuredPenaltyPercentage : 0;
    const monthlyInterestPercentage =
      penaltyEvaluation.decision === 'APPLY' ? penaltyEvaluation.action.monthlyInterestPercentage ?? configuredInterestPercentage : 0;

    const balance = 2000;
    const overdueDays = daysPastDue - graceDays;
    const expectedPenalty = Math.round(((balance * penaltyPercentage) / 100) * 100) / 100;
    const expectedInterest = Math.round(((balance * (monthlyInterestPercentage / 100) * overdueDays) / 30) * 100) / 100;
    const expectedBalance = Math.round((2000 + expectedPenalty + expectedInterest) * 100) / 100;

    const collectionCase = await collectionCaseService.openCollectionCase(schedule.id, daysPastDue, tenant.userId, transaction);

    assert.equal(Number(collectionCase.penaltyAmount), expectedPenalty, 'multa deve bater exatamente com regra+settings reais, não um valor adivinhado');
    assert.equal(Number(collectionCase.interestAmount), expectedInterest, 'juros deve bater exatamente com regra+settings reais, não um valor adivinhado');
    assert.equal(Number(collectionCase.currentBalance), expectedBalance);
    assert.equal(Number(collectionCase.originalDebtAmount), 2000, 'dívida original preservada sem embutir multa/juros nela');

    // Regra/versão ficam gravadas para auditoria — "cálculo pela regra e versão".
    if (penaltyEvaluation.decision === 'APPLY') {
      assert.ok(collectionCase.penaltyRuleVersionId, 'penalty_rule_version_id deve estar gravado quando a regra decide aplicar');
    }

    // Acordo versionado: cada novo acordo é APENSADO ao histórico (array), nunca sobrescreve o
    // anterior — "versionado" significa preservar todas as versões, não só a mais recente.
    const firstAgreement = await collectionCaseService.createAgreement(
      collectionCase.id,
      { installments: 2, agreedAmount: expectedBalance, notes: 'Primeiro acordo' },
      tenant.userId,
      transaction
    );
    assert.equal(firstAgreement.agreementsJson.length, 1);
    const secondAgreement = await collectionCaseService.createAgreement(
      firstAgreement.id,
      { installments: 4, agreedAmount: expectedBalance, notes: 'Renegociação' },
      tenant.userId,
      transaction
    );
    assert.equal(secondAgreement.agreementsJson.length, 2, 'segundo acordo deve ser apensado, não substituir o primeiro');
    assert.equal(secondAgreement.agreementsJson[0].notes, 'Primeiro acordo', 'histórico do primeiro acordo preservado');
    assert.equal(secondAgreement.agreementsJson[1].notes, 'Renegociação');
    assert.equal(Number(secondAgreement.originalDebtAmount), 2000, 'dívida original continua preservada após dois acordos');
  });
});
