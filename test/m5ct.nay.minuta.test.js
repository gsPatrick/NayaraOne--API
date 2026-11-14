'use strict';

// Verificação independente do Marco 5, linha 124 (Caderno §17 "Sugere minuta usando biblioteca homologada"; §4 "legal.clause_versions
// | Versões homologadas"; JUR-008): homologada = aprovada por outra pessoa (não "ativa"); a NAY sugere a MINUTA (texto montado com o
// texto literal das versões homologadas), pela infraestrutura de IA quando ligada (provedor SIMULADO nos testes), com aterramento e
// aceite humano. Serviço real, transação desfeita no fim.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');
const clausesService = require('../src/modules/legal/contracts/application/contractClauses.service');
const { homologateClauseVersion } = require('../src/modules/legal/contracts/application/clauseHomologation.service');
const nayDraft = require('../src/modules/legal/cases/nayDraft/nayDraft.service');
const nay = require('../src/modules/legal/cases/legalNay.service');
const { providerRegistry, registerAiAdapters } = require('../src/features/ai/providers');
const { SandboxAdapter } = require('../src/features/ai/providers/sandbox/SandboxAdapter');
const { ContractVersion, AiRun, AuditLog } = require('../src/models');
const { newUser } = require('./m5fech.juridico.helpers');
const { criarOrcamento, definirParametro } = require('./marco9/_helpers/iaOrcamento');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });
const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const expectCode = (code) => (err) => { assert.equal(err.code, code, `${err.code}: ${err.message}`); return true; };

// Provedor de IA SIMULADO (sem rede): o sandbox do Marco 9 com a resposta que o teste define. Entra no ProviderRegistry no lugar
// do sandbox padrão (`ia.provedor.padrao` = ai-sandbox) só durante o teste e o sandbox original volta no fim.
let respostaSimulada = '';
class MinutaSimuladaAdapter extends SandboxAdapter {
  async generate(request) {
    const base = await super.generate({ ...request, messages: [{ role: 'user', content: 'x' }] });
    return { ...base, text: respostaSimulada };
  }
}
function trocarProvedor(Classe) {
  if (providerRegistry.list().length === 0) registerAiAdapters();
  providerRegistry.unregister('ai-sandbox');
  providerRegistry.register(Classe);
}

/** Biblioteca: A e B homologadas por outra pessoa, C ativa e NÃO homologada, D homologada com condição pendente. */
async function biblioteca(t) {
  const sfx = uniqueSuffix();
  const revisor = await newUser(tenant, t);
  const mk = (code, title, bodyText, extra = {}) => clausesService.createClause({ ...base(), code: `${code}-${sfx}`, title, bodyText, category: 'GENERAL', ...extra }, tenant.userId, t);
  const a = await mk('M5CT-A', 'Objeto', `Texto homologado A ${sfx}.`);
  const b = await mk('M5CT-B', 'Foro', `Texto homologado B ${sfx}.`);
  const c = await mk('M5CT-C', 'Multa', `Texto ATIVO e não homologado C ${sfx}.`);
  const d = await mk('M5CT-D', 'Fiança', `Texto condicional D ${sfx}.`, { condition: { match: 'all', rules: [{ variable: 'hasGuarantor', operator: 'eq', value: true }] } });
  for (const x of [a, b, d]) await homologateClauseVersion(x.id, revisor.id, t);
  // Só as cláusulas deste teste ficam ativas na biblioteca da empresa (as de outros testes saem de circulação nesta transação).
  await sequelize.query("UPDATE legal.clause_versions SET is_active = false WHERE is_active AND code NOT LIKE :p", { replacements: { p: `%-${sfx}` }, transaction: t });
  return { a, b, c, d, revisor };
}

const contrato = (t) => contractsService.createContract({ ...base(), contractType: 'LEASE_RESIDENTIAL', totalValue: 1500 }, tenant.userId, t);

test('linha 124: homologar é aprovar — quem escreveu não homologa, a homologação é única e o banco recusa outro caminho', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const revisor = await newUser(tenant, t);
    const cl = await clausesService.createClause({ ...base(), code: `M5CT-H-${uniqueSuffix()}`, title: 'Foro', bodyText: 'Fica eleito o foro.', category: 'GENERAL' }, tenant.userId, t);
    assert.equal(cl.homologationStatus, 'PENDING', 'versão nasce pendente de homologação (ativa não é homologada)');
    await assert.rejects(homologateClauseVersion(cl.id, tenant.userId, t), expectCode('LEGAL_CLAUSE_HOMOLOGATION_SELF_BLOCKED'));
    const ok = await homologateClauseVersion(cl.id, revisor.id, t);
    assert.equal(ok.homologationStatus, 'HOMOLOGATED');
    assert.equal(ok.homologatedBy, revisor.id);
    assert.ok(await AuditLog.findOne({ where: { action: 'legal.contract_clause.homologate', entityId: cl.id }, transaction: t }));
    await assert.rejects(homologateClauseVersion(cl.id, revisor.id, t), expectCode('LEGAL_CLAUSE_ALREADY_HOMOLOGATED'));
    await assert.rejects(
      sequelize.query("UPDATE legal.clause_versions SET homologation_status = 'PENDING', homologated_by = NULL, homologated_at = NULL WHERE id = :id", { replacements: { id: cl.id }, transaction: t }),
      /homologação da cláusula/
    );
  });
});

test('linha 124: a NAY sugere a MINUTA (texto) só com versões homologadas; IA desligada = caminho determinístico registrado; nada muda no contrato', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const lib = await biblioteca(t);
    const c = await contrato(t);
    const s = await nayDraft.suggestDraft(base(), c.id, tenant.userId, t);
    assert.equal(s.status, 'PENDING_REVIEW');
    assert.equal(s.metodo, 'RULE_BASED');
    assert.equal(s.motivoDoModo, 'IA_DESLIGADA');
    assert.ok(s.content.includes(lib.a.bodyText) && s.content.includes(lib.b.bodyText), 'a minuta traz o texto literal das homologadas');
    assert.ok(!s.content.includes(lib.c.bodyText), 'ativa sem homologação não entra');
    assert.ok(!s.content.includes(lib.d.bodyText), 'condição pendente não entra');
    assert.deepEqual(s.clauseVersionIds.map((x) => x.contractClauseId).sort(), [lib.a.id, lib.b.id].sort());
    assert.match(s.aviso, /RASCUNHO — requer revisão jurídica humana/);
    const motivos = Object.fromEntries(s.aterramento.excluidasDaBiblioteca.map((x) => [x.id, x.motivo]));
    assert.equal(motivos[lib.c.id], 'NAO_HOMOLOGADA');
    assert.equal(motivos[lib.d.id], 'CONDICAO_NAO_APROVADA');
    assert.ok(await AiRun.findByPk(s.aiRunId, { transaction: t }), 'execução da NAY registrada em ai.ai_runs');
    assert.equal(await ContractVersion.count({ where: { contractId: c.id }, transaction: t }), 0, 'a NAY não cria versão do contrato');
    // A lista de cláusulas da NAY segue a mesma regra de "homologada".
    const lista = (await nay.suggestClauses(base(), {}, tenant.userId, t)).clausulasSugeridas.map((x) => x.id);
    assert.ok(lista.includes(lib.a.id) && !lista.includes(lib.c.id));
  });
});

test('linha 124: só uma pessoa transforma a minuta em versão (DRAFT, ainda sem aprovação); descarte exige motivo; decisão única; biblioteca mudou = minuta vencida', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const lib = await biblioteca(t);
    const c = await contrato(t);
    const s = await nayDraft.suggestDraft(base(), c.id, tenant.userId, t);
    const aceito = await nayDraft.acceptDraftSuggestion(s.id, { reason: 'Revisada pelo jurídico', documentFileId: undefined }, tenant.userId, t).catch((err) => err);
    // O tenant de testes exige documento na versão: sem arquivo a versão não nasce e a minuta continua pendente.
    if (aceito instanceof Error) {
      assert.equal(aceito.code, 'LEGAL_CONTRACT_VERSION_DOCUMENT_REQUIRED');
      const { File } = require('../src/models');
      const f = await File.create({ ...base(), storageKey: `m5ct/${uniqueSuffix()}.pdf`, fileName: 'minuta.pdf', mimeType: 'application/pdf', uploadedByUserId: tenant.userId, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
      const ok = await nayDraft.acceptDraftSuggestion(s.id, { reason: 'Revisada pelo jurídico', documentFileId: f.id }, tenant.userId, t);
      assert.equal(ok.contractVersion.status, 'DRAFT', 'vira rascunho: a aprovação da versão continua com contracts.version.approve');
      assert.deepEqual(ok.contractVersion.clauseVersionIds.map((x) => x.contractClauseId).sort(), [lib.a.id, lib.b.id].sort());
      const v = await ContractVersion.findByPk(ok.contractVersion.id, { transaction: t });
      assert.equal(v.content, s.content);
      assert.equal(ok.suggestion.status, 'ACCEPTED');
    } else {
      assert.equal(aceito.contractVersion.status, 'DRAFT');
    }
    await assert.rejects(nayDraft.acceptDraftSuggestion(s.id, {}, tenant.userId, t), expectCode('LEGAL_NAY_DRAFT_ALREADY_DECIDED'));
    await assert.rejects(nayDraft.discardDraftSuggestion(s.id, { reason: 'tarde demais' }, tenant.userId, t), expectCode('LEGAL_NAY_DRAFT_ALREADY_DECIDED'));

    const s2 = await nayDraft.suggestDraft(base(), c.id, tenant.userId, t);
    await assert.rejects(nayDraft.discardDraftSuggestion(s2.id, {}, tenant.userId, t), expectCode('LEGAL_NAY_DRAFT_REASON_REQUIRED'));
    assert.equal((await nayDraft.discardDraftSuggestion(s2.id, { reason: 'Não serve para este caso' }, tenant.userId, t)).status, 'DISCARDED');

    const s3 = await nayDraft.suggestDraft(base(), c.id, tenant.userId, t);
    await clausesService.createClauseVersion(lib.a.code, { bodyText: `Texto novo de A ${uniqueSuffix()}.` }, tenant.userId, t);
    await assert.rejects(nayDraft.acceptDraftSuggestion(s3.id, {}, tenant.userId, t), expectCode('LEGAL_NAY_DRAFT_STALE'));
  });
});

test('linha 124: IA ligada (provedor simulado) — a IA escolhe e ordena, o aterramento recusa id fora da biblioteca homologada; resposta sem aterramento cai no determinístico', async () => {
  trocarProvedor(MinutaSimuladaAdapter);
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const lib = await biblioteca(t);
      await definirParametro(tenant, 'ia.habilitada', true, t);
      await criarOrcamento({ ...base(), userId: tenant.userId }, t, { agentCode: 'NAY_JURIDICA', limit: '50.00', at: new Date() });
      const c = await contrato(t);

      respostaSimulada = JSON.stringify({ clausulas: [
        { id: lib.b.id, motivo: 'Foro primeiro.' },
        { id: lib.c.id, motivo: 'Tentativa de usar cláusula não homologada.' },
        { id: '11111111-1111-4111-8111-111111111111', motivo: 'Id inventado.' },
        { id: lib.a.id, motivo: 'Objeto depois.' },
      ] });
      const s = await nayDraft.suggestDraft(base(), c.id, tenant.userId, t);
      assert.equal(s.metodo, 'AI');
      assert.equal(s.provedor, 'ai-sandbox');
      assert.deepEqual(s.clauseVersionIds.map((x) => x.contractClauseId), [lib.b.id, lib.a.id], 'ordem da IA, só homologadas');
      assert.ok(s.content.indexOf(lib.b.bodyText) < s.content.indexOf(lib.a.bodyText));
      assert.ok(!s.content.includes(lib.c.bodyText));
      assert.deepEqual(s.aterramento.recusadasPeloAterramento.map((x) => x.motivo), ['FORA_DA_BIBLIOTECA_HOMOLOGADA', 'FORA_DA_BIBLIOTECA_HOMOLOGADA']);
      const run = await AiRun.findByPk(s.aiRunId, { transaction: t });
      assert.equal(run.status, 'COMPLETED');
      assert.equal(run.providerCode, 'ai-sandbox');
      assert.equal(run.groundingStatus, 'GROUNDED');

      respostaSimulada = 'Segue a minuta: CLÁUSULA 1 — texto escrito pelo modelo, fora da biblioteca.';
      const s2 = await nayDraft.suggestDraft(base(), c.id, tenant.userId, t);
      assert.equal(s2.metodo, 'RULE_BASED');
      assert.equal(s2.motivoDoModo, 'IA_SEM_ATERRAMENTO');
      assert.ok(!s2.content.includes('texto escrito pelo modelo'), 'texto do modelo nunca entra na minuta');
      assert.equal((await AiRun.findByPk(s2.aiRunId, { transaction: t })).groundingStatus, 'INSUFFICIENT_SOURCES');
    });
  } finally {
    trocarProvedor(SandboxAdapter);
  }
});
