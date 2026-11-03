'use strict';

// M9-D940, decisão do Patrick de 03/11/2026 (DI-D940-6): o ensaio DRY3 com dados reais da cliente fica no Marco 10. O item sai ADIADO_MARCO_10 (visível, contado à parte) SOMENTE com o
// registro da decisão E o ensaio descartável verde; sem registro, com descartável vermelho ou com relatório real reprovado, falha. Relatório real válido continua mandando.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DISPOSABLE, SKIP_DISPOSABLE } = require('../../m9d801.helpers');
const kit = require('../_helpers/m9d940Fixtures');

const DRY3 = ['--itens', 'dry3'];

test('m9d940 adiado: sem o registro da decisão o item DRY3 falha como antes', () => {
  const amb = kit.adiar(kit.ambiente(), { registro: false });
  const r = kit.fechar(amb, DRY3);
  assert.equal(r.status, 1, r.out);
  assert.match(kit.linha(r, 'DRY3'), /^FALHA Migração v2 DRY3: .*sem registro da decisão do Patrick \(DI-D940-6/);
  assert.doesNotMatch(r.out, /ADIADO_MARCO_10 Migração/);
  // registro com outra frase também não vale
  const outra = kit.adiar(kit.ambiente(), { registro: false });
  fs.appendFileSync(outra.cfg.dry3.adiamento.arquivo_decisoes, '- DI-D940-6 | D940 | DRY3 real | adiado sem dizer o quê\n');
  assert.equal(kit.fechar(outra, DRY3).status, 1);
  // sem arquivo de decisões e sem declaração de CI sem pastas irmãs: falha, nunca adiado
  const sem = kit.adiar(kit.ambiente(), { decisoes: false });
  const rs = kit.fechar(sem, DRY3);
  assert.equal(rs.status, 1, rs.out);
  assert.match(kit.linha(rs, 'DRY3'), /^FALHA .*registro da decisão não foi encontrado/);
});

test('m9d940 adiado: com registro e ensaio descartável verde o item sai ADIADO_MARCO_10, visível', () => {
  const amb = kit.adiar(kit.ambiente());
  const r = kit.fechar(amb, DRY3);
  assert.equal(r.status, 0, r.out);
  assert.match(kit.linha(r, 'DRY3'), /^ADIADO_MARCO_10 Migração v2 DRY3: ADIADO_MARCO_10: ensaio com dados reais da cliente fica no Marco 10 \(decisão do Patrick de 03\/11\/2026, DI-D940-6\); NAO foi conferido relatório real/);
  assert.doesNotMatch(kit.linha(r, 'DRY3'), /^OK /);
});

test('m9d940 adiado: ensaio descartável vermelho falha mesmo com o registro', () => {
  const amb = kit.adiar(kit.ambiente(), { verde: false });
  const r = kit.fechar(amb, DRY3);
  assert.equal(r.status, 1, r.out);
  assert.match(kit.linha(r, 'DRY3'), /^FALHA Migração v2 DRY3: .*o ensaio descartável não passou/);
});

test('m9d940 adiado: relatório real reprovado falha e relatório real válido segue exigido (o registro não o dispensa)', () => {
  const amb = kit.adiar(kit.ambiente());
  kit.escrever(amb.cfg.dry3.arquivo, kit.relatorioDry3({ conclusion: 'REPROVADO' }, { blockers_zero: { ok: false, count: 1 } }));
  const r = kit.fechar(amb, DRY3);
  assert.equal(r.status, 1, r.out);
  assert.match(kit.linha(r, 'DRY3'), /^FALHA Migração v2 DRY3: .*conclusão REPROVADO/);
  assert.doesNotMatch(r.out, /ADIADO_MARCO_10/);
  kit.escrever(amb.cfg.dry3.arquivo, kit.relatorioDry3());
  const ok = kit.fechar(amb, DRY3);
  assert.equal(ok.status, 0, ok.out);
  assert.match(kit.linha(ok, 'DRY3'), /^OK Migração v2 DRY3: ensaio rel-m9d940 APROVADO/);
});

test('m9d940 adiado: CI sem a pasta Maturacao diz NAO_APLICAVEL_NO_CI e nunca OK (DRY3 e manifest)', () => {
  const amb = kit.adiar(kit.ambiente(), { decisoes: false });
  amb.cfg.manifest.script = path.join(amb.dir, 'nao-existe', 'verificar-manifest.js');
  amb.salvar();
  const r = kit.fechar(amb, ['--itens', 'dry3,manifest'], { CI_SEM_REPOS_IRMAOS: '1' });
  assert.equal(r.status, 0, r.out);
  assert.match(kit.linha(r, 'DRY3'), /^NAO_APLICAVEL_NO_CI Migração v2 DRY3: NAO_APLICAVEL_NO_CI: .*CI_SEM_REPOS_IRMAOS=1/);
  assert.match(kit.linha(r, 'manifest'), /^NAO_APLICAVEL_NO_CI manifest documental: NAO_APLICAVEL_NO_CI: .*NAO foi conferido/);
  // sem a declaração, o manifest ausente segue sendo erro (nunca passa)
  assert.notEqual(kit.fechar(amb, ['--itens', 'manifest'], { CI_SEM_REPOS_IRMAOS: '' }).status, 0);
  // e o descartável vermelho vence a declaração
  const vermelho = kit.adiar(kit.ambiente(), { decisoes: false, verde: false });
  assert.equal(kit.fechar(vermelho, DRY3, { CI_SEM_REPOS_IRMAOS: '1' }).status, 1);
});

test('m9d940 adiado: o fechamento completo registra o adiado à parte, nunca como VERDE puro', { skip: DISPOSABLE ? false : SKIP_DISPOSABLE }, () => {
  const amb = kit.adiar(kit.ambiente());
  const r = kit.fechar(amb);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /Fechamento do bloco F: VERDE_COM_ADIADO_MARCO_10/);
  assert.match(r.stdout, /Contagem: OK=5 ADIADO_MARCO_10=1 NAO_APLICAVEL_NO_CI=0 reprovados=0 erros_de_leitura=0/);
  const registro = JSON.parse(fs.readFileSync(amb.saida, 'utf8'));
  assert.equal(registro.resultado, 'VERDE_COM_ADIADO_MARCO_10');
  assert.equal(registro.itens.find((i) => i.item === 'Migração v2 DRY3').resultado, 'ADIADO_MARCO_10');
  assert.equal(registro.contagem.ADIADO_MARCO_10, 1);
});

test('m9d940 adiado: teste do livro que mora em repositório irmão ausente sai NAO_APLICAVEL_NO_CI, só com a declaração do CI', () => {
  const amb = kit.ambiente();
  kit.mapaDosNove(amb.dir, { sem: kit.NOMES_DO_LIVRO[8] });
  const caminho = path.join(amb.dir, 'mapa-livro.json');
  const mapa = JSON.parse(fs.readFileSync(caminho, 'utf8'));
  mapa.raizes.push('../irmao-que-nao-existe-d940/test');
  mapa.nomes_no_front = [kit.NOMES_DO_LIVRO[8]];
  fs.writeFileSync(caminho, JSON.stringify(mapa));
  const com = kit.fechar(amb, ['--itens', 'adversarial'], { CI_SEM_REPOS_IRMAOS: '1' });
  assert.equal(com.status, 0, com.out);
  assert.match(kit.linha(com, 'livro do bloco F'), /^NAO_APLICAVEL_NO_CI testes do livro do bloco F: NAO_APLICAVEL_NO_CI: m9d931 .*NAO conferido aqui; os outros 8 de 9/);
  assert.notEqual(kit.fechar(amb, ['--itens', 'adversarial'], { CI_SEM_REPOS_IRMAOS: '' }).status, 0, 'sem a declaração a raiz irmã ausente nunca passa');
});

test('m9d940 adiado: suíte com teste NAO_APLICAVEL_NO_CI vira o item NAO_APLICAVEL_NO_CI só com a declaração; pulo comum segue reprovando', { skip: DISPOSABLE ? false : SKIP_DISPOSABLE }, () => {
  const amb = kit.ambiente();
  amb.cfg.dlp.suites = [kit.suiteMinima(amb.dir, 'irmao.suite.test.js', "test('lê o irmão', { skip: 'NAO_APLICAVEL_NO_CI: Maturacao/x ausente no CI' }, () => {});\ntest('roda', () => {});")];
  amb.salvar();
  const com = kit.fechar(amb, ['--itens', 'dlp'], { CI_SEM_REPOS_IRMAOS: '1' });
  assert.equal(com.status, 0, com.out);
  assert.match(kit.linha(com, 'DLP'), /^NAO_APLICAVEL_NO_CI DLP: NAO_APLICAVEL_NO_CI em 1 teste\(s\)/);
  const sem = kit.fechar(amb, ['--itens', 'dlp'], { CI_SEM_REPOS_IRMAOS: '' });
  assert.equal(sem.status, 1, sem.out);
  assert.match(kit.linha(sem, 'DLP'), /^FALHA DLP: suíte: 1 teste\(s\) pulado\(s\)/);
});
