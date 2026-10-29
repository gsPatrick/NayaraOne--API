'use strict';

// M9-D690 — todo KPI CRITICAL de M9-D712 tem drill-down habilitado (executa o teste da dona da lista).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env712 = require('../_helpers/m9d712Env');
const ledger = require('../_helpers/m9d615Ledger');
const { proveCriticalDrilldown } = require('../_helpers/m9d712Critical');

let env;
before(async () => { env = { ...(await env712.setup()), created: [] }; });
after(async () => { await ledger.cleanup(env); await env712.teardown(env); });

test('m9d690 todo KPI CRITICAL de M9-D712 tem drill-down habilitado', async () => {
  const { checked } = await proveCriticalDrilldown(env);
  assert.ok(checked.length >= 7);
});
