'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Fixtures dos contract tests (M9-D222 3.2 item 2): uma pasta por adapter e um arquivo por versão da API (`fixtures/<provider>/<versão>.json`). Cada arquivo traz um pedido
 * válido por capability, os status documentados do fornecedor e o que mudou naquela versão. Mudou a versão do fornecedor: atualiza o arquivo e a suíte revalida os 10 cenários.
 * Sem dado real nem segredo (a varredura da M9-D246 confere). `CONTRACT_FIXTURES_DIR` troca a pasta (testes).
 */
const dirOf = () => process.env.CONTRACT_FIXTURES_DIR || path.join(__dirname, 'fixtures');

function loadFixture(providerCode, version) {
  const arquivo = path.join(dirOf(), String(providerCode), `${String(version)}.json`);
  if (!fs.existsSync(arquivo)) return null;
  return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
}

/** Provedores que têm pasta de fixtures. */
function listFixtureProviders() {
  const dir = dirOf();
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory()).sort() : [];
}

/** Texto de todas as versões do adapter (entra no hash do relatório: fixture alterada invalida o relatório). */
function fixturesDigestInput(providerCode, versions) {
  return versions.map((v) => JSON.stringify(loadFixture(providerCode, v))).join('\n');
}

module.exports = { loadFixture, listFixtureProviders, fixturesDigestInput };
