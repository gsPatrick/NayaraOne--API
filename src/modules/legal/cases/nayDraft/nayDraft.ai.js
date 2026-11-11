'use strict';

const { providerRegistry, registerAiAdapters } = require('../../../../features/ai/providers');
const budgets = require('../../../../features/ai/budgets');
const runs = require('../../../../features/ai/orchestrator/runs');
// Barrels do Marco 9 carregados na hora do uso (o barrel da IA carrega as tools, que carregam o jurídico: evita ciclo de require).
const aiBarrel = () => require('../../../../features/ai');
const juridicaPolicy = () => require('../../../../features/ai/agents/nay_juridica');

/**
 * A NAY Jurídica escolhe a estrutura da minuta com a infraestrutura de IA do Marco 9 (DI-M5CT-5):
 *  - chave geral `ia.habilitada` e o agente NAY_JURIDICA habilitado na empresa (aiGate);
 *  - o provedor padrão da empresa pelo ProviderRegistry (`ia.provedor.padrao`; nos testes, um provedor simulado);
 *  - o orçamento da IA (budgets.spendWithBudget: reserva, chamada, acerto do custo real);
 *  - o run em ai.ai_runs (startRun/finishRun: provedor, modelo, tokens, custo, aterramento).
 * O modelo recebe só identificadores, títulos e trechos das versões HOMOLOGADAS e devolve JSON com a ESCOLHA e a ORDEM; ele não
 * escreve texto de cláusula. O aterramento (groundSelection) aceita só ids da lista homologada; resposta fora disso não vira
 * minuta. IA desligada, sem orçamento, indisponível ou sem aterramento: o chamador segue pelo caminho determinístico.
 */
const AGENT = 'NAY_JURIDICA';
const PURPOSE = 'Minuta sugerida com a biblioteca homologada (Caderno M5 §17)';
const UNAVAILABLE = new Set(['UNAVAILABLE', 'TIMEOUT', 'RATE_LIMIT', 'AI_PROVIDER_UNAVAILABLE', 'AI_RUN_TIMEOUT', 'AI_BUDGET_EXHAUSTED', 'AI_BUDGET_NOT_CONFIGURED',
  'AI_PROVIDER_NOT_ENABLED', 'AI_PROVIDER_NOT_FOUND', 'AI_SANDBOX_NOT_ALLOWED_IN_PRODUCTION', 'AI_PROVIDER_REAL_NOT_ALLOWED_IN_LAB']);

async function aiAvailability(tenant, transaction) {
  const { isAiEnabled, isAgentEnabled } = aiBarrel();
  if (!(await isAiEnabled(tenant, transaction))) return { ok: false, reason: 'IA_DESLIGADA' };
  if (!(await isAgentEnabled(AGENT, tenant, transaction))) return { ok: false, reason: 'AGENTE_DESLIGADO' };
  return { ok: true };
}

function buildPrompt(contract, candidates) {
  const dados = {
    contrato: { tipo: contract.contractType, numero: contract.contractNumber || null },
    clausulas: candidates.map((c) => ({ id: c.id, codigo: c.code, titulo: c.title, categoria: c.category, trecho: String(c.bodyText).slice(0, 300) })),
  };
  return {
    system: [
      juridicaPolicy().SYSTEM_POLICY,
      'Tarefa: escolher e ordenar, SOMENTE entre as cláusulas homologadas listadas em DADOS, as que compõem a minuta deste contrato.',
      'Responda apenas com JSON no formato {"clausulas":[{"id":"<id da lista>","motivo":"<até 200 caracteres>"}]}. Não escreva texto de cláusula.',
    ].join('\n'),
    messages: [{ role: 'user', content: `Monte a minuta com a biblioteca homologada. DADOS: ${JSON.stringify(dados)}` }],
  };
}

/** Aterramento: só ids da lista homologada, sem repetição; motivo curto. Devolve { chosen, rejected } ou null se não há JSON. */
function groundSelection(text, candidates) {
  let parsed;
  try {
    const raw = String(text || '');
    parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch (err) { return null; }
  if (!parsed || !Array.isArray(parsed.clausulas)) return null;
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const chosen = [];
  const rejected = [];
  for (const item of parsed.clausulas) {
    const id = item && typeof item.id === 'string' ? item.id : null;
    if (!id || !byId.has(id)) { rejected.push({ id, motivo: 'FORA_DA_BIBLIOTECA_HOMOLOGADA' }); continue; }
    if (chosen.some((c) => c.id === id)) { rejected.push({ id, motivo: 'REPETIDA' }); continue; }
    chosen.push({ ...byId.get(id), motivoIa: typeof item.motivo === 'string' ? item.motivo.slice(0, 200) : null });
  }
  return { chosen, rejected };
}

function generateModel(adapter) {
  const entry = adapter.models().find((m) => m.generate);
  return entry ? entry.model : null;
}

/**
 * Pede a escolha ao modelo. Devolve { ok: true, chosen, rejected, runId, providerCode, modelCode } ou { ok: false, reason, runId }.
 * Falha da IA (indisponível, orçamento, provedor) nunca vira erro para a pessoa: vira `ok: false` com o motivo.
 */
async function selectWithAi(tenant, contract, candidates, transaction) {
  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId || null };
  if (providerRegistry.list().length === 0) registerAiAdapters(); // fora do servidor (job/teste de serviço) o boot não registrou
  let adapter;
  try { adapter = await providerRegistry.defaultInstance(ctx, transaction); } catch (err) { return { ok: false, reason: err.code || 'AI_PROVIDER_UNAVAILABLE' }; }
  const model = generateModel(adapter);
  if (!model) return { ok: false, reason: 'AI_PROVIDER_SEM_MODELO' };
  const { run } = await runs.startRun(ctx, { stamp: { agentCode: AGENT }, purpose: PURPOSE, inputSummary: `Minuta do contrato ${contract.id}: ${candidates.length} cláusula(s) homologada(s) candidata(s).`, routingPath: 'SMALL_MODEL' }, transaction);
  const prompt = buildPrompt(contract, candidates);
  let response;
  try {
    const paid = await budgets.spendWithBudget(ctx, { agentCode: AGENT, criticality: 'CRITICAL', routingPath: 'SMALL_MODEL', estimate: '0', at: new Date() }, async () => {
      const r = await adapter.generate({ ...prompt, model, maxOutputTokens: 2048, temperature: 0, timeoutMs: 30000, idempotencyKey: run.id, correlationId: run.id });
      return { cost: r.costAmount, response: r };
    }, transaction);
    response = paid.response;
  } catch (err) {
    const code = err.code || err.kind || 'AI_PROVIDER_UNAVAILABLE';
    await runs.finishRun(ctx, run.id, { status: 'FAILED', providerCode: adapter.providerCode(), modelCode: model, errorCode: String(code).slice(0, 80), outputSummary: 'Falha da IA: a minuta segue pelo caminho determinístico.' }, transaction);
    if (UNAVAILABLE.has(code) || err.name === 'AiProviderError') return { ok: false, reason: code, runId: run.id };
    throw err;
  }
  const grounded = groundSelection(response.text, candidates);
  const ok = Boolean(grounded && grounded.chosen.length);
  await runs.finishRun(ctx, run.id, {
    status: 'COMPLETED', providerCode: adapter.providerCode(), modelCode: response.model || model, routingPath: 'SMALL_MODEL',
    tokensIn: (response.usage && response.usage.tokensIn) || 0, tokensOut: (response.usage && response.usage.tokensOut) || 0,
    costAmount: response.costAmount || '0', groundingStatus: ok ? 'GROUNDED' : 'INSUFFICIENT_SOURCES',
    outputSummary: ok ? `${grounded.chosen.length} cláusula(s) homologada(s) escolhida(s); ${grounded.rejected.length} recusada(s) pelo aterramento.` : 'Resposta sem aterramento na biblioteca homologada: descartada.',
  }, transaction);
  if (!ok) return { ok: false, reason: 'IA_SEM_ATERRAMENTO', runId: run.id, rejected: grounded ? grounded.rejected : [] };
  return { ok: true, chosen: grounded.chosen, rejected: grounded.rejected, runId: run.id, providerCode: adapter.providerCode(), modelCode: response.model || model };
}

module.exports = { AGENT, aiAvailability, selectWithAi, groundSelection, buildPrompt };
