'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { semAcento } = require('../numbers/decimalText');
const { GROUNDING_SETTING_DEFAULTS: D } = require('./grounding.settings');

const lista = (texto) => String(texto || '').split(',').map((t) => semAcento(t).trim()).filter(Boolean);

function numeroEntre0e1(valor, padrao) {
  const n = Number(valor);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : padrao;
}

/** Configuração efetiva da empresa (valor inválido volta ao padrão do livro/conservador, nunca ao zero). */
async function loadGroundingSettings(ctx, transaction) {
  const get = (key) => getSetting(key, ctx, transaction, D[key]);
  const [relevancia, bloquear, peso, tarefas, termos] = await Promise.all([
    get('ia.grounding.relevancia_minima'), get('ia.grounding.bloquear_sem_fonte'), get('ia.grounding.peso_relevancia'),
    get('ia.grounding.tarefas_nao_factuais'), get('ia.grounding.termos_criticos'),
  ]);
  return normalizeSettings({ relevanciaMinima: relevancia, bloquearSemFonte: bloquear, pesoRelevancia: peso, tarefasNaoFactuais: tarefas, termosCriticos: termos });
}

/** Aceita texto ou lista nas chaves de lista; completa o que faltar com o padrão. */
function normalizeSettings(raw = {}) {
  const asList = (v, key) => (Array.isArray(v) ? v.map((t) => semAcento(t).trim()).filter(Boolean) : lista(v === undefined ? D[key] : v));
  return Object.freeze({
    relevanciaMinima: numeroEntre0e1(raw.relevanciaMinima ?? D['ia.grounding.relevancia_minima'], D['ia.grounding.relevancia_minima']),
    bloquearSemFonte: raw.bloquearSemFonte === true || raw.bloquearSemFonte === 'true',
    pesoRelevancia: numeroEntre0e1(raw.pesoRelevancia ?? D['ia.grounding.peso_relevancia'], D['ia.grounding.peso_relevancia']),
    tarefasNaoFactuais: asList(raw.tarefasNaoFactuais, 'ia.grounding.tarefas_nao_factuais'),
    termosCriticos: asList(raw.termosCriticos, 'ia.grounding.termos_criticos'),
  });
}

module.exports = { loadGroundingSettings, normalizeSettings };
