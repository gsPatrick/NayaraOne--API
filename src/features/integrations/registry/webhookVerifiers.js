'use strict';

/**
 * Verificadores de assinatura de webhook prontos (M9-D211 3.3), expostos aos adapters pelo registry: o adapter de um fornecedor só importa de registry, http,
 * secrets e do próprio port (guarda de fronteiras da M9-D210). A implementação está em webhooks/verifiers.
 */
module.exports = require('../webhooks/verifiers/hmac');
