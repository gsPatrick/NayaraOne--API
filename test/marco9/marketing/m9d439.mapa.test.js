'use strict';

// M9-D439 — mapa sprint -> demandas do Marketing (fonte única: a própria M9-D439) e coerência com o campo Dependências, com as únicas exceções da tabela
// de dependências adiantadas da M9-D444. Leitura pura dos arquivos de demanda: não toca banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../../scripts/lib/marketingSprints');
const fonte = require('../_helpers/mktSprintsFonte');

const todas = fonte.demandas();
const mapa = () => S.lerMapaSprints(todas.get('M9-D439').texto);
const adiantadas = () => S.lerAdiantadas(todas.get('M9-D444').texto);

test('mapa_publica_os_9_sprints_e_as_44_demandas_cada_uma_em_exatamente_um', () => {
  const m = mapa();
  assert.deepEqual(Object.keys(m), S.SPRINTS);
  const ids = fonte.idsDoBloco(todas);
  assert.equal(ids.length, 44);
  const cob = S.cobertura(m, ids);
  assert.deepEqual(cob, { semSprint: [], emVarios: [], fora: [] });
  assert.equal(Object.values(m).flat().length, 44);
  assert.deepEqual(m.M3.slice(-5), ['M9-D420', 'M9-D421', 'M9-D422', 'M9-D423', 'M9-D424'], 'o intervalo "D420 a D424" é expandido');
  assert.ok(m.M9.includes('M9-D439') && m.M9.includes('M9-D442') && m.M9.includes('M9-D444'));
});

test('demanda_removida_do_mapa_ou_em_dois_sprints_reprova', () => {
  const ids = fonte.idsDoBloco(todas);
  const semD440 = S.cobertura(fonte.comDemandaMovida(mapa(), 'M9-D440', null), ids);
  assert.deepEqual(semD440.semSprint, ['M9-D440']);
  const dupla = fonte.comDemandaMovida(mapa(), 'M9-D440', 'M1');
  dupla.M9 = [...dupla.M9, 'M9-D440'];
  assert.deepEqual(S.cobertura(dupla, ids).emVarios, [{ id: 'M9-D440', sprints: ['M1', 'M9'] }]);
  const citaFantasma = { ...mapa(), M1: [...mapa().M1, 'M9-D499'] };
  assert.deepEqual(S.cobertura(citaFantasma, ids).fora, ['M9-D499']);
});

test('dependencias_apontam_para_sprint_anterior_ou_adiantada_listada', () => {
  const lista = adiantadas();
  assert.equal(lista.length, 12, 'a tabela da M9-D444 tem 12 arestas');
  const { arestas, erros } = S.verificarOrdem(mapa(), todas, lista);
  assert.deepEqual(erros, [], JSON.stringify(erros));
  assert.deepEqual(arestas.map((a) => `${a.de}>${a.para}`).sort(), [...lista].sort(), 'as arestas para frente dos arquivos são exatamente as da tabela');
  // as três famílias da tabela (D425 no kill switch, D430 no adapter, D418 no canSend)
  const por = (alvo) => arestas.filter((a) => a.para === alvo).map((a) => a.de);
  assert.deepEqual(por('M9-D425'), ['M9-D408', 'M9-D410', 'M9-D411', 'M9-D414']);
  assert.deepEqual(por('M9-D430'), ['M9-D410', 'M9-D411']);
  assert.deepEqual(por('M9-D418'), ['M9-D414', 'M9-D420', 'M9-D421', 'M9-D422', 'M9-D423', 'M9-D424']);
});

test('aresta_nova_para_frente_reprova: D416 passando a depender de D429', () => {
  const inventada = fonte.comDependencia(todas, 'M9-D416', 'M9-D429');
  const { erros } = S.verificarOrdem(mapa(), inventada, adiantadas());
  assert.equal(erros.length, 1);
  assert.deepEqual([erros[0].codigo, erros[0].de, erros[0].para, erros[0].sprintDe, erros[0].sprintPara], ['MKT_SPRINT_ORDER_VIOLATION', 'M9-D416', 'M9-D429', 'M3', 'M5']);
  assert.equal(erros[0].mensagem, 'A dependência aponta para um sprint ou passo posterior.');
});

test('tabela_de_adiantadas_que_cita_aresta_inexistente_reprova', () => {
  const { erros } = S.verificarOrdem(mapa(), todas, [...adiantadas(), 'M9-D416>M9-D429']);
  assert.deepEqual(erros.map((e) => `${e.de}>${e.para}`), ['M9-D416>M9-D429']);
});

test('mover_demanda_de_sprint_cria_aresta_nova_e_reprova', () => {
  // D418 (consent) passando para o sprint M9 quebra D419 (M4) -> D418 e as seis adiantadas já listadas deixam de ser "para frente" só pelo sprint antigo
  const { erros } = S.verificarOrdem(fonte.comDemandaMovida(mapa(), 'M9-D418', 'M9'), todas, adiantadas());
  assert.ok(erros.some((e) => e.de === 'M9-D419' && e.para === 'M9-D418'), JSON.stringify(erros));
});
