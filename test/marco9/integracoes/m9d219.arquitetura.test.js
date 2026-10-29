'use strict';

// Marco 9, M9-D219 — nenhum DTO interno completo chega a provider: arquitetura (teste 5).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../../../src');
const FEATURE = path.join(SRC, 'features/integrations');

function arquivos(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return arquivos(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

const sem = (texto) => texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
// Cópia do objeto inteiro: stringify, toJSON, dataValues, get({plain}) e espalhamento de entidade.
const PROIBIDOS = [/JSON\.stringify\(/, /\.toJSON\(/, /\.dataValues\b/, /\.get\(\s*\{\s*plain/, /\bObject\.assign\(\s*\{\s*\}\s*,\s*(entity|property|dto)\b/, /\.\.\.\s*(entity|property|dto)\b/];

test('minimizacao_proibe_stringify_de_entidade', () => {
  const alvos = [
    ...arquivos(path.join(FEATURE, 'providers')),
    ...arquivos(path.join(FEATURE, 'minimization')),
    ...arquivos(path.join(FEATURE, 'adapters')),
  ];
  assert.ok(alvos.length > 20);
  const achados = [];
  alvos.forEach((arq) => {
    const texto = sem(fs.readFileSync(arq, 'utf8'));
    PROIBIDOS.forEach((re) => { if (re.test(texto)) achados.push(`${path.relative(SRC, arq)} :: ${re}`); });
  });
  // Exceção justificada: o seed do catálogo grava as capabilities dos fornecedores (lista de textos), não payload de provider.
  const permitidos = ['providers/catalog.seed.js'];
  assert.deepEqual(achados.filter((a) => !permitidos.some((p) => a.includes(p))), []);
});

test('minimizacao_todo_mapper_e_allowlist_com_classificacao', () => {
  const { PORTS } = require('../../../src/features/integrations/providers/ports');
  const { INTEGRATION_SCALE } = require('../../../src/features/integrations/minimization');
  let total = 0;
  Object.values(PORTS).forEach((Port) => Object.values(Port.operations).forEach((op) => {
    if (!op.outputMapper) return;
    total += 1;
    const confere = (campos) => campos.forEach((f) => {
      assert.ok(INTEGRATION_SCALE.includes(f.classification), `${f.name}: classificação declarada`);
      if (f.items) confere(f.items);
      if (f.shape) confere(f.shape);
    });
    confere(op.outputMapper.spec.fields);
  }));
  assert.ok(total >= 15, `os ports declaram mappers (${total})`);
});

test('minimizacao_envio_com_dado_de_dominio_passa_pelo_mapper', () => {
  // Quem grava envio com dado de domínio usa createMinimizedDispatch; createDispatch cru só existe dentro de dispatch/ e minimization/.
  const donos = [path.join(FEATURE, 'dispatch'), path.join(FEATURE, 'minimization')];
  const fora = arquivos(path.join(SRC)).filter((arq) => !donos.some((d) => arq.startsWith(d)) && /\bcreateDispatch\s*\(/.test(sem(fs.readFileSync(arq, 'utf8'))));
  assert.deepEqual(fora.map((a) => path.relative(SRC, a)), []);
});
