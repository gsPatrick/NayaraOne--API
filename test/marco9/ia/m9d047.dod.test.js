'use strict';

// M9-D047 — Definition of Done da NAY executável: a matriz de 16 itens ligada a testes nomeados, o script que reprova item sem prova, o item 14 com redaction E
// isolamento entre empresas, e a autochecagem de quatro perguntas calculada por fatos. Sem banco: ambiente falso (o script real lê os mesmos fatos nos arquivos).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { executar } = require('../../../scripts/ai-dod/lib/executar');
const { problemasDaMatriz } = require('../../../scripts/ai-dod/lib/matriz');
const { avaliarItens } = require('../../../scripts/ai-dod/lib/avaliar');
const { autochecar } = require('../../../scripts/ai-dod/lib/autochecagem');
const { compute } = require('../../../scripts/int-autocheck/lib/compute');
const { ambienteIaVerde, matrizReal, relatorioIaVerde } = require('../_helpers/iaDodAmbiente');
const { mapaVerde } = require('../_helpers/m9d258Ambiente');

const API = path.join(__dirname, '..', '..', '..');
const pergunta = (r, n) => r.perguntas.find((p) => p.n === n);

test('m9d047_dod_check_falha_se_item_sem_prova', () => {
  // Item 12 sem relatório adversarial: "DoD item 12 sem prova", exit 1.
  const semRelatorio = executar(matrizReal(), ambienteIaVerde({ relatorioAdversarial: () => ({ ausente: true, problemas: [] }) }).amb);
  assert.equal(semRelatorio.code, 1);
  assert.match(semRelatorio.stderr, /DoD item 12 sem prova: relatório da suíte adversarial ausente/);
  assert.equal([...semRelatorio.stderr.matchAll(/DoD item (\d+) sem prova/g)].length, 1, 'só o item 12 reprova');
  // Relatório com teste adversarial reprovado: também reprova o 12.
  const reprovado = executar(matrizReal(), ambienteIaVerde({ relatorioAdversarial: () => ({ ausente: false, problemas: ['adv_x: reprovado'] }) }).amb);
  assert.match(reprovado.stderr, /DoD item 12 sem prova: relatório adversarial: adv_x: reprovado/);
  // Teste nomeado que não existe, teste vermelho, teste pulado e demanda não verificada: cada um reprova o seu item.
  assert.match(executar(matrizReal(), ambienteIaVerde({ testeDeclarado: (n) => n !== 'm9d009_texto_livre_recusado' }).amb).stderr, /DoD item 5 sem prova: teste m9d009_texto_livre_recusado não existe/);
  for (const [status, palavra] of [['fail', 'vermelho'], ['skip', 'pulado']]) {
    const { amb, relatorio } = ambienteIaVerde();
    const caso = Object.values(relatorio.arquivos)[0].find(([n]) => n === 'm9d019_aprovador_distinto');
    caso[1] = status;
    assert.match(executar(matrizReal(), amb).stderr, new RegExp(`DoD item 8 sem prova: teste m9d019_aprovador_distinto ${palavra}`));
  }
  const demandas = ambienteIaVerde().amb.demandas().map((d) => (d.id === 'M9-D019' ? { ...d, status: 'corrigida' } : d));
  assert.match(executar(matrizReal(), ambienteIaVerde({ demandas: () => demandas }).amb).stderr, /DoD item 8 sem prova: M9-D019 está corrigida/);
  // Sem execução offline nenhuma, nenhum item tem prova.
  const semExecucao = executar(matrizReal(), ambienteIaVerde({ relatorioOffline: () => null }).amb);
  assert.equal([...semExecucao.stderr.matchAll(/DoD item \d+ sem prova/g)].length, 16);
  // O script real, sem relatório da execução offline, reprova de verdade e imprime as quatro perguntas.
  const vazia = fs.mkdtempSync(path.join(os.tmpdir(), 'dod-ia-'));
  let real;
  try { real = spawnSync('node', ['scripts/ai-dod-check.js', '--raiz', vazia], { cwd: API, encoding: 'utf8' }); } finally { fs.rmSync(vazia, { recursive: true, force: true }); }
  assert.equal(real.status, 1);
  assert.match(real.stderr, /AI_DOD_ITEM_MISSING DoD item \d+ sem prova/);
  for (const texto of ['Marcelo consegue fazer sozinho?', 'Está blindado?', 'Tem caminho técnico?', 'Outro programador assume?']) assert.match(real.stdout, new RegExp(texto.replace('?', '\\?')));
});

test('m9d047_dod_check_verde_com_16_itens', () => {
  const matriz = matrizReal();
  assert.deepEqual(problemasDaMatriz(matriz), []);
  assert.equal(matriz.itens.length, 16);
  assert.deepEqual(matriz.itens.map((i) => i.n), Array.from({ length: 16 }, (_, i) => i + 1));
  const { amb } = ambienteIaVerde();
  const itens = avaliarItens(matriz, amb);
  assert.equal(itens.length, 16);
  assert.ok(itens.every((i) => i.ok), JSON.stringify(itens.filter((i) => !i.ok)));
  const r = executar(matriz, amb);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal([...r.stdout.matchAll(/^\s*\d+\. \[OK {3}\]/gm)].length, 16);
  assert.match(r.stdout, /16 de 16 itens com prova; 4 de 4 perguntas com SIM/);
  // Os 16 itens do livro (seção 16 e Guia 18): cada demanda dona da tabela do livro está ligada ao seu item.
  const demandasPorItem = Object.fromEntries(matriz.itens.map((i) => [i.n, i.demandas.join(' ')]));
  assert.equal(demandasPorItem[1], 'M9-D010 M9-D011');
  assert.equal(demandasPorItem[9], 'M9-D012 M9-D013 M9-D014');
  assert.equal(demandasPorItem[14], 'M9-D027 M9-D023 M9-D004 M9-D005 M9-D044');
  assert.equal(demandasPorItem[15], 'M9-D047');
  assert.equal(demandasPorItem[16], 'M9-D034');
  // Matriz com item a menos é recusada antes de avaliar qualquer coisa.
  const curta = matrizReal();
  curta.itens.pop();
  const recusada = executar(curta, ambienteIaVerde().amb);
  assert.equal(recusada.code, 1);
  assert.match(recusada.stderr, /matriz do DoD recusada: a matriz lista 15 itens; o livro tem 16/);
});

test('m9d047_autochecagem_calculada', () => {
  const { amb } = ambienteIaVerde();
  const itens = avaliarItens(matrizReal(), amb);
  const r = autochecar(itens, amb);
  assert.equal(r.ok, true);
  assert.deepEqual(r.perguntas.map((p) => p.resposta), [
    'SIM, em LAB, se dominar backend e integração de APIs/LLMs.',
    'SIM para brechas previsíveis, condicionado aos testes/red-team.',
    'SIM: arquitetura, ordem, tools, RAG, memória, approval, testes, CI e sprints.',
    'SIM com Livro Mestre + Guia.',
  ]);
  // Pergunta 1: é exatamente o cálculo da M9-D258 no escopo ia-nay (dona única), sem cálculo próprio.
  const d258 = compute({ escopo: 'ia-nay', ambiente: amb }).perguntas[0];
  assert.deepEqual(pergunta(r, 1).verificacoes, d258.verificacoes);
  assert.equal(pergunta(r, 1).resposta, d258.resposta);
  const semRunbook = ambienteIaVerde({ runbookIa: () => ['arquivo docs/runbooks/ai/operacao.md ausente'] }).amb;
  const naoMarcelo = autochecar(avaliarItens(matrizReal(), semRunbook), semRunbook);
  assert.equal(pergunta(naoMarcelo, 1).resposta, 'NÃO.');
  assert.equal(pergunta(naoMarcelo, 2).ok && pergunta(naoMarcelo, 3).ok && pergunta(naoMarcelo, 4).ok, true, 'a falha é localizada');
  assert.match(executar(matrizReal(), semRunbook).stdout, /Marcelo consegue fazer sozinho\? NÃO\./);
  // Pergunta 2: itens 3, 7, 12 e 14 verdes e red-team aprovado.
  for (const [n, nome] of [[3, 'm9d017_permissao_efetiva_e_interseccao'], [7, 'm9d021_injection_em_pdf_nao_altera_tool_policy'], [12, 'adv_manifest_completo'], [14, 'm9d005_empresa_b_404']]) {
    const { amb: a, relatorio } = ambienteIaVerde();
    Object.values(relatorio.arquivos)[0].find(([x]) => x === nome)[1] = 'fail';
    const q = autochecar(avaliarItens(matrizReal(), a), a);
    assert.equal(pergunta(q, 2).ok, false, `item ${n} vermelho derruba a pergunta 2`);
    assert.match(pergunta(q, 2).verificacoes.find((v) => !v.ok).nome, new RegExp(`item ${n} do DoD`));
  }
  const semRedTeam = ambienteIaVerde({ redTeam: () => ['relatório de red-team ausente'] }).amb;
  const q2 = autochecar(avaliarItens(matrizReal(), semRedTeam), semRedTeam);
  assert.equal(pergunta(q2, 2).ok, false);
  assert.equal(pergunta(q2, 2).verificacoes.find((v) => !v.ok).nome, 'o red-team (M9-D046) aprovado');
  // Item que NÃO é da blindagem (ex.: o 5) vermelho não derruba a pergunta 2, mas derruba o DoD.
  const { amb: a5, relatorio: r5 } = ambienteIaVerde();
  Object.values(r5.arquivos)[0].find(([x]) => x === 'm9d009_texto_livre_recusado')[1] = 'fail';
  assert.equal(pergunta(autochecar(avaliarItens(matrizReal(), a5), a5), 2).ok, true);
  // Pergunta 3: 100% das demandas no mapa da M9-D045. Pergunta 4: _PLANO.md, demandas completas e ordem.
  const orfa = ambienteIaVerde({ mapa: () => ({ ...mapaVerde(), semSprint: ['M9-D030'] }) }).amb;
  const qm = autochecar(avaliarItens(matrizReal(), orfa), orfa);
  assert.equal(pergunta(qm, 3).ok, false);
  assert.match(pergunta(qm, 3).verificacoes[0].detalhes[0], /M9-D030: demanda órfã/);
  const semPlano = ambienteIaVerde({ existeDocumento: () => false }).amb;
  assert.equal(pergunta(autochecar(avaliarItens(matrizReal(), semPlano), semPlano), 4).ok, false);
  const semMapa = ambienteIaVerde({ mapa: () => ({ ...mapaVerde(), erro: 'tabela dos sprints não encontrada' }) }).amb;
  assert.equal(pergunta(autochecar(avaliarItens(matrizReal(), semMapa), semMapa), 4).ok, false);
  // O DoD sai com 1 quando uma pergunta é NÃO, mesmo com os 16 itens verdes.
  const so = executar(matrizReal(), semPlano);
  assert.equal(so.code, 1);
  assert.match(so.stderr, /Autochecagem: "Outro programador assume\?" respondeu NÃO/);
  assert.equal(relatorioIaVerde().chamadasExternas, 0);
});

test('m9d047_item_14_exige_redaction_e_rls_verdes', () => {
  const matriz = matrizReal();
  const quatorze = matriz.itens.find((i) => i.n === 14);
  const grupo = (g) => quatorze.provas.filter((p) => p.grupo === g).map((p) => p.teste);
  assert.deepEqual(grupo('redaction'), ['adv_pii_no_log_redaction']);
  assert.deepEqual(grupo('rls'), ['m9d023_retrieval_cross_company_bloqueado', 'm9d005_empresa_b_404', 'm9d004_empresa_b_nao_ve_agente_da_a']);
  assert.equal(new Set([...grupo('redaction'), ...grupo('rls')]).size, 4, 'quatro testes com nomes distintos');
  const item14 = (amb) => avaliarItens(matrizReal(), amb).find((i) => i.n === 14);
  assert.equal(item14(ambienteIaVerde().amb).ok, true);
  // Qualquer um dos quatro testes vermelho, pulado ou fora da execução derruba o item 14 (e só ele, salvo o que compartilha o teste).
  for (const nome of [...grupo('redaction'), ...grupo('rls')]) {
    for (const estado of ['fail', 'skip']) {
      const { amb, relatorio } = ambienteIaVerde();
      Object.values(relatorio.arquivos)[0].find(([x]) => x === nome)[1] = estado;
      const it = item14(amb);
      assert.equal(it.ok, false, `${nome} ${estado}`);
      assert.ok(it.falhas.some((f) => f.includes(nome)), it.falhas.join('; '));
    }
    const { amb, relatorio } = ambienteIaVerde();
    const arq = Object.keys(relatorio.arquivos)[0];
    relatorio.arquivos[arq] = relatorio.arquivos[arq].filter(([x]) => x !== nome);
    assert.equal(item14(amb).ok, false, `${nome} fora da execução`);
  }
  // Só redaction ou só RLS verde não basta: a matriz precisa ter as duas famílias, com os três testes de isolamento.
  const semRls = matrizReal();
  semRls.itens.find((i) => i.n === 14).provas = semRls.itens.find((i) => i.n === 14).provas.filter((p) => p.grupo === 'redaction');
  assert.match(problemasDaMatriz(semRls).join(' '), /precisa de 3 testes de isolamento entre empresas \(RLS\)/);
  const semRedaction = matrizReal();
  semRedaction.itens.find((i) => i.n === 14).provas = semRedaction.itens.find((i) => i.n === 14).provas.filter((p) => p.grupo === 'rls');
  assert.match(problemasDaMatriz(semRedaction).join(' '), /não tem teste de redaction/);
  const mesmo = matrizReal();
  mesmo.itens.find((i) => i.n === 14).provas[0].teste = 'm9d005_empresa_b_404';
  assert.match(problemasDaMatriz(mesmo).join(' '), /repete um nome de teste|mesmo teste como redaction e como RLS/);
});
