'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishGovernanceEvent } = require('../governance.events');
const { getSetting } = require('../../settings/settings.service');
const { govError } = require('../governance.errors');
const { STATUS } = require('./bcp.constants');
const { parsePagination, pageResult } = require('../api-governance/standards/pagination.helper');
const { LIST_LIMIT_KEY, BCP_SETTING_DEFAULTS } = require('./bcp.settings');
const { assertUserSector, userSectors } = require('./bcp.sectors');
const { validatePayload } = require('./bcp.payload');
const repository = require('./manualOperation.repository');
const templates = require('./formTemplates.repository');
const input = require('./manualOperation.input');
const E = require('./bcp.errors');
const { recordPreparer } = require('./payment/payment.guard');
const { ACTION: PAYMENT_ACTION } = require('./payment/payment.constants');

const EVENT_RECORDED = 'bcp.manual_operation.recorded';

/**
 * Registra a operação feita no papel (M9-D831 §3.3-3.4). Só guarda a intenção: nenhum efeito de negócio (isso é da importação). Payload inválido NUNCA recusa: grava RECORDED com
 * `validation_errors` e a operação não é importável até o PATCH deixá-lo sem erros. Operação, evento e auditoria saem na MESMA transação; referência repetida na empresa é 409
 * (UNIQUE tratado por ON CONFLICT, valendo também entre requisições simultâneas).
 */
async function recordOperation({ tenant, actorUserId, body, transaction }) {
  const sector = input.readSector(body);
  await assertUserSector(actorUserId, tenant, sector, transaction);
  const manualReference = input.checkReference(sector, body.manualReference);
  if (typeof body.evidenceFileId !== 'string' || !input.UUID.test(body.evidenceFileId) || !(await repository.evidenceExists(tenant.companyId, body.evidenceFileId, transaction))) {
    throw E.evidenceRequired();
  }
  const occurredAt = input.checkOccurredAt(body.occurredAt);
  const form = await input.checkFormAndAction(sector, body.formType, body.intendedAction, transaction);
  const correlationRef = input.checkCorrelation(body.correlationRef);
  const payload = body.payload === undefined ? {} : body.payload;
  const validationErrors = validatePayload(form, payload);

  const operation = await repository.insertOperation({
    groupId: tenant.groupId, companyId: tenant.companyId, manualReference, sector, occurredAt, actorUserId, evidenceFileId: body.evidenceFileId,
    intendedAction: form.intendedAction, formType: form.formType, payload, correlationRef, validationErrors,
  }, transaction);
  if (!operation) throw E.referenceDuplicate();

  if (operation.intendedAction === PAYMENT_ACTION) await recordPreparer({ tenant, operation }, transaction); // checker_1 gravado no registro (M9-D833)
  await publishGovernanceEvent({
    groupId: tenant.groupId, companyId: tenant.companyId, aggregateType: 'BcpManualOperation', aggregateId: operation.id, eventType: EVENT_RECORDED,
    // A chave do outbox é única na plataforma toda; o número do papel só é único por empresa, então a empresa entra na chave.
    idempotencyKey: `${EVENT_RECORDED}:${tenant.companyId}:${manualReference}`,
    payload: { manualReference, sector, formType: form.formType, intendedAction: form.intendedAction, correlationRef, occurredAt: occurredAt.toISOString(), actorUserId, valid: validationErrors.length === 0 },
  }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: EVENT_RECORDED, entityType: 'ManualOperation', entityId: operation.id,
    beforeJson: null, afterJson: { manualReference, sector, formType: form.formType, status: operation.status, validationErrors },
    reason: `Operação manual ${manualReference} registrada (${sector}).`,
  }, transaction);
  return operation;
}

/** Corrige o payload de uma operação RECORDED (M9-D831 §3.4 item 3). Setor do usuário, só RECORDED (409) e payload que passe (422); a versão anterior fica na auditoria. */
async function updatePayload({ tenant, actorUserId, id, body, transaction }) {
  const current = await repository.findById(tenant.companyId, id, transaction, { lock: true });
  if (!current) throw govError(404, 'GOV_NOT_FOUND', 'Operação manual não encontrada.');
  await assertUserSector(actorUserId, tenant, current.sector, transaction);
  if (current.status !== STATUS.RECORDED) throw E.notEditable();
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.payload === undefined) throw govError(400, 'VALIDATION_ERROR', 'Envie o campo "payload".', { field: 'payload' });
  const errors = validatePayload(await templates.findByFormType(current.formType, transaction), body.payload);
  if (errors.length) throw E.payloadInvalid(errors);
  const updated = await repository.updatePayload(tenant.companyId, id, body.payload, [], transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'bcp.manual_operation.updated', entityType: 'ManualOperation', entityId: id,
    beforeJson: { payload: current.payload, validationErrors: current.validationErrors }, afterJson: { payload: updated.payload, validationErrors: [] },
    reason: `Dados da operação manual ${current.manualReference} corrigidos.`,
  }, transaction);
  return updated;
}

/** Lista as operações, sempre limitada aos setores do usuário (M9-D830 §3.0b); filtros status, sector e correlationRef; página (page/pageSize, M9-D843) com tamanho padrão do parâmetro governanca.bcp.listagem_limite. */
async function listOperations({ tenant, actorUserId, query = {}, transaction }) {
  const mine = await userSectors(actorUserId, tenant, transaction);
  const sectors = query.sector ? mine.filter((sector) => sector === query.sector) : mine;
  if (query.correlationRef && !input.UUID.test(String(query.correlationRef))) throw govError(400, 'VALIDATION_ERROR', 'A referência de correlação deve ser um UUID.', { field: 'correlationRef' });
  if (query.status && !Object.values(STATUS).includes(query.status)) throw govError(400, 'VALIDATION_ERROR', `O status deve ser um destes: ${Object.values(STATUS).join(', ')}.`, { field: 'status' });
  const paging = await parsePagination(query, tenant, transaction, await getSetting(LIST_LIMIT_KEY, tenant, transaction, BCP_SETTING_DEFAULTS[LIST_LIMIT_KEY]));
  if (!sectors.length) return pageResult([], paging, 0);
  const { rows, total } = await repository.listOperations(tenant.companyId, { sectors, status: query.status, sector: query.sector, correlationRef: query.correlationRef && String(query.correlationRef).toLowerCase(), limit: paging.limit, offset: paging.offset }, transaction);
  return pageResult(rows, paging, total);
}

module.exports = { recordOperation, updatePayload, listOperations, EVENT_RECORDED };
