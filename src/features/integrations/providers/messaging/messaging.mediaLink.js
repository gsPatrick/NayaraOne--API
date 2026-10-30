'use strict';

const { File } = require('../../../../models');
const storage = require('../../storage');
const { getSetting } = require('../../../settings/settings.service');

/** Erro no formato que o motor de envios classifica: sem `status` HTTP de fornecedor, é recusa do dado (VALIDATION) e não repete. */
const recusa = (code, message) => Object.assign(new Error(message), { code, status: 422 });

/**
 * Link de curta duração da mídia que sai (M9-D230 3.3): o fornecedor de mensagens busca o arquivo por um link assinado, que vale `integration.whatsapp.media_link_ttl_min` minutos (15). Feito NO MOMENTO
 * do envio, na transação do worker (`meta.transaction`, `meta.tenant`), porque o link da fila expiraria; confere de novo que o arquivo segue com o antivírus CLEAN. A validade final nunca passa do máximo da
 * URL assinada do armazenamento. Devolve { url, expiresAt, mimeType }.
 */
async function signedMediaLink(meta, fileId) {
  const { tenant, transaction } = meta || {};
  if (!tenant || !transaction) throw recusa('INTEGRATION_MESSAGING_MEDIA_CONTEXT_MISSING', 'Faltam a empresa e a transação para montar o link da mídia.');
  const file = await File.findOne({ where: { id: String(fileId), companyId: tenant.companyId }, transaction });
  if (!file) throw recusa('INTEGRATION_MESSAGING_MEDIA_NOT_FOUND', 'Arquivo da mídia não encontrado.');
  if (file.scanStatus !== 'CLEAN') throw recusa('INTEGRATION_MESSAGING_MEDIA_NOT_CLEAN', 'O arquivo ainda não foi liberado pela verificação de segurança.');
  const minutos = await getSetting('integration.whatsapp.media_link_ttl_min', tenant, transaction, 15);
  // O arquivo é lido do driver que o gravou (mesma regra da leitura do módulo de arquivos): chave sob a empresa, fornecedor e connection guardados nele.
  const assinada = await storage.getSignedUrl(tenant, {
    key: storage.buildKey(file.companyId, file.storageKey), ttlSeconds: Math.max(1, Number(minutos) || 15) * 60, method: 'GET', providerCode: file.storageProvider || 'storage-local-disk', connectionId: file.storageConnectionId || undefined,
  }, transaction);
  return { url: assinada.url, expiresAt: assinada.expiresAt, mimeType: file.mimeType || null };
}

module.exports = { signedMediaLink };
