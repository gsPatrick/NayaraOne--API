'use strict';

/**
 * M9-D708 — parâmetros do administrador da reconciliação e do aceite dos KPIs (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.ambiente            LAB (padrão) ou PRODUCAO. Para ir a PRODUCAO toda métrica PUBLICADA precisa de aceite ACCEPTED da versão atual
 *                                 (409 ANALYTICS_ENV_NOT_READY); a trava é do serviço de parâmetros (settings/ambienteBi.guard.js), vale para qualquer caminho.
 *   analytics.aceite.tolerancia   quanto a diferença entre o BI e o relatório pode ser para o aceite. Formato "dinheiro=0,00; contagem=0; demais=0":
 *                                 dinheiro vale para BRL, contagem para COUNT e demais para as outras unidades (percentual, horas, notas). Padrão 0 em tudo
 *                                 (o livro §23 exige o aceite dos owners e não diz quanto é tolerável: o mais conservador). Entrada inválida cai no padrão.
 * Arquivo sem dependências do serviço de parâmetros (settings.service.js faz o spread do dicionário); a leitura faz import tardio.
 */
const money = require('./formulas/money');

const KEYS = Object.freeze({ ambiente: 'analytics.ambiente', tolerancia: 'analytics.aceite.tolerancia' });
const AMBIENTES = Object.freeze(['LAB', 'PRODUCAO']);
const DEFAULTS = Object.freeze({
  [KEYS.ambiente]: 'LAB',
  [KEYS.tolerancia]: 'dinheiro=0,00; contagem=0; demais=0',
});
const TOLERANCE_NAMES = Object.freeze(['dinheiro', 'contagem', 'demais']);
const DECIMAL = /^\d+(?:[.,]\d+)?$/;

const ACCEPTANCE_SETTINGS_SCHEMA = {
  [KEYS.ambiente]: { type: 'string', enum: [...AMBIENTES] },
  [KEYS.tolerancia]: { type: 'string' },
};

/** { dinheiro, contagem, demais } em texto decimal com ponto, ou null se o texto não segue o formato (os três nomes, sem repetir, valores >= 0). */
function parseTolerance(text) {
  if (typeof text !== 'string') return null;
  const out = {};
  for (const part of text.split(';')) {
    const m = /^\s*([a-z]+)\s*=\s*(\S+)\s*$/.exec(part);
    if (!m || !TOLERANCE_NAMES.includes(m[1]) || out[m[1]] !== undefined || !DECIMAL.test(m[2])) return null;
    const value = m[2].replace(',', '.');
    out[m[1]] = m[1] === 'dinheiro' ? money.money(value) : value.replace(/^0+(?=\d)/, '');
  }
  return TOLERANCE_NAMES.every((n) => out[n] !== undefined) ? out : null;
}

/** Tolerância da unidade: dinheiro para BRL, contagem para COUNT, demais para o resto. */
function toleranceFor(parsed, unit) {
  if (unit === 'BRL' || unit === 'BRL_PER_UNIT') return parsed.dinheiro;
  if (unit === 'COUNT') return parsed.contagem;
  return parsed.demais;
}

async function readSetting(key, ctx, transaction) {
  const { getSetting } = require('../../settings/settings.service'); // import tardio: settings.service importa este arquivo
  return getSetting(key, { companyId: ctx.companyId, groupId: ctx.groupId }, transaction, DEFAULTS[key]);
}

/** Tolerâncias vigentes da empresa; valor ausente ou inválido cai no padrão. */
async function readTolerance(ctx, transaction) {
  return parseTolerance(await readSetting(KEYS.tolerancia, ctx, transaction)) || parseTolerance(DEFAULTS[KEYS.tolerancia]);
}

/** LAB ou PRODUCAO vigente da empresa; valor ausente ou inválido cai em LAB. */
async function readAmbiente(ctx, transaction) {
  const value = await readSetting(KEYS.ambiente, ctx, transaction);
  return AMBIENTES.includes(value) ? value : DEFAULTS[KEYS.ambiente];
}

module.exports = { KEYS, AMBIENTES, DEFAULTS, ACCEPTANCE_SETTINGS_SCHEMA, parseTolerance, toleranceFor, readTolerance, readAmbiente };
