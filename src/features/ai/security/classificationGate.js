'use strict';

const { restrictedNotAllowed } = require('./privacy.errors');

/**
 * Portão de classificação do que entra no prompt (M9-D027). Escala PUBLIC < INTERNAL < CONFIDENTIAL < RESTRICTED (equivale à de
 * integração PERSONAL/SENSITIVE de M9-D219).
 *  - PUBLIC e INTERNAL podem ir ao provider;
 *  - CONFIDENTIAL só ao provider com allowsConfidential=true e contrato de retenção registrado (contractRef);
 *  - RESTRICTED só se (a) a tarefa exige (needsRestricted), (b) o ator tem ai:restricted, (c) o provider tem allowsRestricted=true
 *    e retenção NONE e (d) a finalidade (purpose) foi informada.
 * Classe desconhecida conta como RESTRICTED (falha fechada). O portão devolve decisões sem o conteúdo.
 */
const FREE = Object.freeze(['PUBLIC', 'INTERNAL']);
const AVISO_RESTRITO = 'Parte do conteúdo restrito não foi usada.';
const AVISO_CONFIDENCIAL = 'Parte do conteúdo confidencial não foi usada.';

const temTexto = (v) => typeof v === 'string' && v.trim().length > 0;

function restrictedConditions({ task, actor, provider, purpose }) {
  return {
    taskNeedsIt: Boolean(task && task.needsRestricted),
    actorHasPermission: Array.isArray(actor && actor.permissions) && actor.permissions.includes('ai:restricted'),
    providerAllows: Boolean(provider && provider.allowsRestricted === true && provider.dataRetention === 'NONE'),
    purposeGiven: temTexto(purpose),
  };
}

const MOTIVO_RESTRITO = { taskNeedsIt: 'tarefa_nao_exige', actorHasPermission: 'sem_permissao', providerAllows: 'provider_nao_permite', purposeGiven: 'sem_finalidade' };

/** Decide uma classificação: { allowed, reason } (reason: o primeiro requisito que falhou). */
function decide(classification, context) {
  const { provider } = context;
  if (FREE.includes(classification)) return { allowed: true, reason: 'livre' };
  if (classification === 'CONFIDENTIAL') {
    if (provider && provider.allowsConfidential === true && temTexto(provider.contractRef)) return { allowed: true, reason: 'provider_permite_confidencial' };
    return { allowed: false, reason: provider && provider.allowsConfidential === true ? 'sem_contrato_de_retencao' : 'provider_nao_permite_confidencial' };
  }
  const c = restrictedConditions(context);
  const falhou = Object.keys(MOTIVO_RESTRITO).find((k) => !c[k]);
  return falhou ? { allowed: false, reason: MOTIVO_RESTRITO[falhou] } : { allowed: true, reason: 'quatro_condicoes' };
}

/**
 * Filtra as fontes do contexto. Devolve { allowed, omitted, decisions, notices }. Se a tarefa exige RESTRICTED (needsRestricted)
 * e alguma fonte restrita é recusada, a consulta inteira é recusada (403 AI_RESTRICTED_NOT_ALLOWED); caso contrário o trecho
 * é omitido e a resposta avisa.
 */
function applyClassificationGate(sources, context) {
  const allowed = [];
  const omitted = [];
  const decisions = [];
  let restrictedOmitted = false;
  let confidentialOmitted = false;
  for (const source of sources) {
    const classification = typeof source.classification === 'string' ? source.classification : 'RESTRICTED';
    const normalized = [...FREE, 'CONFIDENTIAL', 'RESTRICTED'].includes(classification) ? classification : 'RESTRICTED';
    const verdict = decide(normalized, context);
    decisions.push({ sourceId: source.id || null, classification: normalized, decision: verdict.allowed ? 'PERMITIDO' : 'OMITIDO', reason: verdict.reason });
    if (verdict.allowed) { allowed.push(source); continue; }
    omitted.push(source);
    if (normalized === 'RESTRICTED') restrictedOmitted = true; else confidentialOmitted = true;
  }
  if (restrictedOmitted && context.task && context.task.needsRestricted) {
    throw restrictedNotAllowed({ reasons: decisions.filter((d) => d.decision === 'OMITIDO' && d.classification === 'RESTRICTED').map((d) => d.reason) });
  }
  const notices = [];
  if (restrictedOmitted) notices.push(AVISO_RESTRITO);
  if (confidentialOmitted) notices.push(AVISO_CONFIDENCIAL);
  return { allowed, omitted, decisions, notices };
}

module.exports = { applyClassificationGate, decide, restrictedConditions, AVISO_RESTRITO, AVISO_CONFIDENCIAL };
