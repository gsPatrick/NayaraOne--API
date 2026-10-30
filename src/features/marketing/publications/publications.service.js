'use strict';

const { scheduleJobs, createJobs, jobKey } = require('./schedule/schedule.service');
const { cancelJob } = require('./schedule/schedule.cancel');
const { listPublications } = require('./schedule/schedule.list');
const { deriveItemStatus, recomputeItemStatus } = require('./schedule/schedule.status');
const { SCHEDULE_SETTINGS_SCHEMA, SCHEDULE_SETTING_DEFAULTS } = require('./schedule/schedule.settings');
require('./schedule/schedule.impact'); // registra o provedor de impacto do cancelamento (M9-D852, linha 18)

/**
 * Marketing / publications — serviço da área (M9-D410): agendamento (um job por canal), cancelamento, listagem e status do item derivado dos jobs.
 * O worker de publicação (M9-D411) usa `recomputeItemStatus` e `deriveItemStatus` para fechar o item.
 */
module.exports = {
  scheduleJobs, createJobs, jobKey, cancelJob, listPublications, deriveItemStatus, recomputeItemStatus, SCHEDULE_SETTINGS_SCHEMA, SCHEDULE_SETTING_DEFAULTS,
};
