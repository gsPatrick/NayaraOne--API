'use strict';

// M9-D444 — o portão de sprints está na etapa de CI da M9-D438 e a esteira de 14 estágios cobre o bloco: remover QUALQUER um dos 15 testes adversariais deixa um estágio vermelho
// (TESTE EXIGIDO AUSENTE, antes de qualquer comando), mesmo que nenhum outro teste falhe. Sem banco: usa a definição dos estágios e uma árvore de testes em pasta temporária.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lerEstagios, E } = require('../_helpers/mktEsteira');
const { expandir } = require('../../../scripts/int-ci/lib/estagios');

const RAIZ = E.ROOT;
const ADV = fs.readdirSync(path.join(RAIZ, 'test/marco9/marketing/adversarial')).filter((f) => /^adv_\d\d_.*\.test\.js$/.test(f)).sort();
const comando = (e) => e.comandos.filter(Array.isArray).map((c) => c.join(' '));

test('portao_de_sprints_esta_na_etapa_de_ci_do_marketing', () => {
  const lint = lerEstagios().find((e) => e.numero === 1);
  assert.ok(comando(lint).includes('node scripts/marketing/checkSprintGates.js --demandas-opcional'), 'o estágio 1 roda o portão de sprints');
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['guard:marketing-sprints'], 'node scripts/marketing/checkSprintGates.js');
  assert.deepEqual(E.problemasDaDefinicao(lerEstagios()), [], 'a definição continua com os 14 estágios do livro');
});

test('os_15_testes_adversariais_estao_nos_estagios_e_cada_remocao_deixa_a_esteira_vermelha', () => {
  assert.equal(ADV.length, 15);
  const estagios = lerEstagios();
  const exigidos = estagios.flatMap((e) => (e.exigidos || []).map((nome) => ({ numero: e.numero, nome })));
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d444-esteira-'));
  try {
    // árvore de testes do Marketing em pasta temporária (links para os arquivos reais; remover um link remove o teste da suíte)
    const padroes = [...new Set(estagios.flatMap((e) => e.comandos.filter((c) => c && c.testes).flatMap((c) => c.testes)))];
    const arquivos = [...new Set(padroes.flatMap((p) => expandir(p, RAIZ)))];
    for (const f of arquivos) { fs.mkdirSync(path.dirname(path.join(raiz, f)), { recursive: true }); fs.symlinkSync(path.join(RAIZ, f), path.join(raiz, f)); }
    for (const e of estagios) assert.deepEqual(E.testesExigidosAusentes(e, raiz), [], `estágio ${e.numero} verde com a suíte inteira`);
    for (const arq of ADV) {
      const nome = arq.replace(/\.test\.js$/, '');
      const dono = exigidos.find((x) => x.nome === nome);
      assert.ok(dono, `${nome} é exigido por algum estágio`);
      const link = path.join(raiz, 'test/marco9/marketing/adversarial', arq);
      assert.ok(fs.existsSync(link), `${arq} está nos padrões de um estágio`);
      fs.unlinkSync(link);
      const vermelhos = estagios.filter((e) => E.testesExigidosAusentes(e, raiz).includes(nome)).map((e) => e.numero);
      assert.deepEqual(vermelhos, [dono.numero], `remover ${arq} deixa vermelho o estágio ${dono.numero}`);
      fs.symlinkSync(path.join(RAIZ, 'test/marco9/marketing/adversarial', arq), link);
    }
  } finally { fs.rmSync(raiz, { recursive: true, force: true }); }
});
