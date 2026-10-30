'use strict';

const { registerQuarantineSink } = require('../../integrations/http/ssrf/quarantinePort');
const { receiveExternalUpload } = require('./quarantine.receive');

/**
 * O destino real da quarentena dos downloads por URL de terceiro (M9-D245 3.1 item 7, entregue aqui): todo conteúdo baixado por `ssrfGuard.fetchExternalUrl` entra em `files.quarantine`
 * com status QUARANTINED antes de ser usado. Precisa da empresa e da transação do chamador (`context.tenant`, `context.transaction`); sem elas o conteúdo não é gravado e a recusa sobe
 * (nada baixado de fora fica sem quarentena). Devolve a referência { quarantineId, status }.
 */
async function quarantineSink(item, context = {}) {
  if (!context.tenant || !context.tenant.companyId || !context.transaction) {
    throw Object.assign(new Error('O conteúdo baixado de fora precisa da empresa e da transação para entrar em quarentena.'), { code: 'INTEGRATION_FILE_QUARANTINE_CONTEXT_MISSING', statusCode: 500 });
  }
  const { quarantine } = await receiveExternalUpload(context.tenant, {
    buffer: item.buffer, declaredMime: item.contentType, fileName: null, connectionId: context.connection && context.connection.id, origin: item.origin,
  }, context.transaction);
  return { quarantineId: quarantine.id, status: quarantine.status };
}

const installQuarantineSink = () => registerQuarantineSink(quarantineSink);

module.exports = { quarantineSink, installQuarantineSink };
