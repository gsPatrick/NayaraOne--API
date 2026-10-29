'use strict';

const logger = require('../../../utils/logger');
const { resolveMaxClassification } = require('./minimization.params');

/**
 * minimizePayload — aplica o outputMapper de UMA operação e registra o que foi descartado (M9-D219 3.2).
 * `target`: { domain, operation, mapper }. `consentedFields`: nomes de campo que a pessoa consentiu enviar (FINANCING/SENSITIVE).
 * Devolve { payload, purpose, fieldsKept, fieldsDropped, maxClassification }. O log leva só NOMES de campo e contadores.
 */
async function minimizePayload(target, domainObject, tenant, transaction, { consentedFields = [] } = {}) {
  const maxClassification = await resolveMaxClassification(target.domain, tenant, transaction);
  const result = target.mapper.run(domainObject, { domain: target.domain, maxClassification, consentedFields });
  logger.info({
    event: 'integration.payload.minimized',
    domain: target.domain,
    operation: target.operation,
    purpose: result.purpose,
    fields_kept: result.fieldsKept.length,
    fields_dropped: result.fieldsDropped.length,
    dropped_fields: result.fieldsDropped,
  }, 'Payload de integração minimizado');
  return { ...result, maxClassification };
}

module.exports = { minimizePayload };
