'use strict';

const { assertCanReadFile } = require('../../../files/fileAccess.service');
const { rejectRestrictedUnlessAllowed } = require('../../../files/restrictedDocument.guard');
const { readDownloadParams } = require('./download.params');
const { decideDownload, issueDownloadGrant } = require('./download.request');
const { parseBatchIds, parseDownloadInput } = require('./download.input');

/**
 * POST /files/download-batch (M9-D920 §3.3): download em lote (zip) conta como exportação com volume = número de arquivos e passa SEMPRE pelo guard (mesmo só com LOW e MEDIUM:
 * o volume e o registro do pedido valem para o lote). Cada arquivo precisa ser legível por quem pede (as regras do download individual); a classe do pedido é a MAIS ALTA do lote.
 * Devolve o endereço assinado de uso único; o zip sai em GET /files/downloads/:id.
 */
async function requestBatch({ tenant, auth, ip, body, transaction }) {
  const params = await readDownloadParams(tenant, transaction);
  const ids = parseBatchIds(body && body.fileIds, params.batchMax);
  const items = [];
  for (const id of ids) {
    const { file, restricted } = await assertCanReadFile(id, auth, transaction); // eslint-disable-line no-await-in-loop
    rejectRestrictedUnlessAllowed(restricted, auth.permissions, file);
    items.push({ file, restricted });
  }
  const decided = await decideDownload({ tenant, auth, ip, items, input: parseDownloadInput(body), batch: true, transaction });
  return issueDownloadGrant(tenant, auth, decided);
}

module.exports = { requestBatch };
