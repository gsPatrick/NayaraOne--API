'use strict';

// M9-D843 (reabertura C3) — rota inexistente nos prefixos de governança sai com o 404 ROUTE_NOT_FOUND do catálogo, não como GOV_CODIGO_FORA_DO_PADRAO.
process.env.PORT = process.env.M9D843_ROTA_TEST_PORT || '21846';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/m9d843Env');
const { readData } = require('../../../src/features/core-governance/api-governance/standards/errorCatalog.data');
const errors = require('../../../src/features/core-governance/governance.errors');

let http;
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);

before(async () => {
  if (!env.DISPOSABLE) return;
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'] } });
});
after(async () => { await stopHttp({}); });

test('m9d843 ROUTE_NOT_FOUND é exceção padrão ao prefixo GOV_ e consta no catálogo com 404', () => {
  assert.ok(errors.DEFAULT_PREFIX_EXCEPTIONS.includes('ROUTE_NOT_FOUND'));
  assert.equal(errors.enforceErrorCode({ code: 'ROUTE_NOT_FOUND' }, errors.DEFAULT_PREFIX_EXCEPTIONS).code, 'ROUTE_NOT_FOUND');
  const entry = readData().codes.ROUTE_NOT_FOUND;
  assert.equal(entry.status, 404);
  assert.deepEqual(errors.parseExceptions(undefined), errors.DEFAULT_PREFIX_EXCEPTIONS);
});

test('m9d843 rota inexistente em /bcp, /calendar e /dlp devolve 404 ROUTE_NOT_FOUND com traceId', { skip: skip() }, async () => {
  const catalogo = readData().codes.ROUTE_NOT_FOUND;
  for (const prefix of ['/bcp', '/calendar', '/dlp']) {
    const res = await http.call('gestorA', 'GET', `${prefix}/rota-que-nao-existe-m9d843`);
    assert.equal(res.status, catalogo.status, `${prefix}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error.code, 'ROUTE_NOT_FOUND', prefix);
    assert.equal(res.body.error.details && res.body.error.details.codigoOriginal, undefined, prefix);
    assert.equal(res.body.error.traceId, res.headers.get('x-correlation-id'), prefix);
    assert.equal(res.body.traceId, undefined);
  }
});
