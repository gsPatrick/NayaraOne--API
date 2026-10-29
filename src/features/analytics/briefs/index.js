'use strict';

// M9-D613 — API pública da camada briefs do BI. As demandas do Marco 9 acrescentam aqui o que a camada expõe.
// M9-D695: ferramentas da NAY Diretoria (catálogo fechado de leitura, guarda contra consulta livre, serviço).
// M9-D694: variação do servidor, grounding determinístico e o evento de item bloqueado do briefing da NAY Diretoria.
const events = require('./brief.events');
const variation = require('./variation.service');
const grounding = require('./groundingValidator');

module.exports = {
  camada: 'briefs',
  ...require('./nayTools'),
  onBriefEvent: events.onBriefEvent,
  BRIEF_EVENT_TYPES: events.TYPES,
  computeVariation: variation.computeVariation,
  validateBriefItem: grounding.validateItem,
};
