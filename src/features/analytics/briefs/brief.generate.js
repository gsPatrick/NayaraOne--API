'use strict';

/**
 * M9-D693 / M9-D694 — geração do briefing executivo da NAY Diretoria de UMA empresa, numa transação do tenant:
 *  1. período e agenda (brief.period), parâmetros (briefSettings) e o papel da diretoria (brief.metrics);
 *  2. métricas autorizadas com variação do servidor, alertas e registros de causa; o servidor escolhe e ordena os itens (brief.candidates);
 *  3. a NAY (porta `deps.runAgent`, o agente "NAY Diretoria" do Bloco A) escreve o texto dos itens de métrica; sem agente não há briefing;
 *  4. grounding determinístico (groundingValidator): item reprovado é removido, registrado e avisado; sem item válido, BLOCKED_GROUNDING;
 *  5. grava em analytics.executive_briefs (uma versão vigente por empresa, tipo e período; a anterior vira SUPERSEDED) com BRIEF_GENERATE
 *     no log de acesso, passando por prepareSecureRows. Provider ou orçamento falhou: registro FAILED com o código, nenhum texto inventado.
 * Nada aqui executa ação: a ação sugerida é texto.
 */
const AppError = require('../../../utils/AppError');
const { clock } = require('../metrics');
const readStore = require('../briefReadStore.service');
const briefStore = require('../executiveBriefStore.service');
const { P, prepareSecureRows, has, domainPermissionOf } = require('../security');
const { readBriefParams } = require('../briefSettings');
const { resolveBriefPeriods } = require('./brief.period');
const { directorContext, collectMetricFacts, applyAreaGates, alertFallbackSources } = require('./brief.metrics');
const { buildCandidates } = require('./brief.candidates');
const { loadCauseRecords } = require('./brief.causes');
const { buildEntrada, instructionFor } = require('./brief.input');
const { parseModelOutput, shapeIssue } = require('./brief.schema');
const { allowedNumbers } = require('./groundingNumbers');
const { validateItem } = require('./groundingValidator');
const { composeItems } = require('./brief.items');
const { emitBriefEvent, TYPES } = require('./brief.events');
const { readMaxItems } = require('../nayToolsSettings');

const BUDGET_CODES = new Set(['AI_BUDGET_EXHAUSTED', 'AI_BUDGET_NOT_CONFIGURED']);
const NO_SOURCES = 'Briefing sem fontes não pode ser gravado.';

const failureCode = (error) => (error && BUDGET_CODES.has(error.code) ? 'ANALYTICS_BRIEF_AI_BUDGET' : `ANALYTICS_BRIEF_AI_FAILED:${(error && error.code) || 'ERRO'}`);
const countBy = (list, key) => list.reduce((acc, x) => { acc[key(x)] = (acc[key(x)] || 0) + 1; return acc; }, {});
const sourceKey = (s) => `${s.metricCode}#${s.version}`;
const uniqueSources = (list) => [...new Map(list.map((s) => [sourceKey(s), s])).values()];

/** Pede o texto à NAY. Nunca lança por falha do provider/orçamento: devolve { ok: false, code }. */
async function askAgent(deps, request, transaction) {
  try {
    const outcome = await deps.runAgent(request, transaction);
    return outcome && outcome.ok ? { ok: true, answer: outcome.answer, runId: outcome.runId || null } : { ok: false, code: failureCode(outcome && outcome.error), runId: outcome && outcome.runId };
  } catch (err) {
    return { ok: false, code: failureCode(err) };
  }
}

/** Passo 4: confere cada item da NAY. Devolve { valid: Map(refId -> item), blocked: [{ refId, code, reason }] }. */
function groundItems(parsed, modelCandidates, entrada, causes, params) {
  const byRef = new Map(modelCandidates.map((c) => [c.refId, c]));
  const ctx = { causeIds: new Set(causes.map((c) => c.id)), allowed: allowedNumbers(entrada), words: params.causalWords };
  const valid = new Map();
  const blocked = [];
  for (const item of parsed.itens) {
    const refId = item && typeof item.refId === 'string' ? item.refId : null;
    const issue = shapeIssue(item, refId ? byRef.get(refId) : null);
    if (issue) { blocked.push({ refId, code: /fonte/.test(issue) ? 'ANALYTICS_BRIEF_NO_SOURCES' : 'ANALYTICS_BRIEF_SCHEMA_INVALID', reason: issue }); continue; }
    if (valid.has(refId)) { blocked.push({ refId, code: 'ANALYTICS_BRIEF_SCHEMA_INVALID', reason: 'Item repetido.' }); continue; }
    const verdict = validateItem(item, ctx);
    if (verdict.ok) valid.set(refId, item); else blocked.push({ refId, code: verdict.code, reason: verdict.reason });
  }
  return { valid, blocked };
}

const blockedText = (blocked, missing) => [
  ...blocked.map((b) => `${b.code} [${b.refId || 'sem item'}]: ${b.reason}`), ...missing.map((c) => `ITEM_NAO_RETORNADO [${c.refId}]: a NAY não escreveu este item.`),
].join(' | ').slice(0, 4000) || null;

/**
 * Briefing que FALHOU (provedor, orçamento, identidade de serviço desligada...) é tentado de novo depois de `analytics.brief.reintento_falha_min` (padrão 60 min), até
 * o fim do período. Sem isso, uma empresa que corrigiu a configuração às 7h continuava "Briefing indisponível" até o dia seguinte. BLOCKED_GROUNDING não se repete:
 * o modelo recebeu os mesmos dados.
 */
const isRetryable = (brief, now, minutes) => brief.status === 'FAILED' && brief.generatedAt && new Date(now).getTime() - new Date(brief.generatedAt).getTime() >= minutes * 60000;

async function generateBrief({ scope, briefType, regenerate = false, now = clock.now(), correlationId = null }, deps, transaction) {
  const params = await readBriefParams(scope, transaction);
  const periods = resolveBriefPeriods(briefType, now);
  const key = { companyId: scope.companyId, groupId: scope.groupId, briefType, periodStart: periods.current.startDate, periodEnd: periods.current.endDate };
  const existing = await readStore.findCurrentBrief(key, transaction);
  if (existing && !regenerate && !isRetryable(existing, now, params.retryFailedMinutes)) return { skipped: 'EXISTS', brief: existing };

  const ctx = await directorContext(scope, params, transaction);
  const { facts, noData } = await collectMetricFacts({ ctx, scope, params, periods }, transaction);
  const gates = await applyAreaGates({ ctx, facts, noData, asOfDate: periods.current.asOfDate }, transaction);
  const alerts = (await readStore.listBriefAlerts({ companyId: scope.companyId, periodStart: key.periodStart, periodEnd: key.periodEnd }, transaction))
    .filter((a) => !a.domain || has(ctx, domainPermissionOf(ctx.domainMap, a.domain)));
  const sources = await alertFallbackSources({ ctx, scope, alerts, facts }, transaction);
  const sourceRefs = uniqueSources([...facts.map((f) => f.source), ...sources.values()]);
  if (!sourceRefs.length) throw AppError.unprocessable(NO_SOURCES, 'ANALYTICS_BRIEF_NO_SOURCES');

  const picked = buildCandidates({ ctx, facts, alerts, params, briefType, gates, sources });
  const modelCandidates = picked.selected.filter((c) => c.kind === 'METRICA');
  const causes = modelCandidates.length ? await loadCauseRecords({ ctx, scope, params, period: periods.current }, transaction) : [];
  const concomitantes = alerts.filter((a) => a.openedAt && a.status !== 'RESOLVED').slice(0, await readMaxItems(scope, transaction));
  const entrada = buildEntrada({ briefType, periods, candidates: picked.selected, causes, concomitantes });

  let outcome = { ok: true, answer: null, runId: null };
  let grounded = { valid: new Map(), blocked: [] };
  if (modelCandidates.length) {
    outcome = await askAgent(deps, {
      groupId: scope.groupId, companyId: scope.companyId, briefType, correlationId, instruction: instructionFor(entrada, params.causalWordsText),
      idempotencyKey: `analytics-brief:${scope.companyId}:${briefType}:${key.periodStart}:${key.periodEnd}:${existing ? existing.id : 'primeira'}`,
    }, transaction);
    if (outcome.ok) {
      try { grounded = groundItems(parseModelOutput(outcome.answer), modelCandidates, entrada, causes, params); } catch (err) { outcome = { ok: false, code: err.code || 'ANALYTICS_BRIEF_SCHEMA_INVALID', runId: outcome.runId }; }
    }
  }

  const base = { // DI-BI-8: generated_at no relógio do BI (M9-D606), o mesmo com que isRetryable mede o intervalo da nova tentativa
    ...key, generatedAt: now, supersede: Boolean(existing), aiRunId: outcome.runId || null, sourceRefs,
    freshnessSummary: countBy(facts, (f) => f.current.freshness.state),
    qualitySummary: { areasComDadoIncompleto: [...new Set(facts.filter((f) => f.quality).map((f) => f.area))], semRegistro: noData.map((n) => n.metricCode), indicadoresLidos: facts.length },
  };
  const period = { inicio: key.periodStart, fim: key.periodEnd, anteriorInicio: periods.previous.startDate, anteriorFim: periods.previous.endDate };
  if (!outcome.ok) {
    return persist(base, { status: 'FAILED', blockedReason: outcome.code, content: { itens: [], fechamento: null, periodo: period } }, { ctx, briefType, transaction });
  }
  const missing = modelCandidates.filter((c) => !grounded.valid.has(c.refId) && !grounded.blocked.some((b) => b.refId === c.refId));
  const itens = composeItems(picked.selected, grounded.valid);
  const reason = blockedText(grounded.blocked, missing);
  if (modelCandidates.length && !itens.length) {
    return persist(base, { status: 'BLOCKED_GROUNDING', blockedReason: reason || 'ANALYTICS_BRIEF_NO_SOURCES', content: { itens: [], fechamento: null, periodo: period } }, { ctx, blocked: grounded.blocked, briefType, transaction });
  }
  const lostException = modelCandidates.some((c) => c.tipo === 'EXCECAO' && !grounded.valid.has(c.refId));
  const allClear = !picked.droppedException && !lostException;
  const fechamento = allClear ? (itens.some((i) => i.tipo !== 'DESTAQUE') ? params.closingSome : params.closingAll) : null;
  return persist(base, { status: 'GENERATED', blockedReason: reason, content: { itens, fechamento, periodo: period } }, { ctx, blocked: grounded.blocked, briefType, transaction });
}

/** Passo 5: log BRIEF_GENERATE pelo caminho de saída do BI (mascaramento) e gravação; depois do commit, o aviso dos itens bloqueados. */
async function persist(base, result, { ctx, blocked = [], briefType, transaction }) {
  const secured = await prepareSecureRows(ctx, {
    permission: P.READ, action: 'BRIEF_GENERATE', resourceType: 'BRIEF', resourceCode: `${base.briefType}:${base.periodEnd}`, route: 'job:analyticsBrief',
    filters: { briefType: base.briefType, periodStart: base.periodStart, periodEnd: base.periodEnd }, rows: result.content.itens, transaction,
  });
  const brief = await briefStore.createExecutiveBrief({ ...base, status: result.status, blockedReason: result.blockedReason, content: { ...result.content, itens: secured.rows } }, ctx, transaction);
  for (const b of blocked) {
    emitBriefEvent(transaction, { type: TYPES.ITEM_BLOCKED, briefId: brief.id, briefType, companyId: base.companyId, refId: b.refId, code: b.code, reason: b.reason });
  }
  return { brief, status: result.status, items: secured.rows, blocked };
}

module.exports = { generateBrief, failureCode };
