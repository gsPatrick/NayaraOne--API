'use strict';

// M9-D700 — API pública da segurança do BI (permissões, ABAC, mascaramento, log de acesso, escopo e chave de cache).
module.exports = {
  ...require('./permissionCatalog'),
  ...require('./permissionGuard'),
  ...require('./abac'),
  ...require('./masking'),
  ...require('./accessLog'),
  ...require('./scope'),
  ...require('./cacheKey'),
  ...require('./secureOutput'),
  ...require('./security.settings'),
  ...require('./securityParams'),
  ...require('./accessLog.routes'),
};
