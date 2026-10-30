'use strict';

const { File } = require('../../../models');
const { canReadFile } = require('../../files/fileAccess.service');
const E = require('./whatsapp.errors');

const ESCALA = Object.freeze(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PUBLIC sempre; as demais só até o teto que a empresa autoriza; sem classificação (ninguém classificou) ou RESTRICTED ficam de fora: falha fechada. */
const classificationAllowed = (classification, teto) => {
  const posicao = ESCALA.indexOf(classification);
  return posicao >= 0 && posicao <= ESCALA.indexOf(teto);
};

/**
 * Mídia que sai (M9-D230 3.3): `mediaRef` é o id de um arquivo do módulo `files`. Na ordem: existe na empresa (404), quem envia tem acesso (403), classificação dentro do teto (403), antivírus CLEAN
 * (422), tipo da lista do canal (422) e tamanho dentro do limite (413). Devolve o que vai no pedido (id, tipo e classificação), nunca o conteúdo; o link assinado é feito no momento do envio.
 */
async function prepareOutboundMedia({ auth, fileId, params, transaction }) {
  if (typeof fileId !== 'string' || !UUID.test(fileId)) throw E.mediaNotFound(fileId);
  const file = await File.findOne({ where: { id: fileId, companyId: auth.companyId }, transaction });
  if (!file) throw E.mediaNotFound(fileId);
  if (!(await canReadFile(file, auth, transaction))) throw E.mediaNotAuthorized(fileId);
  if (!classificationAllowed(file.classification, params.mediaMaxClassification)) throw E.mediaClassification(fileId, file.classification ? 'ABOVE_LIMIT' : 'UNCLASSIFIED');
  if (file.scanStatus !== 'CLEAN') throw E.mediaNotClean(fileId);
  const mime = String(file.mimeType || '').toLowerCase();
  if (!params.mediaAllowedTypes.includes(mime)) throw E.mediaType(fileId, mime || null);
  const bytes = Number(file.sizeBytes) || 0;
  if (bytes > params.maxMediaBytes) throw E.mediaTooLarge(bytes, params.maxMediaBytes);
  return { fileId: file.id, mimeType: mime, classification: file.classification, fileName: file.fileName, sizeBytes: bytes };
}

module.exports = { prepareOutboundMedia, classificationAllowed };
