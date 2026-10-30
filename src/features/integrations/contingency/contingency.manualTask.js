'use strict';

const crypto = require('node:crypto');
const { Task } = require('../../../models');
const { publishDomainEvent } = require('../../../engines/events/outbox');
const { registerEventConsumer } = require('../../../engines/events/consumers');
const { createOnceByActionKey } = require('../../../utils/createOnceByActionKey');
const { activeUserIdsWithRole } = require('../../core-governance/governance.users');
const { EVENTS, RELATED_ENTITY_TYPE } = require('./contingency.constants');
const { buildManualTask } = require('./contingency.domainHooks');

const CONSUMER = 'integration-contingency-manual-task';

/** Texto objetivo do que a pessoa deve fazer, por modo (só ids e códigos: nada de dado pessoal). */
const TEXTO_POR_MODO = Object.freeze({
  QUEUE_AND_ALTERNATE: (d) => `Enviar a mensagem do envio ${d.dispatchId} (${d.operation}) pelo canal alternativo: ela está na fila há ${d.ageHours} h e o canal principal não voltou.`,
  KEEP_INTERNAL_AND_REPROCESS: (d) => `Conferir a publicação do envio ${d.dispatchId} (${d.operation}) pendente há ${d.ageHours} h. O dado interno está preservado: publicar manualmente no portal ou reprocessar quando ele voltar.`,
  PRESERVE_AND_ALTERNATE_FLOW: (d) => `Seguir pelo fluxo alternativo o envio ${d.dispatchId} (${d.operation}) pendente há ${d.ageHours} h, preservando o estado atual do processo (sem cancelar nem repetir às cegas).`,
  NO_ASSUME_AND_QUERY: (d) => `Consultar o banco sobre o envio ${d.dispatchId} (${d.operation}) pendente há ${d.ageHours} h antes de qualquer reenvio. Nada pode ser dado como pago sem confirmação.`,
  QUEUE_QUERY_OR_ALTERNATE_PROVIDER: (d) => `Acompanhar o envio ${d.dispatchId} (${d.operation}) pendente há ${d.ageHours} h: consultar o provider, usar o provider alternativo ou conduzir o caso pelo fluxo manual.`,
});
const TEXTO_PADRAO = (d) => `Tratar manualmente o envio ${d.dispatchId} (${d.operation}), pendente há ${d.ageHours} h por contingência da integração.`;

/** Publica UMA vez por envio o evento `integration.contingency.manual_task` (a chave é o id do envio). */
async function publishManualTask(ctx, { item, policy, domain, dueH, now }, transaction) {
  const ageHours = Math.floor((now.getTime() - new Date(item.createdAt).getTime()) / 3600000);
  const dados = { dispatchId: item.id, operation: item.operation, ageHours };
  return publishDomainEvent({
    groupId: ctx.groupId, companyId: ctx.companyId, aggregateType: 'IntegrationDispatch', aggregateId: item.id, eventType: EVENTS.MANUAL_TASK,
    payload: {
      dispatchId: item.id, connectionId: item.connectionId, providerCode: item.providerCode, domain, mode: policy.mode, operation: item.operation, criticalityOp: item.criticalityOp,
      assigneeRole: policy.manualTaskAssigneeRole, dueAt: new Date(now.getTime() + dueH * 3600000).toISOString(), ageHours, text: (TEXTO_POR_MODO[policy.mode] || TEXTO_PADRAO)(dados),
    },
    idempotencyKey: `${EVENTS.MANUAL_TASK}:${item.id}`,
  }, transaction);
}

/** Consumidor do evento: cria a tarefa na caixa única de tarefas (core.tasks), uma por envio, para a pessoa ativa do papel indicado. */
async function onManualTask(event, transaction) {
  const p = event.payloadJson || {};
  const donos = (await activeUserIdsWithRole(p.assigneeRole, { companyId: event.companyId }, transaction)).sort();
  const doDominio = await buildManualTask(p.domain, event, transaction); // M9-D227: o domínio dá o responsável, o título e o texto da tarefa
  const { record } = await createOnceByActionKey(Task, {
    groupId: event.groupId, companyId: event.companyId, assignedToUserId: (doDominio && doDominio.assignedToUserId) || donos[0] || null,
    title: ((doDominio && doDominio.title) || `Contingência: tratar envio pendente (${p.providerCode})`).slice(0, 255), description: String((doDominio && doDominio.description) || p.text || '').slice(0, 2000),
    relatedEntityType: RELATED_ENTITY_TYPE, relatedEntityId: p.dispatchId, dueAt: p.dueAt ? new Date(p.dueAt) : null, status: 'OPEN', priority: 'HIGH',
    actionKey: crypto.createHash('sha256').update(`${EVENTS.MANUAL_TASK}:${p.dispatchId}`).digest('hex'),
  }, { transaction });
  return record;
}

registerEventConsumer(EVENTS.MANUAL_TASK, CONSUMER, onManualTask);

module.exports = { publishManualTask, onManualTask, CONSUMER };
