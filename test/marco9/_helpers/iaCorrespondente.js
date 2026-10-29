// Apoio dos testes da NAY Correspondente (M9-D039): agente ativado pelo ciclo completo (iaAgenteNay), casos de financiamento com checklist
// e simulações conhecidos. Banco descartável, nayara_runtime, rollback.

const { ativarAgente, rodar, como, svc, FIXO } = require('./iaAgenteNay');
const nayCorrespondente = require('../../../src/features/ai/agents/nay_correspondente');
const financingCases = require('../../../src/features/correspondent/cases/financingCases.service');
const caseDocuments = require('../../../src/features/correspondent/cases/caseDocuments.service');
const { Person } = require('../../../src/models');
const { q, run, uid } = require('../../helpers/aiAgents');

const PERMS = ['ai:use', 'correspondent:read'];

/** NAY_CORRESPONDENTE ativa (ciclo de alto impacto). `perms` são as permissões de quem pergunta. */
const cenario = (tenant, tx, opts = {}) => ativarAgente(tenant, tx, {
  CODE: nayCorrespondente.CODE, DEFINITION: nayCorrespondente.DEFINITION, GOLDEN_CASES: nayCorrespondente.GOLDEN_CASES, register: nayCorrespondente.registerNayCorrespondente,
}, { perms: PERMS, ...opts });

/** Caso de financiamento do provider `sandbox` com um proponente. */
async function criarCaso(tenant, tx) {
  const pessoa = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Proponente M9D039 ${uid().slice(0, 8)}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: tx });
  return financingCases.createFinancingCase({ groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'sandbox', applicants: [{ personId: pessoa.id, role: 'PRINCIPAL' }] }, tenant.userId, tx);
}

const exigir = (caso, tenant, tx, documentType) => caseDocuments.createRequirement(caso.id, { documentType }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, tx);

/** Simulação já registrada, com valores conhecidos (gravada direto: o teste confere o que a NAY lê, não o cálculo do provider). */
async function simulacao(caso, tenant, tx, { provider = 'sandbox', amount, termMonths, monthlyPayment, rate = null }) {
  await run(
    `INSERT INTO correspondent.simulations (id, group_id, company_id, financing_case_id, provider_code, amount, term_months, monthly_payment, rate, request_snapshot, response_snapshot)
     VALUES (:id, :g, :c, :caso, :provider, :amount, :termMonths, :monthlyPayment, :rate, '{}'::jsonb, '{}'::jsonb)`,
    { id: uid(), g: tenant.groupId, c: tenant.companyId, caso: caso.id, provider, amount, termMonths, monthlyPayment, rate }, tx
  );
}

/** Envelhece o caso, o checklist e as simulações: o caso fica sem atividade há `dias` dias. */
async function envelhecer(caso, dias, tx) {
  for (const sql of [
    'UPDATE correspondent.financing_cases SET updated_at = now() - make_interval(days => :dias) WHERE id = :id',
    'UPDATE correspondent.case_requirements SET updated_at = now() - make_interval(days => :dias) WHERE financing_case_id = :id',
    'UPDATE correspondent.simulations SET created_at = now() - make_interval(days => :dias) WHERE financing_case_id = :id',
  ]) await run(sql, { dias, id: caso.id }, tx);
}

const lerRun = async (id, tx) => (await q('SELECT * FROM ai.ai_runs WHERE id = :id', { id }, tx))[0];
const chamadas = (runId, tx) => q('SELECT tool_name, status, blocked_reason FROM ai.tool_calls WHERE run_id = :runId ORDER BY seq', { runId }, tx);
const fontes = (runId, tx) => q('SELECT * FROM ai.ai_sources WHERE ai_run_id = :runId ORDER BY retrieved_at, id', { runId }, tx);
const recomendacoes = async (tx) => (await q('SELECT count(*)::int AS n FROM ai.ai_recommendations', {}, tx))[0].n;

module.exports = { cenario, como, svc, rodar, criarCaso, exigir, simulacao, envelhecer, lerRun, chamadas, fontes, recomendacoes, PERMS, FIXO, q, uid };
