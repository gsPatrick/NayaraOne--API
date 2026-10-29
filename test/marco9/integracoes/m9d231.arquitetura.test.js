'use strict';

// Marco 9, M9-D231 — adapter_nao_le_tabela_de_imoveis: nada em integrations/ lê tabela de imóveis; só o read model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../../../src');
const INTEGRATIONS = path.join(SRC, 'features/integrations');

const arquivos = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return arquivos(p);
  return e.name.endsWith('.js') ? [p] : [];
});
const sem = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('adapter_nao_le_tabela_de_imoveis', () => {
  const NOMES = '(Property|PropertyAddress|PropertyOffer|PropertyMedia|PropertyDocument|PropertyOwner|PropertyInternalOccurrence|PropertyPriceHistory)';
  // Importar o modelo (desestruturando de models) ou usar db.<Modelo>; o texto 'Property' em aggregateType não conta.
  const MODELOS = new RegExp(`\\{[^}]*\\b${NOMES}\\b[^}]*\\}\\s*=\\s*require\\([^)]*models|\\bdb\\.${NOMES}\\b`);
  const TABELAS = /\breal_estate\b|\bproperty_(media|documents|offers|addresses|owners|internal_occurrences)\b/;
  const REQUIRE_PROPERTIES = /require\(\s*['"][./]*(?:\.\.\/)+properties\/([^'"]*)['"]\s*\)/g;
  const achados = [];
  arquivos(INTEGRATIONS).forEach((arq) => {
    const texto = sem(fs.readFileSync(arq, 'utf8'));
    const rel = path.relative(SRC, arq);
    if (MODELOS.test(texto)) achados.push(`${rel}: usa modelo de imóvel`);
    if (TABELAS.test(texto)) achados.push(`${rel}: cita tabela de imóveis`);
    for (const m of texto.matchAll(REQUIRE_PROPERTIES)) {
      if (m[1] !== 'publicReadModel') achados.push(`${rel}: importa properties/${m[1]} (só o read model é permitido)`);
    }
  });
  assert.deepEqual(achados, []);
  // Autoverificação: a varredura pega o que deve pegar (um adapter que importasse o modelo ou a tabela seria reprovado).
  assert.ok(MODELOS.test("const { PropertyOffer, Other } = require('../../../models');"));
  assert.ok(MODELOS.test('db.Property.findAll()'));
  assert.ok(TABELAS.test('SELECT * FROM real_estate.properties'));
  assert.ok([...("const x = require('../../properties/properties.service');").matchAll(REQUIRE_PROPERTIES)].length === 1);
  assert.ok(!MODELOS.test("aggregateType: 'Property'"));
});

test('read_model_unica_fonte_de_publicacao', () => {
  // Quem monta o objeto de domínio de publicação lê o read model; nenhum outro arquivo de integrations/ conhece o imóvel.
  const usa = arquivos(INTEGRATIONS).filter((a) => /publicReadModel/.test(fs.readFileSync(a, 'utf8')));
  assert.deepEqual(usa.map((a) => path.relative(INTEGRATIONS, a)), ['publication/publication.dispatch.js']);
});

test('read_model_so_o_projetor_le_as_tabelas_de_origem', () => {
  const dir = path.join(SRC, 'features/properties/publicReadModel');
  const leem = arquivos(dir).filter((a) => /require\([^)]*models['"]\)/.test(fs.readFileSync(a, 'utf8'))).map((a) => path.basename(a)).sort();
  assert.deepEqual(leem, ['readModel.read.js', 'readModel.sync.js', 'source.load.js']);
  const leitura = fs.readFileSync(path.join(dir, 'readModel.read.js'), 'utf8');
  assert.ok(!/real_estate"?\."?properties"?\b|PropertyOffer|PropertyMedia/.test(leitura), 'a leitura pública não toca as tabelas de origem');
});
