'use strict';

/**
 * Recusa de anexo ADIADA pelo fileAttachGuard (pentest M5, achado 10): quem não tem a permissão da rota recebe PERMISSION_DENIED, não
 * FILE_ATTACH_FORBIDDEN. Todo middleware de permissão chama esta função quando a permissão CONFERE: a recusa guardada vale ali. Sem ela
 * a rota seguiria com um anexo de arquivo que a pessoa não pode usar (a regra do Marco 9 é recusar sempre). Também vale na primeira
 * transação da empresa (tenant.middleware, withTenantTransaction). O teste test/fileAttachGuard.adiado.test.js confere que todo
 * middleware de permissão (os que marcam `requiredPermission`) passa por aqui.
 */
function nextWithDeferredFileAttach(req, next) {
  if (req.deferredFileAttachError) return next(req.deferredFileAttachError);
  return next();
}

module.exports = { nextWithDeferredFileAttach };
