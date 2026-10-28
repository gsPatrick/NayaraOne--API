'use strict';

const { CHANNELS } = require('./campaigns.constants');
const { validation } = require('./campaigns.errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OFFSET_MINUTES = 60 * 24 * 366;

/** Steps da campanha na ordem recebida (step_no = posição, a partir de 1). Cada step usa um template; o conteúdo é opcional. */
function parseSteps(raw) {
  if (!Array.isArray(raw)) throw validation('O campo "steps" deve ser uma lista.', { field: 'steps' });
  return raw.map((item, index) => {
    const n = index + 1;
    if (!item || typeof item !== 'object') throw validation(`O step ${n} é inválido.`, { field: 'steps' });
    const channel = typeof item.channel === 'string' ? item.channel.trim().toUpperCase() : '';
    if (!CHANNELS.includes(channel)) throw validation(`O canal do step ${n} deve ser um de: ${CHANNELS.join(', ')}.`, { field: 'steps', allowed: CHANNELS });
    if (typeof item.templateId !== 'string' || !UUID_RE.test(item.templateId)) throw validation(`Informe o template do step ${n}.`, { field: 'steps' });
    if (item.contentItemId !== undefined && item.contentItemId !== null && (typeof item.contentItemId !== 'string' || !UUID_RE.test(item.contentItemId))) {
      throw validation(`O conteúdo do step ${n} é inválido.`, { field: 'steps' });
    }
    const offset = item.offsetMinutes === undefined || item.offsetMinutes === null ? 0 : item.offsetMinutes;
    if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET_MINUTES) {
      throw validation(`O deslocamento do step ${n} deve ser um número inteiro de minutos, de 0 a ${MAX_OFFSET_MINUTES}.`, { field: 'steps' });
    }
    return { stepNo: n, channel, templateId: item.templateId.toLowerCase(), contentItemId: item.contentItemId ? item.contentItemId.toLowerCase() : null, offsetMinutes: offset };
  });
}

module.exports = { parseSteps };
