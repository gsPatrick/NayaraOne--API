'use strict';

// M9-D444 — declaração "PRONTO PARA LAB" (só com todos os itens do DoD da M9-D439 verdes) e as quatro respostas da autochecagem do Guia §16. Leitura pura: não toca banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const K = require('../_helpers/mktPortao');
const L = require('../../../scripts/lib/marketingProntoParaLab');
const { lerDodDemanda, EQUIVALENCIA } = require('../../../scripts/lib/marketingDod');

const dod = () => lerDodDemanda(K.todas().get('M9-D439').texto);
const verde = () => ({ estagios: new Map(Array.from({ length: 14 }, (_, i) => [i + 1, 'VERDE'])), arquivos: [] });
const declarar = (demandas, esteira = verde()) => L.declaracao({ demandas, esteira, dod: dod() });
/** Bloco todo verificado, inclusive a M9-D444 (a que declara). */
const tudoVerificado = () => K.comStatus(K.todas(), 'verificada');

test('declaracao_pronto_para_lab_so_com_todos_os_itens_do_dod_verdes', () => {
  assert.deepEqual(Object.keys(L.PROVAS_DO_DOD).sort(), dod().map((i) => i.toLowerCase()).sort(), 'cada um dos 16 itens do DoD tem as demandas que o provam, e só eles');
  assert.equal(dod().length, 16);
  const ok = declarar(tudoVerificado());
  assert.equal(ok.pronto, true);
  assert.equal(ok.mensagem, 'PRONTO PARA LAB; produção liberada canal por canal');
  assert.equal(ok.itens.every((i) => i.verde), true);
  // cada item, ao perder uma demanda de prova, derruba a declaração e só ele (e os que compartilham a demanda)
  for (const item of dod()) {
    const alvo = L.PROVAS_DO_DOD[item.toLowerCase()][0];
    const r = declarar(K.comStatus(tudoVerificado(), 'verificada', { [alvo]: 'corrigida' }));
    assert.equal(r.pronto, false, `${item}: ${alvo} corrigida impede a declaração`);
    assert.equal(r.mensagem, 'O bloco não é declarado PRONTO PARA LAB enquanto houver item pendente.');
    assert.ok(r.itens.find((i) => i.item === item).pendentes.includes(`${alvo} está corrigida`));
  }
  // esteira vermelha, incompleta ou ausente impede a declaração
  const vermelha = verde();
  vermelha.estagios.set(8, 'VERMELHO');
  assert.equal(declarar(tudoVerificado(), vermelha).pronto, false);
  const incompleta = verde();
  incompleta.estagios.delete(14);
  assert.equal(declarar(tudoVerificado(), incompleta).pronto, false);
  assert.equal(declarar(tudoVerificado(), { estagios: new Map(), arquivos: [] }).pronto, false);
  // o DoD do livro (Caderno 17 e Guia 15) é coberto pelo mapa de equivalência da M9-D439
  const livro = require('../../../scripts/lib/marketingDod').lerDodLivro(K.caderno());
  for (const item of [...livro.caderno, ...livro.guia]) assert.ok(EQUIVALENCIA[item.toLowerCase()], `${item} do livro tem item equivalente`);
});

test('autochecagem_do_guia_16_tem_as_4_respostas_com_evidencia', () => {
  const r = declarar(tudoVerificado());
  assert.deepEqual(r.respostas.map((a) => a.pergunta), ['Marcelo consegue fazer sozinho?', 'Está blindado?', 'Tem caminho técnico?', 'Outro programador assume?']);
  assert.deepEqual(r.respostas.map((a) => a.resposta), ['SIM', 'SIM para brechas previsíveis', 'SIM: engine, código lógico, APIs, eventos, CI, testes e sprints', 'SIM']);
  assert.ok(K.caderno().replace(/\s+/g, ' ').includes('Marcelo consegue fazer sozinho? SIM'), 'as respostas são as do livro');
  r.respostas.forEach((a) => { assert.ok(a.evidencia.length > 20); assert.deepEqual(a.pendentes, []); });
  // sem a evidência verificada a resposta deixa de ser afirmada
  const sem = declarar(K.comStatus(tudoVerificado(), 'verificada', { 'M9-D437': 'aberta' }));
  assert.equal(sem.respostas[1].resposta, 'NÃO COMPROVADA');
  assert.equal(sem.pronto, false);
});

test('script_pronto_para_lab_lista_o_dod_e_reprova_com_item_pendente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d444-lab-'));
  try {
    const relatorio = (status) => JSON.stringify({ estagios: Array.from({ length: 14 }, (_, i) => ({ numero: i + 1, status })) });
    fs.writeFileSync(path.join(dir, 'esteira-marketing.json'), relatorio('VERDE'));
    // hoje a M9-D444 ainda não é `verificada`; os 16 itens independem dela
    const r = K.rodar(K.pastaDemandas(), ['--pronto-para-lab', '--esteira', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal((r.stdout.match(/^DoD verde /gm) || []).length, 16);
    assert.equal((r.stdout.match(/^§16 /gm) || []).length, 4);
    assert.match(r.stdout, /PRONTO PARA LAB; produção liberada canal por canal/);
    fs.writeFileSync(path.join(dir, 'esteira-marketing.json'), relatorio('VERMELHO'));
    const vermelho = K.rodar(K.pastaDemandas(), ['--pronto-para-lab', '--esteira', dir]);
    assert.equal(vermelho.status, 1);
    assert.match(vermelho.stdout, /DoD PENDENTE testes e failure drills verdes/);
    assert.match(vermelho.stdout, /O bloco não é declarado PRONTO PARA LAB enquanto houver item pendente\./);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
