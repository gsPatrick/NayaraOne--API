'use strict';

const { File } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { keyDeliveryMinPhotos } = require('../shared/legalRules.params');

/**
 * Livro §10 "Fotos obrigatórias quando política exigir". A política é configuração da empresa por tipo de contrato (e
 * para o termo de imóvel usado), com quantidade mínima (`legal.chaves.fotos_minimas.<TIPO>`, legalRules.settings.js;
 * padrão = o que valia antes: venda e imóvel usado 1 foto, locação 0). O cliente não escolhe a política (o corpo que tenta
 * é recusado em key-delivery.service). A obrigatoriedade só vale se a foto existir: cada id precisa ser um arquivo de
 * imagem enviado nesta empresa (a RLS já esconde os de outra empresa) e as fotos contam sem repetição.
 */
const PHOTO_INVALID = 'LEGAL_KEY_DELIVERY_PHOTO_INVALID';
const SALE_LIKE = ['SALE', 'SALE_CASH', 'SALE_FINANCED', 'SALE_TRADE', 'SALE_INSTALLMENTS'];
const LEASE_LIKE = ['LEASE', 'LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL', 'PROPERTY_ADMIN'];

function policyCode(policyType, contractType, minPhotos) {
  if (minPhotos > 0) {
    if (policyType === 'USED_PROPERTY_DELIVERY') return 'REQUIRED_USED_PROPERTY';
    return SALE_LIKE.includes(contractType) ? 'REQUIRED_SALE_DELIVERY' : 'REQUIRED_BY_CONTRACT_TYPE';
  }
  return LEASE_LIKE.includes(contractType) ? 'NOT_REQUIRED_LEASE_CHECKIN_SIGNED' : 'NOT_REQUIRED_BY_CONTRACT_TYPE';
}

function policyText(code, minPhotos) {
  const qty = `${minPhotos} ${minPhotos === 1 ? 'foto' : 'fotos'}`;
  if (code === 'REQUIRED_USED_PROPERTY') return `Fotos obrigatórias (no mínimo ${qty}): por se tratar de entrega de imóvel usado, o estado do imóvel é registrado em fotos anexadas a este termo.`;
  if (code === 'REQUIRED_SALE_DELIVERY') return `Fotos obrigatórias (no mínimo ${qty}): por se tratar de entrega de imóvel vendido, o estado do imóvel é registrado em fotos anexadas a este termo.`;
  if (code === 'REQUIRED_BY_CONTRACT_TYPE') return `Fotos obrigatórias (no mínimo ${qty}), conforme a política da empresa para este tipo de contrato.`;
  if (code === 'NOT_REQUIRED_LEASE_CHECKIN_SIGNED') return 'Fotos não obrigatórias nesta entrega: o estado do imóvel já está registrado na vistoria de entrada assinada pelo locador e pelo locatário.';
  return 'Fotos não obrigatórias nesta entrega, conforme a política da empresa para este tipo de contrato.';
}

/** Política de fotos da entrega: { code, photosRequired, minPhotos, policyType, text }. */
async function resolveKeyDeliveryPhotoPolicy(contract, keyDelivery, transaction) {
  const tenant = { groupId: contract.groupId, companyId: contract.companyId };
  const { policyType, minPhotos } = await keyDeliveryMinPhotos(contract.contractType, keyDelivery && keyDelivery.termType, tenant, transaction);
  const code = policyCode(policyType, contract.contractType, minPhotos);
  return { code, photosRequired: minPhotos > 0, minPhotos, policyType, text: policyText(code, minPhotos) };
}

async function assertPhotosAreRealImages(photosFileIds, contract, transaction) {
  if (photosFileIds === undefined || photosFileIds === null) return 0;
  if (!Array.isArray(photosFileIds) || photosFileIds.some((id) => !/^[0-9a-f-]{36}$/i.test(String(id)))) {
    throw AppError.badRequest('"photosFileIds" deve ser uma lista de arquivos de foto enviados ao sistema.', PHOTO_INVALID);
  }
  const unique = [...new Set(photosFileIds.map(String))];
  if (unique.length === 0) return 0;
  const files = await File.findAll({ where: { id: unique, companyId: contract.companyId }, attributes: ['id', 'mimeType'], transaction });
  const images = files.filter((f) => String(f.mimeType || '').toLowerCase().startsWith('image/'));
  if (images.length !== unique.length) {
    throw AppError.badRequest('Cada foto da entrega precisa ser uma imagem enviada ao sistema por esta empresa.', PHOTO_INVALID);
  }
  return unique.length;
}

/** Confere as fotos contra a política: imagens reais da empresa e, quando exigidas, no mínimo a quantidade da política. */
async function assertPhotoPolicy(policy, photosFileIds, contract, transaction) {
  const count = await assertPhotosAreRealImages(photosFileIds, contract, transaction);
  if (policy.photosRequired && count < policy.minPhotos) {
    throw AppError.conflict(
      count === 0
        ? `Não é possível liberar as chaves: a política exige fotos obrigatórias (no mínimo ${policy.minPhotos}) e nenhuma foi informada ("photosFileIds").`
        : `Não é possível liberar as chaves: a política exige no mínimo ${policy.minPhotos} fotos diferentes e foram informadas ${count}.`,
      'LEGAL_KEY_DELIVERY_PHOTOS_REQUIRED',
      { minPhotos: policy.minPhotos, informed: count }
    );
  }
}

module.exports = { resolveKeyDeliveryPhotoPolicy, assertPhotosAreRealImages, assertPhotoPolicy, PHOTO_INVALID };
