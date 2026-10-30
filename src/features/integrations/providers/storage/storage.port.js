'use strict';

const { definePort } = require('../ports/definePort');

/**
 * Port StorageAdapter (domínio STORAGE, M9-D209 e M9-D242): `putObject({key, stream, contentType, sha256, metadata})`, `getObject`, `deleteObject`, `headObject` e
 * `getSignedUrl({key, ttlSeconds, method})`. Todo pedido leva `companyId` (a empresa de quem chama, nunca do cliente): a chave precisa ter o prefixo `company/<id>/`.
 */
const StorageAdapter = definePort('StorageAdapter', 'STORAGE', {
  putObject: ['key', 'companyId'],
  getObject: ['key', 'companyId'],
  deleteObject: ['key', 'companyId'],
  headObject: ['key', 'companyId'],
  getSignedUrl: ['key', 'companyId'],
});

module.exports = { StorageAdapter };
