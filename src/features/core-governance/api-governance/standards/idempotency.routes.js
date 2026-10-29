'use strict';

/** Lista FECHADA das rotas que EXIGEM `Idempotency-Key` (M9-D843 §3.3): as que geram efeito caro ou externo. Nas demais criações a chave é opcional. */
const IDEMPOTENCY_REQUIRED_ROUTES = Object.freeze(['POST /exports', 'POST /dlp/share-links', 'POST /bcp/manual-operations/import', 'POST /data-quality/bulk-changes']);

const isRequired = (method, path) => IDEMPOTENCY_REQUIRED_ROUTES.includes(`${String(method).toUpperCase()} ${path}`);

module.exports = { IDEMPOTENCY_REQUIRED_ROUTES, isRequired };
