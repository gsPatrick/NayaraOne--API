'use strict';

// M9-D613 — API pública da camada briefs do BI. As demandas do Marco 9 acrescentam aqui o que a camada expõe.
// M9-D695: ferramentas da NAY Diretoria (catálogo fechado de leitura, guarda contra consulta livre, serviço).
// M9-D693 / M9-D694: briefing diário e semanal (geração, leitura por leitor), variação do servidor e grounding determinístico.
const settings = require('../briefSettings');
const period = require('./brief.period');
const generate = require('./brief.generate');
const read = require('./brief.read');
const events = require('./brief.events');
const variation = require('./variation.service');
const grounding = require('./groundingValidator');

module.exports = {
  camada: 'briefs',
  ...require('./nayTools'),
  generateBrief: generate.generateBrief,
  getBriefForReader: read.getBriefForReader,
  UNAVAILABLE_TEXT: read.UNAVAILABLE_TEXT,
  readBriefParams: settings.readBriefParams,
  BRIEF_SETTINGS_SCHEMA: settings.BRIEF_SETTINGS_SCHEMA,
  BRIEF_SETTING_KEYS: settings.KEYS,
  coveredPeriod: period.coveredPeriod,
  isBriefDue: period.isDue,
  onBriefEvent: events.onBriefEvent,
  BRIEF_EVENT_TYPES: events.TYPES,
  computeVariation: variation.computeVariation,
  validateBriefItem: grounding.validateItem,
};
