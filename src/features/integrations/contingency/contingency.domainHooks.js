'use strict';

/**
 * Ganchos por família da contingência (Marco 9, M9-D227 e M9-D228). O framework (M9-D226) não conhece o domínio de negócio: cada família registra aqui o que é só dela.
 *  - filtro SQL da troca automática (qual envio NÃO pode ir ao alternativo, por exemplo o marketing do WhatsApp);
 *  - tratador do item vencido da fila (cancelar em vez de virar tarefa, por exemplo);
 *  - montador da tarefa manual (responsável, título e texto do domínio);
 *  - religação do domínio quando o envio da fila troca de connection;
 *  - passo extra por connection em contingência (marcar anúncios pendentes, enviar pelo canal alternativo de outra família).
 * Registrar de novo a mesma família substitui o registro anterior (idempotente no boot).
 */
const sqlFilters = new Map();
const agedHandlers = new Map();
const taskBuilders = new Map();
const steps = new Map();
const movedHooks = new Map();

const registerAlternateSqlFilter = (domain, sql) => { sqlFilters.set(domain, String(sql)); };
const registerAgedHandler = (domain, fn) => { agedHandlers.set(domain, fn); };
const registerManualTaskBuilder = (domain, fn) => { taskBuilders.set(domain, fn); };
const registerContingencyStep = (domain, fn) => { steps.set(domain, fn); };
const registerDispatchMoved = (domain, fn) => { movedHooks.set(domain, fn); };

/** Trecho `AND ...` (alias `d` = integration.dispatches) acrescentado à seleção da troca automática; vazio se a família não restringe. */
const alternateSqlFilter = (domain) => sqlFilters.get(domain) || '';

/** Item vencido da fila: `{ handled: true }` quando o domínio resolveu sozinho (não vira tarefa genérica). */
async function handleAged(domain, ctx, item, policy, now, transaction) {
  const fn = agedHandlers.get(domain);
  return fn ? fn(ctx, item, policy, now, transaction) : null;
}

/** Tarefa do domínio para o evento `integration.contingency.manual_task`: `{ assignedToUserId, title, description }` ou null (vale a tarefa genérica). */
async function buildManualTask(domain, event, transaction) {
  const fn = taskBuilders.get(domain);
  return fn ? fn(event, transaction) : null;
}

/** Passo do domínio para a connection em contingência: `(ctx, { connection, policy, params, now }, transaction)`. Devolve um resumo ou null. */
async function runDomainStep(domain, ctx, info, transaction) {
  const fn = steps.get(domain);
  return fn ? fn(ctx, info, transaction) : null;
}

/** O envio da fila foi levado a outra connection (troca para o alternativo): o domínio religa o que apontava para o envio antigo, NA MESMA transação da troca. */
async function runDispatchMoved(domain, ctx, info, transaction) {
  const fn = movedHooks.get(domain);
  return fn ? fn(ctx, info, transaction) : null;
}

/** O que a família registrou (para o painel e para os testes): { sqlFilter, agedHandler, taskBuilder, step, moved }. */
const registered = (domain) => ({ sqlFilter: sqlFilters.has(domain), agedHandler: agedHandlers.has(domain), taskBuilder: taskBuilders.has(domain), step: steps.has(domain), moved: movedHooks.has(domain) });

module.exports = { registered, registerDispatchMoved, runDispatchMoved, registerAlternateSqlFilter, registerAgedHandler, registerManualTaskBuilder, registerContingencyStep, alternateSqlFilter, handleAged, buildManualTask, runDomainStep };
