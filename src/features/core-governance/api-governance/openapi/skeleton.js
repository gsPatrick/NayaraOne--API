'use strict';

const yaml = require('js-yaml');
const { normalizePath, inScope } = require('./scope');

/**
 * Esqueleto de operação gerado das rotas REAIS do escopo (M9-D840 §3.1: "gerado/validado a partir das rotas reais"). Cada operação ganha parâmetros de caminho, segurança (pública quando não
 * há permissão), os envelopes padrão de sucesso e erro e os códigos de erro comuns. O contrato versionado é o arquivo YAML; este gerador só acrescenta o que falta.
 */
const ERROR_ENVELOPE = { $ref: '#/components/schemas/ErrorEnvelope' };
const jsonBody = (schema) => ({ content: { 'application/json': { schema } } });
const operationId = (method, path) => `${method.toLowerCase()}${path.split('/').filter(Boolean).map((part) => part.replace(/[{}]/g, '').replace(/(^|[-_])(\w)/g, (_m, _s, ch) => ch.toUpperCase())).map((part) => part[0].toUpperCase() + part.slice(1)).join('')}`;

function operationFor(route) {
  const params = [...route.path.matchAll(/\{([^}]+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
  const op = {
    operationId: operationId(route.method, route.path),
    summary: `${route.method} ${route.path}`,
    ...(params.length ? { parameters: params } : {}),
    ...(route.permissions.length ? {} : { security: [] }),
    responses: {
      200: { description: 'Sucesso.', ...jsonBody({ $ref: '#/components/schemas/SuccessEnvelope' }) },
      400: { description: 'Requisição inválida.', ...jsonBody(ERROR_ENVELOPE) },
      429: { description: 'Limite de requisições excedido.', 'x-error-code': 'GOV_RATE_LIMITED', ...jsonBody(ERROR_ENVELOPE) },
    },
  };
  if (route.permissions.length) {
    op.responses[401] = { description: 'Sem login.', 'x-error-code': 'MISSING_ACCESS_TOKEN', ...jsonBody(ERROR_ENVELOPE) };
    op.responses[403] = { description: 'Sem permissão.', 'x-error-code': 'PERMISSION_DENIED', ...jsonBody(ERROR_ENVELOPE) };
    op['x-permissions'] = route.permissions;
  }
  if (['POST', 'PUT', 'PATCH'].includes(route.method)) op.requestBody = { required: false, ...jsonBody({ type: 'object', additionalProperties: true }) };
  return op;
}

/** Documento base: componentes comuns, segurança Bearer e as operações do escopo. `routes` = [{method, path, permissions}] com caminhos Express. */
function buildSkeleton(routes, scopeEntries, { version = '1.0.0' } = {}) {
  const paths = {};
  for (const route of routes) {
    const path = normalizePath(route.path) && route.path.replace(/^\/api\/v\d+/, '').replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    if (!inScope(scopeEntries, route.method, route.path)) continue;
    paths[path] = paths[path] || {};
    paths[path][route.method.toLowerCase()] = operationFor({ ...route, path });
  }
  return {
    openapi: '3.0.3',
    info: { title: 'Nayara One API', version, description: 'Contrato público e de integração da API do Nayara One (M9-D840). Versionado: sem breaking change dentro da mesma major.' },
    servers: [{ url: '/api/v1' }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        SuccessEnvelope: { type: 'object', required: ['success'], properties: { success: { type: 'boolean' }, data: { nullable: true }, pagination: { $ref: '#/components/schemas/Pagination' } } },
        Pagination: { type: 'object', required: ['page', 'pageSize', 'total', 'totalPages'], properties: { page: { type: 'integer' }, pageSize: { type: 'integer' }, total: { type: 'integer' }, totalPages: { type: 'integer' } } },
        ErrorEnvelope: { type: 'object', required: ['success', 'error'], properties: { success: { type: 'boolean' }, error: { type: 'object', required: ['code', 'message', 'traceId'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: { nullable: true }, traceId: { type: 'string' } } } } },
      },
    },
  };
}

const toYaml = (doc) => yaml.dump(doc, { lineWidth: 160, noRefs: true, sortKeys: false });

module.exports = { buildSkeleton, toYaml };
