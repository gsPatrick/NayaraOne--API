'use strict';

// M9-D842 — o contract test de verdade: cada exemplo do contrato (positivo e negativo) é chamado na API real, em banco descartável, e a resposta é conferida contra o OpenAPI
// (status documentado, esquema, cabeçalhos, formato único de erro, código no catálogo). Grava o relatório JSON e JUnit para o CI.
process.env.PORT = process.env.M9D842_HTTP_TEST_PORT || require('../_helpers/portaLivre').portaLivre();

const fs = require('node:fs');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../../../src/features/core-governance/api-governance/contract');
const env = require('../_helpers/m9d842Env');
const { runSeeds } = require('../_helpers/m9d842Seeds');
const { addConfirmation } = require('../_helpers/m9d842Confirm');
const { CONTRACT_SWITCH_PATTERNS } = require('../_helpers/m9d842SeedFlags');
const { purgeKillSwitchResidue } = require('../_helpers/killSwitchResidue');

const doc = env.loadContract(env.CONTRACT_FILE);
const { examples, findings: loadFindings } = api.loadExamples(env.EXAMPLES_DIR);
const codes = api.catalogCodes();
const results = [];
const vars = {};
let ctx;
let started;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);

before(async () => {
  if (!env.DISPOSABLE) return;
  api.assertDisposable(process.env);
  started = await env.startContractApi(doc, process.env.PORT);
  Object.assign(vars, started.vars);
  ctx = {
    baseUrl: started.http.baseUrl, doc, codes, tokens: started.tokens, vars,
    hooks: {
      before: async (example, current) => {
        Object.assign(current, await runSeeds(example, current, { tenants: started.tenants }));
        if (example.clearMfa) await env.revokeMfaFor(example, started.tenants);
        if (example.mfa) await env.grantMfaFor(example, started.tenants);
        await addConfirmation(example, current, { baseUrl: started.http.baseUrl, tokens: started.tokens, tenants: started.tenants }); // M9-D852
      },
    },
  };
});

after(async () => {
  if (!env.DISPOSABLE) return;
  const coverage = api.coverageFindings({ doc, examples, routes: [], scopeJson: null });
  const report = api.buildReport({ results, coverage, commit: process.env.GITHUB_SHA || process.env.EVIDENCE_SHA });
  api.writeReports(report, process.env.CONTRACT_REPORT_DIR || require('node:path').resolve(__dirname, '../../../docs/evidencias/ci'));
  if (started) await started.restore();
  await env.cleanExports().catch(() => {});
  await purgeKillSwitchResidue(CONTRACT_SWITCH_PATTERNS).catch(() => {}); // o probe do contrato só existia neste processo; o switch não pode sobrar
  await env.adminQuery("DELETE FROM core.mfa_credentials WHERE user_id IN (SELECT id FROM core.users WHERE email LIKE 'ci-%@ci.nayaraone.test')").catch(() => {});
  await require('../../../src/models').sequelize.close().catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 300);
});

test('m9d842 os arquivos de exemplo são válidos', () => {
  assert.deepEqual(loadFindings, []);
  assert.ok(examples.length > 0);
});

test('m9d842 cobertura: toda operação do contrato tem exemplo positivo e negativo e nenhuma rota do escopo falta', () => {
  const routes = require('../../../scripts/gerarMatrizPermissoes').gerar().map((route) => ({ method: route.method, path: route.path }));
  const findings = api.coverageFindings({ doc, examples, routes, scopeJson: fs.readFileSync(env.SCOPE_FILE, 'utf8') });
  assert.deepEqual(findings.map((item) => `${item.code} ${item.message}`), []);
});

for (const example of examples) {
  test(`m9d842 contrato ${example.op} ${example.kind}: ${example.name}`, { skip: skip() }, async () => {
    const result = await api.runExample(example, ctx);
    results.push(result);
    assert.deepEqual(result.findings.map((item) => `${item.code} ${item.message} ${JSON.stringify(item.details)}`), []);
  });
}
