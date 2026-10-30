'use strict';

// DI-IA-LEVE-2 — o ai:arch-guard pega import de arquivo interno de src/features/ai feito por quem está fora dela, e os jobs/serviços reais passam pelo barrel.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const guard = () => require('../../../scripts/lib/aiBarrelGuard');

function fixture(arquivos) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'barrel-'));
  const todos = { 'features/ai/index.js': '', 'features/ai/memory/index.js': '', 'features/ai/memory/memory.params.js': '', 'features/ai/ai.settings.js': '', ...arquivos };
  for (const [rel, conteudo] of Object.entries(todos)) {
    fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true });
    fs.writeFileSync(path.join(raiz, rel), conteudo);
  }
  return raiz;
}

test('m9dleve2_guard_reprova_import_de_arquivo_interno_e_aceita_barrel', () => {
  const raiz = fixture({
    'engines/jobs/ruim.js': "const { x } = require('../../features/ai/memory/memory.params');\n",
    'engines/jobs/bom.js': "const { y } = require('../../features/ai/memory');\nconst z = require('../../features/ai');\n",
    'features/settings/schema.js': "const s = require('../ai/ai.settings');\n",
    'engines/jobs/comentado.js': "// require('../../features/ai/memory/memory.params')\n",
  });
  const v = guard().varrerImportsForaDoBarrel(raiz, { legado: {} });
  assert.deepEqual(v.map((x) => x.arquivo.split(path.sep).join('/')), ['src/engines/jobs/ruim.js']);
  assert.equal(v[0].regra, 'import-fora-do-barrel');
});

test('m9dleve2_codigo_real_nao_fura_o_barrel_e_o_legado_nao_cresce', () => {
  const real = guard().varrerImportsForaDoBarrel(SRC, { legado: {} });
  const fora = real.map((x) => x.arquivo.split(path.sep).join('/')).sort();
  assert.deepEqual(fora, [
    'src/features/core-governance/finops/collectors/ai.js', 'src/features/core-governance/finops/collectors/ai.js', 'src/features/integrations/adapters/index.js',
  ], 'apenas a dívida antiga e congelada; qualquer outro import fora do barrel reprova');
  assert.deepEqual(guard().varrerImportsForaDoBarrel(SRC), []);
});

test('m9dleve2_script_do_guard_inclui_a_nova_varredura', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'ai-arch-guard.js'), 'utf8'), /varrerImportsForaDoBarrel/);
});
