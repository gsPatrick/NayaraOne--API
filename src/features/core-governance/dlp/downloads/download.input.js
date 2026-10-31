'use strict';

const { requestInvalid } = require('../dlp.errors');
const { batchInvalid } = require('../grants/grant.errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const yes = (value) => value === true || value === '1' || value === 'true';

/** Finalidade, justificativa e pedido de marca d'água, vindos da query (GET) ou do corpo (POST). Texto inválido vira vazio: quem recusa é a etapa de finalidade do guard. */
function parseDownloadInput(source) {
  const src = source && typeof source === 'object' ? source : {};
  return {
    purpose: typeof src.purpose === 'string' ? src.purpose : null,
    justification: typeof src.justification === 'string' ? src.justification : null,
    watermark: yes(src.watermark),
  };
}

/** Lista de arquivos do lote: de 1 a `max` ids de arquivo, sem repetir. */
function parseBatchIds(value, max) {
  if (!Array.isArray(value) || !value.length || value.length > max || value.some((id) => typeof id !== 'string' || !UUID.test(id)) || new Set(value).size !== value.length) throw batchInvalid(max);
  return value;
}

function assertUuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw requestInvalid('Identificador inválido.', { field: 'id' });
  return value;
}

module.exports = { parseDownloadInput, parseBatchIds, assertUuid, yes };
