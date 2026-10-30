'use strict';

/**
 * Emissor e público do token de acesso do próprio sistema (Marco 9, M9-D242 3.2). O token passa a levar `iss`, `aud` e `nbf` para que o adapter
 * `identity-local` aplique a mesma validação estrita de qualquer provedor externo. Identidade do sistema, não regra de negócio: o ambiente pode trocá-las.
 */
const localIssuer = () => process.env.JWT_ISSUER || 'nayara-one';
const localAudience = () => process.env.JWT_AUDIENCE || 'nayara-one-api';

module.exports = { localIssuer, localAudience };
