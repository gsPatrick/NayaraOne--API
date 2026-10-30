'use strict';

const { mktError } = require('../marketing.errors');
const { CONTENT_TYPES } = require('./content.input');
const { DEFINITIONS, PUBLIC_CHANNELS } = require('./types/definitions');

/**
 * M9-D408 — parâmetro `marketing.autopublish.classes` (MKT-P029): a lista de classes autorizadas a sair sem aprovação humana. Padrão: lista vazia (nada autopublica).
 * Valor: JSON de objetos { tipo, canal, quando?, canais_agendamento? }. `tipo` é o tipo de conteúdo, `canal` o canal da classe (só canais de publicação: site,
 * portal e redes sociais; mensagem para uma pessoa nunca autopublica), `quando` os minutos de espera ALÉM da antecedência mínima do agendamento (padrão 0) e
 * `canais_agendamento` os canais onde agendar (padrão: o `canal`). Valor inválido: 422 MKT_PARAM_INVALID. A escrita exige marketing:automation:manage (autopublish.guard).
 */
const KEY = 'marketing.autopublish.classes';
const DEFAULT_VALUE = '[]';
const MAX_WAIT_MIN = 10080;
const FIELDS = Object.freeze(['tipo', 'canal', 'quando', 'canais_agendamento']);
const EXPECTED = 'Lista JSON de classes, ex.: [{"tipo":"SOLD_RENTED","canal":"SITE","quando":0,"canais_agendamento":["SITE"]}]';

const invalid = (reason, extra) => mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key: KEY, reason, esperado: EXPECTED, ...extra });

function parseOne(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('Cada classe deve ser um objeto.', { index });
  const extra = Object.keys(raw).filter((k) => !FIELDS.includes(k));
  if (extra.length > 0) throw invalid(`Campo(s) desconhecido(s): ${extra.join(', ')}.`, { index });
  if (!CONTENT_TYPES.includes(raw.tipo)) throw invalid('Tipo de conteúdo inválido.', { index, tipo: raw.tipo === undefined ? null : raw.tipo });
  const allowed = DEFINITIONS[raw.tipo].allowedChannels.filter((c) => PUBLIC_CHANNELS.includes(c));
  if (!allowed.includes(raw.canal)) throw invalid('Canal fora dos canais de publicação aceitos pelo tipo.', { index, canal: raw.canal === undefined ? null : raw.canal, permitidos: allowed });
  const quando = raw.quando === undefined ? 0 : raw.quando;
  if (!Number.isInteger(quando) || quando < 0 || quando > MAX_WAIT_MIN) throw invalid(`quando deve ser um inteiro de 0 a ${MAX_WAIT_MIN} (minutos).`, { index });
  const targets = raw.canais_agendamento === undefined ? [raw.canal] : raw.canais_agendamento;
  const valid = Array.isArray(targets) && targets.length > 0 && targets.every((c) => allowed.includes(c));
  if (!valid) throw invalid('canais_agendamento deve listar ao menos um canal de publicação aceito pelo tipo.', { index, permitidos: allowed });
  return { id: `${raw.tipo}+${raw.canal}`, tipo: raw.tipo, canal: raw.canal, quando, canais_agendamento: [...new Set(targets)] };
}

/** Texto do parâmetro -> classes normalizadas. Vazio = nenhuma classe. Inválido: 422 MKT_PARAM_INVALID. */
function parseClasses(text) {
  if (text === undefined || text === null || (typeof text === 'string' && !text.trim())) return [];
  let parsed;
  try { parsed = typeof text === 'string' ? JSON.parse(text) : text; } catch (err) { throw invalid('O valor não é um JSON válido.'); }
  if (!Array.isArray(parsed)) throw invalid('O valor deve ser uma lista de classes.');
  const classes = parsed.map(parseOne);
  const ids = classes.map((c) => c.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw invalid('Classe repetida (mesmo tipo e canal).', { classe: dup });
  return classes;
}

const AUTOPUBLISH_SETTINGS_SCHEMA = { [KEY]: { type: 'string', validate: (key, value) => { parseClasses(value); } } };

module.exports = { KEY, DEFAULT_VALUE, AUTOPUBLISH_SETTINGS_SCHEMA, parseClasses };
