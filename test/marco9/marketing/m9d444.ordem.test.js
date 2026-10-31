'use strict';

// M9-D444 — ordem exata de 11 passos e mapa de sprints do Marketing: cobertura (um sprint e um passo por demanda), arestas para frente só as da tabela fechada, fonte única do mapa.
// Leitura pura dos arquivos de demanda e do livro: não toca banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const K = require('../_helpers/mktPortao');
const G = require('../../../scripts/lib/marketingPortao');
const P = require('../../../scripts/lib/marketingPassos');
const S = require('../../../scripts/lib/marketingSprints');

const NOMES = ['templates/content', 'content validation', 'publication jobs', 'automation engine', 'suppression/consent/frequency', 'WhatsApp/e-mail', 'site/portals/social', 'tracking/attribution', 'NAY content', 'kill switch', 'tests/failure drills'];

test('ordem_exata_dos_11_passos_do_marketing_confere', () => {
  const f = K.fontes();
  assert.deepEqual(f.passos.map((p) => p.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(f.passos.map((p) => p.nome), NOMES, 'os nomes e a ordem são os da tabela da demanda');
  assert.deepEqual(P.lerPassosDoLivro(K.caderno()).map((n) => n.toLowerCase()), NOMES.map((n) => n.toLowerCase()), 'e os do Guia §1 do livro');
  const ids = K.idsDoBloco(f.demandas);
  assert.equal(ids.length, 44);
  const todosOsPassos = f.passos.flatMap((p) => p.ids);
  assert.deepEqual([...todosOsPassos].sort(), ids, 'cada demanda D400..D444 em exatamente um passo, nenhuma sobrando');
  assert.deepEqual(G.coberturas({ mapa: f.mapa, mapaD444: f.mapaD444, passos: f.passos, idsDoBloco: ids }), []);
  // o fechamento segue a ordem 1 a 11: com o passo 1 incompleto nenhum outro passo fecha, mesmo com todas as suas demandas verificadas
  const so1aberto = G.estadoDosPassos(f.passos, K.comStatus(f.demandas, 'verificada', { 'M9-D403': 'corrigida' }));
  assert.deepEqual(so1aberto.map((p) => p.estado), ['em andamento', ...Array(10).fill('em andamento')]);
  assert.match(so1aberto[1].motivos.join(), /aguarda o fechamento do passo 1/);
  // com o passo 1 fechado e o 2 incompleto, só o 1 fecha
  const ate2 = G.estadoDosPassos(f.passos, K.comStatus(f.demandas, 'verificada', { 'M9-D407': 'aberta' }));
  assert.deepEqual(ate2.map((p) => p.estado), ['fechado', 'em andamento', ...Array(9).fill('em andamento')]);
  assert.equal(G.estadoDosPassos(f.passos, K.comStatus(f.demandas, 'verificada')).every((p) => p.estado === 'fechado'), true);
});

test('toda_demanda_marketing_esta_em_exatamente_um_sprint', () => {
  const f = K.fontes();
  const ids = K.idsDoBloco(f.demandas);
  assert.deepEqual(Object.keys(f.mapa), S.SPRINTS);
  assert.deepEqual(Object.values(f.mapa).map((l) => l.length), [9, 4, 10, 2, 2, 2, 3, 1, 11]);
  assert.deepEqual(S.cobertura(f.mapa, ids), { semSprint: [], emVarios: [], fora: [] });
  const semD440 = G.coberturas({ mapa: K.comDemandaMovida(f.mapa, 'M9-D440', null), mapaD444: f.mapaD444, passos: f.passos, idsDoBloco: ids });
  assert.ok(semD440.some((e) => e.codigo === 'MKT_SPRINT_MAP_INVALID' && e.id === 'M9-D440' && e.detalhe === 'sem sprint'));
  const dupla = K.comDemandaMovida(f.mapa, 'M9-D440', 'M1');
  dupla.M9 = [...dupla.M9, 'M9-D440'];
  assert.ok(G.coberturas({ mapa: dupla, passos: f.passos, idsDoBloco: ids }).some((e) => e.id === 'M9-D440' && /mais de um sprint/.test(e.detalhe)));
  const passoDuplo = f.passos.map((p) => (p.n === 1 ? { ...p, ids: [...p.ids, 'M9-D440'] } : p));
  assert.ok(G.coberturas({ mapa: f.mapa, passos: passoDuplo, idsDoBloco: ids }).some((e) => e.id === 'M9-D440' && /mais de um passo/.test(e.detalhe)));
  const passoSem = f.passos.map((p) => ({ ...p, ids: p.ids.filter((x) => x !== 'M9-D440') }));
  assert.ok(G.coberturas({ mapa: f.mapa, passos: passoSem, idsDoBloco: ids }).some((e) => e.id === 'M9-D440' && e.detalhe === 'sem passo da ordem exata'));
});

test('dependencias_apontam_para_sprint_anterior_ou_adiantada_listada', () => {
  const f = K.fontes();
  const r = G.ordemDasDependencias({ mapa: f.mapa, passos: f.passos, demandas: f.demandas, adiantadas: f.adiantadas });
  assert.deepEqual(r.erros, []);
  assert.equal(f.adiantadas.length, 12);
  assert.deepEqual(r.arestas.map((a) => `${a.de}>${a.para}`).sort(), [...f.adiantadas].sort(), 'as arestas para sprint posterior são exatamente as da tabela');
  assert.deepEqual(r.arestasDePasso.map((a) => `${a.de}>${a.para}`).sort(), [...f.adiantadas].sort(), 'e as arestas para passo posterior também');
});

test('aresta_nova_para_frente_reprova', () => {
  const f = K.fontes();
  const inventada = K.comDependencia(f.demandas, 'M9-D416', 'M9-D429');
  const r = G.ordemDasDependencias({ mapa: f.mapa, passos: f.passos, demandas: inventada, adiantadas: f.adiantadas });
  assert.equal(r.erros.length, 1);
  assert.deepEqual([r.erros[0].codigo, r.erros[0].de, r.erros[0].para], ['MKT_SPRINT_ORDER_VIOLATION', 'M9-D416', 'M9-D429']);
  assert.equal(r.erros[0].mensagem, 'A dependência aponta para um sprint ou passo posterior.');
  // aresta que só é para frente no PASSO (mesmo sprint) também reprova: D405 e D407 são do M1, mas D407 é do passo 2
  const soPasso = K.comDependencia(f.demandas, 'M9-D405', 'M9-D407');
  const rp = G.ordemDasDependencias({ mapa: f.mapa, passos: f.passos, demandas: soPasso, adiantadas: f.adiantadas });
  assert.deepEqual(rp.erros.map((e) => `${e.codigo} ${e.de}>${e.para}`), ['MKT_SPRINT_ORDER_VIOLATION M9-D405>M9-D407']);
  // item inventado na tabela de adiantadas, sem aresta real, também reprova
  const mente = G.ordemDasDependencias({ mapa: f.mapa, passos: f.passos, demandas: f.demandas, adiantadas: [...f.adiantadas, 'M9-D416>M9-D429'] });
  assert.deepEqual(mente.erros.map((e) => `${e.de}>${e.para}`), ['M9-D416>M9-D429']);
});

test('mapa_do_d439_e_deste_arquivo_sao_identicos', () => {
  const f = K.fontes();
  assert.deepEqual(Object.keys(f.mapaD444), S.SPRINTS);
  for (const s of S.SPRINTS) assert.deepEqual([...f.mapaD444[s]].sort(), [...f.mapa[s]].sort(), `${s}: M9-D444 3.1 igual a M9-D439`);
  const ids = K.idsDoBloco(f.demandas);
  const diverge = { ...f.mapaD444, M2: f.mapaD444.M2.filter((x) => x !== 'M9-D434') };
  const erros = G.coberturas({ mapa: f.mapa, mapaD444: diverge, passos: f.passos, idsDoBloco: ids });
  assert.deepEqual(erros.map((e) => `${e.codigo} ${e.id}`), ['MKT_SPRINT_MAP_INVALID M2']);
  assert.match(erros[0].detalhe, /difere do da M9-D439/);
  for (const [s, escopo] of Object.entries(G.ESCOPO)) assert.ok(K.caderno().replace(/\s+/g, ' ').includes(`${s} ${escopo}`) || K.todas().get('M9-D439').texto.toLowerCase().includes(`${s.toLowerCase()} ${escopo.toLowerCase()}`), `${s} ${escopo} é o escopo do livro`);
});
