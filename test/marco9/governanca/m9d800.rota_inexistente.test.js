'use strict';

// M9-D800 (reabertura C3) — rota inexistente sob os prefixos de governança responde 404 ROUTE_NOT_FOUND (código padrão da
// plataforma, na lista de exceções ao prefixo GOV_), nunca GOV_CODIGO_FORA_DO_PADRAO. Banco descartável (withDisposableDb.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  setupEnv, teardownEnv, call,
} = require('../../helpers/m9d800Env');
const { DEFAULT_PREFIX_EXCEPTIONS, parseExceptions, enforceErrorCode } = require('../../../src/features/core-governance/governance.errors');
const { GOVERNANCE_SETTING_DEFAULTS, ERRORS_EXCEPTIONS_KEY } = require('../../../src/features/core-governance/governance.settings');

let httpSkip;
before(async () => { ({ httpSkip } = await setupEnv()); });
after(async () => { await teardownEnv(); });

test('m9d800 ROUTE_NOT_FOUND está na lista padrão e no valor inicial do parâmetro', () => {
  assert.ok(DEFAULT_PREFIX_EXCEPTIONS.includes('ROUTE_NOT_FOUND'));
  assert.ok(parseExceptions(GOVERNANCE_SETTING_DEFAULTS[ERRORS_EXCEPTIONS_KEY]).includes('ROUTE_NOT_FOUND'));
  assert.equal(enforceErrorCode({ code: 'ROUTE_NOT_FOUND', message: 'x' }, DEFAULT_PREFIX_EXCEPTIONS).code, 'ROUTE_NOT_FOUND');
});

for (const rota of ['/calendar/items', '/bcp/nao-existe', '/dlp/nao-existe']) {
  test(`m9d800 rota inexistente ${rota} devolve 404 ROUTE_NOT_FOUND`, async (t) => {
    if (httpSkip) return t.skip(httpSkip);
    for (const who of ['A:gestor', null]) {
      const res = await call(who, 'GET', rota);
      if (who === null) {
        // Sem login a rota protegida responde 401 antes de saber que não existe; o contrato é o mesmo formato único.
        assert.ok([401, 404].includes(res.status), String(res.status));
        continue;
      }
      assert.equal(res.status, 404, JSON.stringify(res.body));
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'ROUTE_NOT_FOUND');
      assert.equal(res.body.error.details?.codigoOriginal, undefined);
      assert.equal(res.body.error.traceId, res.correlation);
    }
  });
}
