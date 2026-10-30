'use strict';

// Auxiliar das provas "suíte de contrato da D222" de cada demanda de adapter: fixtures por versão, 10 cenários verdes, relatório gravado e prefixo fora das pendências.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerBuiltInAdapters } = require('../../../src/features/integrations/adapters');
const contract = require('../../../src/features/integrations/contract');

const RAIZ = path.join(__dirname, '..', '..', '..');
const FIXTURES = path.join(RAIZ, 'src/features/integrations/contract/fixtures');

/** Roda a suíte de contrato dos adapters pedidos num diretório de relatórios temporário e confere o que a D222 exige de cada um. */
async function provarContrato(providers, prefixosFora) {
  registerBuiltInAdapters();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m9-contrato-demanda-'));
  process.env.INTEGRATION_CONTRACT_REPORT_DIR = tmp;
  try {
    const alvos = contract.listTargets();
    for (const providerCode of providers) {
      const versoes = fs.readdirSync(path.join(FIXTURES, providerCode)).filter((f) => f.endsWith('.json'));
      assert.ok(versoes.length > 0, `${providerCode}: falta a fixture por versão`);
      const alvo = alvos.find((a) => a.providerCode === providerCode);
      assert.ok(alvo, `${providerCode}: a suíte de contrato não o cobre (fixture ou registro ausente)`);
      const rel = await contract.runSuite(alvo);
      contract.writeReport(rel);
      assert.equal(rel.status, 'PASSED', `${providerCode}: ${JSON.stringify(rel.errors)} ${JSON.stringify(rel.scenarios.flatMap((s) => s.failures).slice(0, 3))}`);
      assert.equal(rel.scenarios.length, 10);
      assert.ok(rel.scenarios.every((s) => s.executions > 0 && s.passed === s.executions), `${providerCode}: os 10 cenários precisam rodar e passar`);
      assert.deepEqual(rel.errors, []);
      assert.equal(contract.readReport(providerCode).status, 'PASSED');
    }
  } finally {
    delete process.env.INTEGRATION_CONTRACT_REPORT_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  for (const prefixo of prefixosFora) {
    assert.equal(Object.keys(contract.PENDING_BY_DEMAND).includes(prefixo), false, `${prefixo} ainda consta em PENDING_BY_DEMAND`);
  }
  const { pending, uncovered } = contract.coverage();
  for (const prefixo of prefixosFora) assert.deepEqual(pending.filter((p) => p.providerCode.startsWith(prefixo)), [], `${prefixo}: adapter ainda pendente de suíte`);
  assert.deepEqual(uncovered.filter((c) => prefixosFora.some((p) => c.startsWith(p))), []);
}

module.exports = { provarContrato };
