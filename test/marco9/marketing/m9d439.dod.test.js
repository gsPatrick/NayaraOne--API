'use strict';

// M9-D439 — Definition of Done e estrutura de pastas do Marketing conferidas contra o livro (Caderno §17, Guia §2 e §15). Leitura pura: não toca banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../../../scripts/lib/marketingDod');
const fonte = require('../_helpers/mktSprintsFonte');

const todas = fonte.demandas();
const dodDemanda = () => D.lerDodDemanda(todas.get('M9-D439').texto).map(D.norm);

test('dod_lista_todos_os_itens_do_livro', () => {
  const livro = D.lerDodLivro(fonte.caderno());
  assert.equal(livro.caderno.length, 12, 'Caderno §17 tem 12 itens');
  assert.equal(livro.guia.length, 10, 'Guia §15 tem 10 itens');
  const lista = dodDemanda();
  assert.equal(lista.length, 16);
  assert.equal(new Set(lista).size, 16, 'sem item repetido');
  const faltando = [];
  for (const item of [...livro.caderno, ...livro.guia].map(D.norm)) {
    const coberto = D.EQUIVALENCIA[item];
    if (!coberto) faltando.push(`${item}: sem equivalência declarada`);
    else if (!lista.includes(coberto)) faltando.push(`${item}: a demanda não lista "${coberto}"`);
  }
  assert.deepEqual(faltando, []);
  // e a recíproca: nenhum item da demanda fica sem origem no livro
  const usados = new Set([...livro.caderno, ...livro.guia].map((i) => D.EQUIVALENCIA[D.norm(i)]));
  assert.deepEqual(lista.filter((i) => !usados.has(i)), [], 'item da demanda que o livro não pede');
});

test('dod_com_item_do_livro_removido_da_demanda_reprova', () => {
  const sem = dodDemanda().filter((i) => i !== 'rls/redaction');
  const livro = D.lerDodLivro(fonte.caderno());
  const faltando = [...livro.caderno, ...livro.guia].map(D.norm).filter((i) => !sem.includes(D.EQUIVALENCIA[i]));
  assert.deepEqual(faltando, ['rls/redaction']);
});

test('estrutura_de_pastas_confere_com_o_guia', () => {
  const e = D.lerEstruturaLivro(fonte.caderno());
  assert.equal(e.raizLivro, 'src/modules/marketing');
  assert.equal(e.raiz, 'src/features/marketing', 'decisão do Patrick: tudo do Marco 9 em src/features, nunca src/modules');
  assert.deepEqual(e.pastas, ['content', 'campaigns', 'automations', 'publications', 'tracking', 'suppression']);
  for (const pasta of e.pastas) {
    const dir = path.join(fonte.RAIZ_API, e.raiz, pasta);
    assert.ok(fs.statSync(dir).isDirectory(), `${e.raiz}/${pasta} não existe`);
    const arquivos = fs.readdirSync(dir);
    assert.ok(arquivos.includes('index.js'), `${pasta}: falta index.js`);
    for (const parte of ['service', 'controller', 'routes']) {
      assert.ok(arquivos.some((f) => new RegExp(`(^|\\.)${parte}\\.js$`).test(f) || f.endsWith(`.${parte}.js`)), `${pasta}: falta arquivo ${parte}`);
    }
  }
  // src/modules/legal existe por decisão do Patrick para o Marco 5 (DEC-031, Guia M5 §2); o marketing continua em src/features.
  assert.equal(fs.existsSync(path.join(fonte.RAIZ_API, 'src', 'modules', 'marketing')), false, 'src/modules/marketing não existe');
});

test('estrutura_sem_pasta_do_guia_reprova', () => {
  const e = D.lerEstruturaLivro(fonte.caderno());
  const inventada = [...e.pastas, 'pasta-que-nao-existe'];
  const faltam = inventada.filter((p) => !fs.existsSync(path.join(fonte.RAIZ_API, e.raiz, p)));
  assert.deepEqual(faltam, ['pasta-que-nao-existe']);
});
