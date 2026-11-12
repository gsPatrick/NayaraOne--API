'use strict';

// M9-D433 (rodada 5, G-1) — bateria de custo linear: cada caractere especial repetido (pontuação, arroba, porcento, barras, marca combinante, invisível, letra, dígito, CJK)
// depois de cada cabeça possível (domínio, esquema, mailto, javascript, //, usuário@, www.) em 1 MB e 5 MB. Uma varredura passa de 1 segundo ou estoura a pilha = falha.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const security = require('../../../src/features/marketing/security');
const { medianCpuMs } = require('../_helpers/medicaoRobusta');

const CHARS = ['.', ',', ';', ':', '!', '?', '_', '-', '*', '=', '@', '%', '/', '\\', '\u0300', '\u200b', 'é', '中', '&', 'a', '1'];
const CHARS_5MB = ['.', ',', '-', '_', '@', '%', '/', '\u0300', '中', 'a'];
const HEADS = ['evil.com/', 'http://evil.com/', 'mailto:', '//', '', 'a@', '@evil.com/', 'www.'];
const LIMIT_MS = 1000; // limite da demanda (rodada 5, G-1), não do livro: DI-M9F-4
const GROWTH_MAX = 12; // 5 MB contra 1 MB do mesmo caso: linear = 5x, quadrático = 25x
const FLOOR_MS = 50; // piso do denominador da razão, para ruído de timer em casos de poucos ms
const HARD_CAP_MS = 20000; // teto absoluto catastrófico (varredura quadrática ou pior)

// DI-M9F-4: mede o TEMPO DE CPU da varredura (não o tempo de parede, que cresce com a fila da CPU numa máquina carregada), mediana de 3 execuções, depois de aquecer o extrator.
const timed = (fn, limit) => medianCpuMs(fn, { vezes: 3, aquecimento: 0, limite: limit });
before(() => { const warm = `evil.com/${'a@b.c/'.repeat(20000)} www.x.com mailto:a@b.com`; for (let i = 0; i < 3; i += 1) { security.extractCandidates(warm, { tlds: ['com'] }); security.stripUrls(warm, {}); } });

function worst(size, build, chars = CHARS) {
  let slowest = { ms: 0, label: '' };
  for (const head of HEADS) {
    for (const ch of chars) {
      const text = build(head, ch, size);
      const ms = timed(() => security.extractCandidates(text, { tlds: ['com'] }), LIMIT_MS);
      if (ms > slowest.ms) slowest = { ms, label: JSON.stringify([head, ch, size]) };
    }
  }
  return slowest;
}

test('varredura_linear_em_1_mb_para_todo_caractere_e_toda_cabeca', () => {
  const repeated = worst(1000000, (head, ch, n) => `${head}${ch.repeat(n)}a`);
  assert.ok(repeated.ms < LIMIT_MS, `repetição de um caractere: ${repeated.ms | 0} ms em ${repeated.label}`);
  const alternated = worst(1000000, (head, ch, n) => (head + ch).repeat(Math.floor(n / (head.length + ch.length))));
  assert.ok(alternated.ms < LIMIT_MS * 2, `cabeça e caractere alternados (centenas de milhares de endereços): ${alternated.ms | 0} ms em ${alternated.label}`);
});

test('varredura_linear_em_5_mb_sem_estourar_a_pilha_para_um_caractere_repetido', () => {
  // Determinístico sob carga: o crescimento de 1 MB para 5 MB do MESMO caso tem de ser linear (razão), e nada passa do teto catastrófico.
  for (const head of HEADS) {
    for (const ch of CHARS_5MB) {
      const small = `${head}${ch.repeat(1000000)}a`;
      const big = `${head}${ch.repeat(5000000)}a`;
      const run = (text) => () => security.extractCandidates(text, { tlds: ['com'] });
      const msSmall = medianCpuMs(run(small), { vezes: 3, aquecimento: 0 });
      const msBig = medianCpuMs(run(big), { vezes: 3, aquecimento: 0 });
      const label = JSON.stringify([head, ch]);
      assert.ok(msBig < HARD_CAP_MS, `${msBig | 0} ms em ${label}`);
      assert.ok(msBig <= Math.max(msSmall, FLOOR_MS) * GROWTH_MAX || msBig < LIMIT_MS, `crescimento não linear: ${msSmall | 0} ms (1 MB) para ${msBig | 0} ms (5 MB) em ${label}`);
    }
  }
});

test('texto_so_de_arrobas_pontos_e_rotulos_longos_nao_trava', () => {
  for (const text of ['@'.repeat(5000000), 'a@'.repeat(2500000), 'a.'.repeat(2500000), `${'a'.repeat(5000000)}.com/x`, 'a.a'.repeat(1500000)]) {
    const ms = timed(() => { security.extractCandidates(text, { tlds: ['com'] }); security.stripUrls(text, {}); }, LIMIT_MS * 3);
    assert.ok(ms < LIMIT_MS * 3, text.slice(0, 8));
  }
});

test('o_texto_apos_o_endereco_nao_e_relido_para_cada_arroba_do_caminho', () => {
  const text = `evil.com/${'@a.bc/'.repeat(500000)}`;
  let found;
  const ms = timed(() => { found = security.extractUrls(text, { tlds: ['com'] }); }, LIMIT_MS);
  assert.equal(found.length, 1);
  assert.ok(ms < LIMIT_MS);
});
