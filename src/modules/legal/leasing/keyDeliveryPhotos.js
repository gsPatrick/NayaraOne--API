'use strict';

const { File } = require('../../../models');
const AppError = require('../../../utils/AppError');

// Fechamento M5 (Caderno §10 "Fotos obrigatórias quando política exigir"): a obrigatoriedade só vale
// se a foto existir — um id inventado ou de outro tipo de arquivo não é foto. Cada id precisa ser
// um arquivo de imagem enviado nesta empresa (a RLS já esconde os de outra empresa).
const PHOTO_INVALID = 'LEGAL_KEY_DELIVERY_PHOTO_INVALID';

async function assertPhotosAreRealImages(photosFileIds, contract, transaction) {
  if (photosFileIds === undefined || photosFileIds === null) return;
  if (!Array.isArray(photosFileIds) || photosFileIds.some((id) => !/^[0-9a-f-]{36}$/i.test(String(id)))) {
    throw AppError.badRequest('"photosFileIds" deve ser uma lista de arquivos de foto enviados ao sistema.', PHOTO_INVALID);
  }
  const unique = [...new Set(photosFileIds.map(String))];
  if (unique.length === 0) return;
  const files = await File.findAll({ where: { id: unique, companyId: contract.companyId }, attributes: ['id', 'mimeType'], transaction });
  const images = files.filter((f) => String(f.mimeType || '').toLowerCase().startsWith('image/'));
  if (images.length !== unique.length) {
    throw AppError.badRequest('Cada foto da entrega precisa ser uma imagem enviada ao sistema por esta empresa.', PHOTO_INVALID);
  }
}

module.exports = { assertPhotosAreRealImages, PHOTO_INVALID };
