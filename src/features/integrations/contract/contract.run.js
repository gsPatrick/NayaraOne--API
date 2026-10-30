'use strict';

const crypto = require('node:crypto');
const { loadFixture, fixturesDigestInput } = require('./contract.fixtures');
const { buildContext } = require('./contract.runtime');
const transport = require('./contract.scenarios.transport');
const data = require('./contract.scenarios.data');
const { loadDouble } = require('./doubles');

const SCENARIOS = Object.freeze([
  [1, 'auth', transport.auth], [2, 'happy path', transport.happyPath], [3, 'timeout', transport.timeout], [4, '4xx', transport.client4xx], [5, '5xx', transport.server5xx],
  [6, 'rate limit', transport.rateLimit], [7, 'duplicate request', data.duplicate], [8, 'malformed response', data.malformed], [9, 'status mapping', data.statusMapping], [10, 'health check', data.health],
]);

/** Prazos dos cenários de laboratório: a política é simulada e curta para a suíte não esperar de verdade (a fixture pode trocar `timeoutMs`). */
const DEFAULT_TIMEOUT_MS = 40;
const HEALTH_LIMIT_MS = 5000;

/** Hash do adapter (M9-D222 3.2 item 4): código da classe e das classes-base até o port, mais as fixtures de todas as versões. Mudou o adapter ou a fixture: o relatório antigo não vale. */
function hashAdapter(AdapterClass, providerCode, versions) {
  const partes = [];
  for (let C = AdapterClass; C && C !== Function.prototype && !Object.prototype.hasOwnProperty.call(C, 'operations'); C = Object.getPrototypeOf(C)) partes.push(C.toString());
  partes.push(fixturesDigestInput(providerCode, versions));
  return crypto.createHash('sha256').update(partes.join('\n--\n')).digest('hex');
}

/** Roda os 10 cenários, para cada versão suportada, sobre todas as capabilities. Devolve o relatório (sem escrever arquivo). */
async function runSuite(target, { timeoutMs } = {}) {
  const adapterBase = new target.AdapterClass(null);
  const versions = adapterBase.supportedVersions();
  const capabilities = adapterBase.capabilities();
  const resultados = [];
  const errors = [];
  for (const version of versions) {
    const fixture = loadFixture(target.providerCode, version);
    if (!fixture) { errors.push({ code: 'CONTRACT_FIXTURE_MISSING', version, message: `Falta a fixture da versão ${version} do fornecedor.` }); continue; }
    const semCenario = capabilities.filter((c) => !fixture.requests || !fixture.requests[c]);
    semCenario.forEach((capability) => errors.push({ code: 'CONTRACT_CAPABILITY_UNCOVERED', version, capability, message: 'Capacidade declarada sem teste de contrato.' }));
    const ops = capabilities.filter((c) => !semCenario.includes(c) && typeof adapterBase[c] === 'function');
    capabilities.filter((c) => typeof adapterBase[c] !== 'function').forEach((capability) => errors.push({ code: 'CONTRACT_CAPABILITY_NOT_IMPLEMENTED', version, capability, message: 'Capacidade declarada sem operação implementada no adapter.' }));
    const prazo = timeoutMs || fixture.timeoutMs || DEFAULT_TIMEOUT_MS;
    const dub = loadDouble(fixture.legacyDouble);
    const desfazer = dub && dub.setup ? dub.setup() : null;
    try {
      const extra = (dub && dub.context) || {};
      const adapter = new target.AdapterClass(buildContext({ providerCode: target.providerCode, version, timeoutMs: prazo, healthTimeoutMs: HEALTH_LIMIT_MS, config: extra.config, secret: extra.secret, http: extra.http }));
      if (dub && dub.legacy) adapter.legacyInstance = dub.legacy;
      const state = {};
      for (const [, , fn] of SCENARIOS) {
        const lista = await fn({ adapter, fixture, ops, state, timeoutMs: prazo, healthTimeoutMs: HEALTH_LIMIT_MS });
        resultados.push(...lista.map((r) => ({ ...r, version })));
      }
    } finally {
      if (desfazer) desfazer();
    }
  }
  const scenarios = SCENARIOS.map(([id, name]) => {
    const linhas = resultados.filter((r) => r.scenario === id);
    return { id, name, executions: linhas.length, passed: linhas.filter((r) => r.ok).length, failures: linhas.filter((r) => !r.ok).map((r) => ({ capability: r.capability, version: r.version, detail: r.detail })) };
  });
  const executions = resultados.length;
  const passed = resultados.filter((r) => r.ok).length;
  const status = errors.length === 0 && executions > 0 && passed === executions && scenarios.every((s) => s.executions > 0) ? 'PASSED' : 'FAILED';
  return {
    provider: target.providerCode, domain: target.domain, mode: 'SANDBOX', generatedAt: new Date().toISOString(), apiVersions: versions, capabilities,
    adapterHash: hashAdapter(target.AdapterClass, target.providerCode, versions), scenarios, executions, passed, status, errors,
  };
}

module.exports = { runSuite, hashAdapter, SCENARIOS };
