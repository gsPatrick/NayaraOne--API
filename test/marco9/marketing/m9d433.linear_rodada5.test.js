'use strict';

// M9-D433 (rodada 5, G-1) — bateria de custo linear: cada caractere especial repetido (pontuação, arroba, porcento, barras, marca combinante, invisível, letra, dígito, CJK)
// depois de cada cabeça possível (domínio, esquema, mailto, javascript, //, usuário@, www.) em 1 MB e 5 MB. Uma varredura passa de 1 segundo ou estoura a pilha = falha.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const security = require('../../../src/features/marketing/security');

const CHARS = ['.', ',', ';', ':', '!', '?', '_', '-', '*', '=', '@', '%', '/', '\\', '\u0300', '\u200b', 'é', '中', '&', 'a', '1'];
const CHARS_5MB = ['.', ',', '-', '_', '@', '%', '/', '\u0300', '中', 'a'];
const HEADS = ['evil.com/', 'http://evil.com/', 'mailto:', '//', '', 'a@', '@evil.com/', 'www.'];
const LIMIT_MS = 1000;

function worst(size, build, chars = CHARS) {
  let slowest = { ms: 0, label: '' };
  for (const head of HEADS) {
    for (const ch of chars) {
      const text = build(head, ch, size);
      const started = process.hrtime.bigint();
      security.extractCandidates(text, { tlds: ['com'] });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
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
  const repeated = worst(5000000, (head, ch, n) => `${head}${ch.repeat(n)}a`, CHARS_5MB);
  assert.ok(repeated.ms < LIMIT_MS, `${repeated.ms | 0} ms em ${repeated.label}`);
});

test('texto_so_de_arrobas_pontos_e_rotulos_longos_nao_trava', () => {
  for (const text of ['@'.repeat(5000000), 'a@'.repeat(2500000), 'a.'.repeat(2500000), `${'a'.repeat(5000000)}.com/x`, 'a.a'.repeat(1500000)]) {
    const started = process.hrtime.bigint();
    security.extractCandidates(text, { tlds: ['com'] });
    security.stripUrls(text, {});
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < LIMIT_MS * 3, text.slice(0, 8));
  }
});

test('o_texto_apos_o_endereco_nao_e_relido_para_cada_arroba_do_caminho', () => {
  const text = `evil.com/${'@a.bc/'.repeat(500000)}`;
  const started = process.hrtime.bigint();
  const found = security.extractUrls(text, { tlds: ['com'] });
  assert.equal(found.length, 1);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < LIMIT_MS);
});
