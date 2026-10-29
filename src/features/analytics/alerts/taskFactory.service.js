'use strict';

/**
 * M9-D692 (3.3) — a tarefa do alerta CRITICAL com `create_task`. Sempre TAREFA (core.tasks, a mesma entidade operacional do CRM, Jurídico e
 * Cobrança), atribuída ao owner, com título "Alerta crítico: <código>", link do painel, prazo (`analytics.alert.prazo_tarefa_horas`) e a origem
 * `analytics.alert_instance:<id>` em related_entity_type/id e, em SHA-256, na chave de idempotência (action_key, única por empresa): uma instância, no máximo
 * uma tarefa, mesmo com duas avaliações simultâneas. A tarefa é texto e atribuição: não executa nada (nunca pagamento). Concluir a tarefa não
 * resolve o alerta (só a normalização, M9-D691).
 */
const crypto = require('node:crypto');
const { Task } = require('../../../models');
const { createOnceByActionKey } = require('../../../utils/createOnceByActionKey');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');

const SOURCE = 'analytics.alert_instance';
const HOUR_MS = 3600 * 1000;
const sourceOf = (instanceId) => `${SOURCE}:${instanceId}`;
/** action_key é um SHA-256 hexadecimal (CHECK da tabela): o hash da origem `analytics.alert_instance:<id>`. */
const actionKeyOf = (instanceId) => crypto.createHash('sha256').update(sourceOf(instanceId)).digest('hex');

/** Cria (ou devolve, em replay) a tarefa da instância. `assigneeId` é o primeiro usuário ativo do owner; `recipients` informa quantos mais foram avisados. */
async function createAlertTask({ def, instance, scope, assigneeId, ownerLabel, link, params, now }, transaction) {
  const dueAt = new Date(new Date(now).getTime() + params.taskHours * HOUR_MS);
  const { record, replay } = await createOnceByActionKey(Task, {
    groupId: scope.groupId,
    companyId: scope.companyId,
    assignedToUserId: assigneeId || null,
    title: `Alerta crítico: ${def.alert_code}`.slice(0, 255),
    description: `O alerta ${def.alert_code} (indicador ${instance.metric_code || def.metric_code}) foi aberto com gravidade crítica. Responsável: ${ownerLabel}. Painel: ${link}. Conferir a causa e agir; a tarefa não executa nenhuma ação financeira.`,
    relatedEntityType: SOURCE,
    relatedEntityId: instance.id,
    dueAt,
    status: 'OPEN',
    priority: 'HIGH',
    actionKey: actionKeyOf(instance.id),
    createdBy: null,
    updatedBy: null,
  }, { transaction });
  if (!replay) {
    await registrarAuditoria({
      groupId: scope.groupId, companyId: scope.companyId, actorUserId: null, action: 'analytics.alert.task_create', entityType: 'core.tasks', entityId: record.id,
      beforeJson: null, afterJson: { taskId: record.id, source: sourceOf(instance.id), assignedToUserId: record.assignedToUserId, dueAt, alertCode: def.alert_code },
      reason: `Tarefa do alerta crítico ${def.alert_code} (instância ${instance.id})`,
    }, transaction);
  }
  return record;
}

module.exports = { createAlertTask, sourceOf, actionKeyOf, SOURCE };
