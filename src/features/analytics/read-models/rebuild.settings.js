'use strict';

/**
 * M9-D608 — parâmetros do administrador para a reconstrução (rebuild) de read models (aba "BI e Centro de Comando" em /painel/configuracoes).
 *
 *  analytics.rebuild.habilitado                   liga/desliga o rebuild. Padrão do livro (Guia §4: "Permitir rebuild completo em LAB"):
 *                                                 LIGADO em LAB (qualquer ambiente que não seja produção ou homologação publicada) e DESLIGADO em produção.
 *                                                 Valor gravado pela empresa vence o padrão do ambiente.
 *  analytics.rebuild.janela_reaplicacao_minutos   quanto antes da fotografia o rebuild ainda procura eventos aplicados pelo worker para
 *                                                 reaplicar depois da troca (cobre a transação do worker mais longa).
 *
 * Dicionário em SETTINGS_SCHEMA (settings.service.js faz o spread). Import tardio do settings.service para não criar ciclo.
 */
const KEYS = Object.freeze({
  enabled: 'analytics.rebuild.habilitado',
  reapplyWindowMinutes: 'analytics.rebuild.janela_reaplicacao_minutos',
});

const REBUILD_DEFAULTS = Object.freeze({
  [KEYS.reapplyWindowMinutes]: 60,
});

const REBUILD_SETTINGS_SCHEMA = {
  [KEYS.enabled]: { type: 'boolean' },
  [KEYS.reapplyWindowMinutes]: { type: 'integer', min: 1, max: 1440 },
};

/** Ambiente publicado (produção ou homologação publicada)? Mesma leitura de DEPLOY_ENVIRONMENT/NODE_ENV usada pelo restante da API. */
function isPublishedEnvironment(env = process.env) {
  return env.NODE_ENV === 'production' || ['production', 'staging'].includes(env.DEPLOY_ENVIRONMENT);
}

/** { enabled, reapplyWindowMinutes } vigentes para a empresa (`ctx.companyId`); ausente ou inválido cai no padrão. */
async function readRebuildParams(ctx, transaction, env = process.env) {
  const { getSetting } = require('../../../features/settings/settings.service'); // import tardio: settings.service importa este arquivo
  const stored = await getSetting(KEYS.enabled, ctx, transaction, null);
  const window = await getSetting(KEYS.reapplyWindowMinutes, ctx, transaction, REBUILD_DEFAULTS[KEYS.reapplyWindowMinutes]);
  return {
    enabled: typeof stored === 'boolean' ? stored : !isPublishedEnvironment(env),
    reapplyWindowMinutes: Number.isInteger(window) && window >= 1 ? window : REBUILD_DEFAULTS[KEYS.reapplyWindowMinutes],
  };
}

module.exports = { KEYS, REBUILD_DEFAULTS, REBUILD_SETTINGS_SCHEMA, isPublishedEnvironment, readRebuildParams };
