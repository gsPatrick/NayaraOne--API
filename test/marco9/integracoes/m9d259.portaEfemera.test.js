'use strict';

// R3-L4: nenhum teste de integrações fixa porta TCP. A porta vem do SO (portaLivre) ou de listen(0).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RAIZES = [path.join(__dirname), path.join(__dirname, '..', '..', 'integrations'), path.join(__dirname, '..', '..', 'helpers')];

function arquivosDeTeste(dir) {
  const achados = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) achados.push(...arquivosDeTeste(p));
    else if (e.name.endsWith('.test.js')) achados.push(p);
  }
  return achados;
}

const FIXA = /(?:(?:PORT\s*=|startHttpEnv\()[^\n]*(?:\|\||,)\s*(?:Number\()?['"]?\d{4,5}['"]?\)?|\bPORT\s*:\s*['"]?\d{4,5}\b)/;

test('site_testes_de_integracoes_nao_fixam_porta_tcp', () => {
  const culpados = [];
  for (const raiz of RAIZES) {
    for (const arq of arquivosDeTeste(raiz)) {
      if (arq === __filename) continue;
      const linhas = fs.readFileSync(arq, 'utf8').split('\n');
      linhas.forEach((l, i) => { if (FIXA.test(l)) culpados.push(`${path.relative(process.cwd(), arq)}:${i + 1}`); });
    }
  }
  assert.deepEqual(culpados, [], `Porta fixa em teste (use portaLivre): ${culpados.join(', ')}`);
});

test('site_o_detector_de_porta_fixa_reconhece_os_padroes_antigos', () => {
  assert.ok(FIXA.test("process.env.PORT = process.env.X || '21259';"));
  assert.ok(FIXA.test('env = await startHttpEnv(Number(process.env.X) || 21723, [[]]);'));
  assert.ok(FIXA.test("env: { NODE_ENV: 'test', PORT: '21299' }"));
  assert.ok(!FIXA.test("process.env.PORT = process.env.X || require('../_helpers/portaLivre').portaLivre();"));
});
