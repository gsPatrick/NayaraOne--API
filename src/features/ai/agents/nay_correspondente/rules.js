'use strict';

const AppError = require('../../../../utils/AppError');
const { permissionDenied, crossCompanyBlocked } = require('../../orchestrator/toolSecurity.errors');
const { CODE } = require('./definition');
const { correspondentReaders } = require('./readers');
const F = require('./rules.format');

/**
 * Resolvedores de regra da NAY Correspondente (M9-D039, caminho RULE do ModelRouter): listar casos parados, pendências, simulações e status
 * são consultas de código, sem modelo e com custo zero. Cada um confere a permissão do ator (`correspondent:read`), usa as mesmas leituras
 * das ferramentas e devolve a resposta com a fonte e a data da consulta. Pedido de outra empresa responde como "não encontrado".
 */
const PERMISSION = 'correspondent:read';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const sourceOf = (ref, title, text, asOf) => ({ sourceType: 'READ_MODEL', sourceRef: ref, title, text, values: [], classification: 'INTERNAL', retrievedAt: asOf });

async function guarded(read) {
  try {
    return await read();
  } catch (err) {
    if (err instanceof AppError && err.code === 'FINANCING_CASE_NOT_FOUND') throw crossCompanyBlocked();
    throw err;
  }
}

/** Monta um resolvedor: confere agente e permissão, lê, formata e devolve `{ answer, sources }`; sem id de caso (quando exigido) devolve null para o roteador seguir. */
function resolverOf({ needsCase, read, format, title }) {
  return async (ruleInput, { tenant, transaction }) => {
    if (!ruleInput || ruleInput.agentCode !== CODE) return null;
    if (!(ruleInput.permissions || []).includes(PERMISSION)) throw permissionDenied();
    const found = needsCase ? String(ruleInput.input || '').match(UUID_RE) : null;
    const caseId = found ? found[0].toLowerCase() : undefined;
    if (needsCase && !caseId) return null;
    const result = await guarded(() => read(correspondentReaders(transaction, tenant), caseId));
    const answer = format(result);
    const ref = result.source;
    return { answer, snapshotAt: result.asOf, sources: [sourceOf(ref, title, answer, new Date(result.asOf))] };
  };
}

const RULE_TASKS = Object.freeze({
  correspondente_casos_parados: resolverOf({ needsCase: false, read: (r) => r.getStalledCases(), format: F.formatStalled, title: 'Casos de financiamento parados' }),
  correspondente_pendencias: resolverOf({ needsCase: true, read: (r, id) => r.getPendingRequirements(id), format: F.formatPending, title: 'Exigências abertas do caso' }),
  correspondente_comparar_simulacoes: resolverOf({ needsCase: true, read: (r, id) => r.compareSimulations(id), format: F.formatSimulations, title: 'Simulações do caso' }),
  correspondente_status_caso: resolverOf({ needsCase: true, read: (r, id) => r.getStatus(id), format: F.formatStatus, title: 'Situação do caso' }),
});

module.exports = { RULE_TASKS };
