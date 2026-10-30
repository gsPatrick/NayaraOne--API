'use strict';

const definition = require('./definition');
const { provisionNayAtendimento } = require('./provision');
const { atendimentoChat, prepareAtendimentoChat } = require('./chat');
const { registerAtendimentoHooks } = require('./hooks');
const { classifyMessage, CATEGORIES } = require('./triage');
const { ATENDIMENTO_KEYS, ATENDIMENTO_SETTING_DEFAULTS, ATENDIMENTO_SETTINGS_SCHEMA } = require('./atendimento.settings');
const { GOLDEN_CASES } = require('./golden.cases');

registerAtendimentoHooks();

/** NAY Atendimento (M9-D041): triagem/chatbot de clientes externos dentro de políticas, só leitura e com encaminhamento a uma pessoa. */
module.exports = {
  ...definition, provisionNayAtendimento, atendimentoChat, prepareAtendimentoChat, registerAtendimentoHooks, classifyMessage, CATEGORIES, GOLDEN_CASES,
  ATENDIMENTO_KEYS, ATENDIMENTO_SETTING_DEFAULTS, ATENDIMENTO_SETTINGS_SCHEMA,
};
