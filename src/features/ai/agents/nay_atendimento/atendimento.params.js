'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { ATENDIMENTO_KEYS, ATENDIMENTO_SETTING_DEFAULTS } = require('./atendimento.settings');

/** Lista em texto separado por vírgula -> termos sem caixa e sem acento, sem vazios. */
const normalize = (texto) => String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const termsOf = (raw) => String(raw || '').split(',').map(normalize).filter(Boolean);

/** Lê os parâmetros do agente da empresa (valor da empresa; senão o padrão do CSV). */
async function loadAtendimentoParams(tenant, transaction) {
  const read = (key) => getSetting(key, tenant, transaction, ATENDIMENTO_SETTING_DEFAULTS[key]);
  const [papel, fora, canal, outro, anuncios, promessa, encaminhamento, escopo, semPromessa, max] = await Promise.all([
    read(ATENDIMENTO_KEYS.papelHandoff), read(ATENDIMENTO_KEYS.termosForaDaPolitica), read(ATENDIMENTO_KEYS.termosCanalExterno),
    read(ATENDIMENTO_KEYS.termosOutroCliente), read(ATENDIMENTO_KEYS.termosAnuncios), read(ATENDIMENTO_KEYS.termosPromessa),
    read(ATENDIMENTO_KEYS.mensagemEncaminhamento), read(ATENDIMENTO_KEYS.mensagemForaDoEscopo), read(ATENDIMENTO_KEYS.mensagemSemPromessa), read(ATENDIMENTO_KEYS.maxAnuncios),
  ]);
  return {
    papelHandoff: String(papel), termosForaDaPolitica: termsOf(fora), termosCanalExterno: termsOf(canal), termosOutroCliente: termsOf(outro),
    termosAnuncios: termsOf(anuncios), termosPromessa: termsOf(promessa), mensagemEncaminhamento: String(encaminhamento),
    mensagemForaDoEscopo: String(escopo), mensagemSemPromessa: String(semPromessa), maxAnuncios: Number.isInteger(max) ? max : ATENDIMENTO_SETTING_DEFAULTS[ATENDIMENTO_KEYS.maxAnuncios],
  };
}

module.exports = { loadAtendimentoParams, normalize, termsOf };
