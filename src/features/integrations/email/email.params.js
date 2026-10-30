'use strict';

const { getSetting } = require('../../settings/settings.service');
const { ATTACHMENT_SCALE } = require('./email.constants');

/** Padrões do livro e do parametros.csv (M9-D234): 10 MiB, pdf/png/jpg/docx/xlsx, teto CONFIDENTIAL. */
const PADROES = Object.freeze({ maxAttachmentBytes: 10485760, allowedTypes: Object.freeze(['pdf', 'png', 'jpg', 'docx', 'xlsx']), maxClassification: 'CONFIDENTIAL', maxRecipients: 50, maxAttachments: 10 });

const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

/** Extensões em minúsculas e sem repetição; "jpeg" vale "jpg". Lista vazia ou inválida volta ao padrão. */
function parseTypes(texto) {
  if (typeof texto !== 'string') return PADROES.allowedTypes;
  const lista = [...new Set(texto.split(',').map((x) => x.trim().toLowerCase().replace(/^jpeg$/, 'jpg')).filter(Boolean))];
  return lista.length ? lista : PADROES.allowedTypes;
}

async function readEmailParams(ctx, transaction) {
  const [bytes, tipos, classe, destinos, anexos] = await Promise.all([
    getSetting('integration.email.max_attachment_bytes', ctx, transaction, PADROES.maxAttachmentBytes),
    getSetting('integration.email.attachment_allowed_types', ctx, transaction, PADROES.allowedTypes.join(',')),
    getSetting('integration.email.max_attachment_classification', ctx, transaction, PADROES.maxClassification),
    getSetting('integration.email.max_recipients', ctx, transaction, PADROES.maxRecipients),
    getSetting('integration.email.max_attachments', ctx, transaction, PADROES.maxAttachments),
  ]);
  return {
    maxAttachmentBytes: inteiro(bytes, PADROES.maxAttachmentBytes, 1024),
    allowedTypes: parseTypes(tipos),
    maxClassification: ATTACHMENT_SCALE.includes(classe) ? classe : PADROES.maxClassification,
    maxRecipients: inteiro(destinos, PADROES.maxRecipients, 1),
    maxAttachments: inteiro(anexos, PADROES.maxAttachments, 1),
  };
}

module.exports = { PADROES, readEmailParams, parseTypes };
