'use strict';

const { User } = require('../../../../models');
const { fillTemplate } = require('../exports/export.settings');
const { markFile, canMark, unsupported } = require('../watermark/watermark.service');

const stamp = (date) => date.toISOString().slice(0, 16).replace('T', ' ');

/** Recusa na hora, antes de qualquer endereço, quando a marca vale e o tipo do arquivo não a aceita (M9-D920 §3.4). */
function assertMarkable(files) {
  if (files.some((file) => !canMark(file.mimeType))) throw unsupported();
}

/** Texto da marca por usuário: o modelo do parâmetro com o nome (ou e-mail) de quem baixa, a data e o pedido. */
async function watermarkText({ template, actorUserId, jobId, now, transaction }) {
  const user = await User.findByPk(actorUserId, { transaction });
  return fillTemplate(template, { usuario: (user && (user.name || user.email)) || actorUserId, data: stamp(now), job: jobId });
}

/** Marca cada arquivo (cópia; o original e o hash dele não mudam). Qualquer falha recusa o download inteiro: nunca entrega sem a marca. */
async function markAll(items, text, { maxPages }) {
  const out = [];
  for (const item of items) out.push(await markFile(item, text, { maxPages })); // eslint-disable-line no-await-in-loop
  return out;
}

module.exports = { assertMarkable, watermarkText, markAll };
