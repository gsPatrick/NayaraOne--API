'use strict';

/**
 * M9-D619 — parâmetro do administrador dos read models do Jurídico (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.juridico.processo_encerrado_status   status ou fase que tiram o processo de "ativo" (processos por risco e valor estimado).
 *                                                   Padrão CLOSED,ARCHIVED,CANCELLED (a fase CLOSED já existe no Jurídico).
 */
const { codeList, readCodeList } = require('./settings.codeList');

const FINISHED_KEY = 'analytics.juridico.processo_encerrado_status';
const JURIDICO_DEFAULTS = Object.freeze({ [FINISHED_KEY]: 'CLOSED,ARCHIVED,CANCELLED' });
const JURIDICO_SETTINGS_SCHEMA = { [FINISHED_KEY]: { type: 'string', validate: codeList } };

const readFinishedStatuses = (scope, transaction) => readCodeList(FINISHED_KEY, JURIDICO_DEFAULTS[FINISHED_KEY], scope, transaction);

module.exports = { FINISHED_KEY, JURIDICO_DEFAULTS, JURIDICO_SETTINGS_SCHEMA, readFinishedStatuses };
