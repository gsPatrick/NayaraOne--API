'use strict';

/**
 * M9-D434 — catálogo dos eventos de Marketing (Caderno §15, Guia §11): 8 linhas, 12 nomes, nenhum outro. Falha de run (FAILED) é
 * registro interno de auditoria e NÃO tem evento. Cada entrada diz o tipo do agregado, o campo que identifica o agregado, os campos
 * obrigatórios e opcionais do payload (lista fechada: campo fora dela é recusado), os campos que compõem a chave de idempotência
 * padrão e a demanda produtora. Mudança de contrato = nova SCHEMA_VERSION.
 */
const SCHEMA_VERSION = 1;

const entry = (aggregateType, aggregateField, producer, required, fields, keyFields = []) => Object.freeze({
  aggregateType, aggregateField, producer, required: Object.freeze(required), fields: Object.freeze(fields), keyFields: Object.freeze(keyFields),
});

const EVENT_CATALOG = Object.freeze({
  'marketing.content.created': entry('MarketingContent', 'contentId', 'M9-D406',
    ['contentId', 'type', 'sourceEntity', 'versionNo', 'createdBy'],
    { contentId: 'uuid', type: 'code', sourceEntity: 'ref', versionNo: 'int', createdBy: 'uuid' }, ['versionNo']),
  'marketing.content.approved': entry('MarketingContent', 'contentId', 'M9-D408',
    ['contentId', 'versionNo', 'approvedBy', 'autopublished'],
    { contentId: 'uuid', versionNo: 'int', approvedBy: 'uuid', autopublished: 'boolean' }, ['versionNo']),
  'marketing.publication.completed': entry('MarketingPublication', 'jobId', 'M9-D411',
    ['jobId', 'contentId', 'channel', 'externalPostId', 'externalUrl'],
    { jobId: 'uuid', contentId: 'uuid', channel: 'code', externalPostId: 'nullableCode', externalUrl: 'nullableUrl' }),
  'marketing.publication.failed': entry('MarketingPublication', 'jobId', 'M9-D411',
    ['jobId', 'channel', 'errorCode'],
    { jobId: 'uuid', channel: 'code', errorCode: 'code' }),
  'marketing.campaign.started': entry('MarketingCampaign', 'campaignId', 'M9-D412',
    ['campaignId', 'startsAt'], { campaignId: 'uuid', startsAt: 'iso' }),
  'marketing.campaign.ended': entry('MarketingCampaign', 'campaignId', 'M9-D412',
    ['campaignId', 'endedAt', 'result', 'cost'], { campaignId: 'uuid', endedAt: 'iso', result: 'amount', cost: 'amount' }),
  'automation.run.started': entry('AutomationRun', 'runId', 'M9-D414',
    ['runId', 'flowId', 'versionNo', 'subject'], { runId: 'uuid', flowId: 'uuid', versionNo: 'int', subject: 'ref' }),
  'automation.run.completed': entry('AutomationRun', 'runId', 'M9-D414',
    ['runId', 'actionsSummary'], { runId: 'uuid', actionsSummary: 'summary' }),
  'automation.run.blocked': entry('AutomationRun', 'runId', 'M9-D414',
    ['runId', 'blockedReason'], { runId: 'uuid', blockedReason: 'code' }),
  'customer.opted_out': entry('Person', 'personId', 'M9-D419',
    ['personId', 'channel', 'purpose', 'source'], { personId: 'uuid', channel: 'code', purpose: 'code', source: 'code' }, ['channel', 'purpose']),
  'review.requested': entry('ReviewRequest', 'reviewRequestId', 'M9-D424',
    ['reviewRequestId', 'personId', 'channel'], { reviewRequestId: 'uuid', personId: 'uuid', channel: 'code' }),
  'attribution.recorded': entry('AttributionEvent', 'eventId', 'M9-D431',
    ['eventId', 'campaignId', 'eventType', 'touchRole'],
    { eventId: 'uuid', campaignId: 'uuid', personId: 'uuid', personHash: 'hash', eventType: 'code', touchRole: 'code' }),
});

const EVENT_NAMES = Object.freeze(Object.keys(EVENT_CATALOG));

module.exports = { SCHEMA_VERSION, EVENT_CATALOG, EVENT_NAMES };
