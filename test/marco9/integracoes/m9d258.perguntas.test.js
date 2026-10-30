'use strict';

// Marco 9, M9-D258 — autochecagem das integrações (Guia §15, livro 511 a 514): as quatro perguntas calculadas por fatos, não declaradas.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compute } = require('../../../scripts/int-autocheck/lib/compute');
const { renderizar } = require('../../../scripts/int-autocheck/lib/saida');
const { ambienteVerde, idsDoBloco, idsDaIa, demandaOk, mapaVerde } = require('../_helpers/m9d258Ambiente');

const rodar = (mexer, escopo = 'integracoes') => compute({ escopo, ambiente: ambienteVerde(mexer).amb });
const pergunta = (r, n) => r.perguntas.find((p) => p.n === n);

test('autocheck_imprime_as_quatro_perguntas_do_livro_com_texto_exato', () => {
  const r = rodar();
  assert.equal(r.ok, true);
  const saida = renderizar(r);
  assert.equal(saida.code, 0);
  const linhas = saida.stdout.split('\n').filter((l) => /^[A-ZÁ-Ú][^ ].*\?/.test(l));
  assert.deepEqual(linhas.slice(0, 2), ['Marcelo consegue fazer sozinho? SIM.', linhas[1]]);
  assert.match(linhas[1], /^Está blindado\? SIM para brechas previsíveis, condicionado a homologação por provider: /);
  assert.ok(saida.stdout.includes('Tem caminho técnico? SIM: framework, adapters, webhooks, retry, CI, tests e sprints.\n'));
  assert.ok(saida.stdout.includes('Outro programador assume? SIM.\n'));
  assert.deepEqual(r.perguntas.map((p) => p.n), [1, 2, 3, 4]);
  assert.equal(saida.stderr, '');
  // A resposta é calculada: derrubar um fato muda a resposta impressa (não é texto fixo).
  const nao = renderizar(rodar({ runbooksFaltando: () => ['messaging-sandbox'] }));
  assert.ok(nao.stdout.includes('Marcelo consegue fazer sozinho? NÃO.\n'));
});

test('autocheck_marcelo_sozinho_nao_quando_runbook_falta', () => {
  const r = rodar({ runbooksFaltando: () => ['messaging-sandbox'] });
  const p = pergunta(r, 1);
  assert.equal(p.ok, false);
  assert.equal(r.ok, false);
  const falha = p.verificacoes.find((v) => !v.ok);
  assert.match(falha.nome, /runbook de 7 seções/);
  assert.deepEqual(falha.detalhes, ['runbook ausente: messaging-sandbox']);
  const s = renderizar(r);
  assert.equal(s.code, 1);
  assert.match(s.stderr, /INTEGRATION_DOD_AUTOCHECK_FAILED Marcelo não consegue fazer sozinho: existe runbook de 7 seções para cada provider do catálogo falhou\./);
  assert.ok(s.stdout.includes('runbook ausente: messaging-sandbox'));
  // As demais perguntas continuam SIM: a falha é localizada.
  assert.equal(pergunta(r, 2).ok && pergunta(r, 3).ok && pergunta(r, 4).ok, true);
});

test('autocheck_marcelo_sozinho_nao_quando_demanda_sem_secao', () => {
  const demandas = () => [...idsDaIa, ...idsDoBloco].map((id) => (id === 'M9-D241' ? { ...demandaOk(id), erros: ['seção 8 (Casos de teste obrigatórios) ausente'] } : demandaOk(id)));
  const r = rodar({ demandas });
  assert.equal(pergunta(r, 1).ok, false);
  assert.equal(pergunta(r, 4).ok, false, 'a pergunta 4 também depende de cada demanda ser autossuficiente');
  assert.deepEqual(pergunta(r, 1).verificacoes[0].detalhes, ['M9-D241: seção 8 (Casos de teste obrigatórios) ausente']);
  assert.equal(pergunta(r, 2).ok && pergunta(r, 3).ok, true);
  // Sem nenhuma demanda do bloco o cálculo também reprova (não vira SIM por ausência de erro).
  assert.equal(pergunta(rodar({ demandas: () => [] }), 1).ok, false);
  // Suíte offline: chamada externa, relatório ausente e arquivo da suíte que não rodou reprovam a pergunta 1.
  assert.equal(pergunta(rodar({ relatorioOffline: () => null }), 1).ok, false);
  assert.match(pergunta(rodar({ relatorioOffline: () => ({ ...ambienteVerde().relatorio, chamadasExternas: 3 }) }), 1).verificacoes[1].detalhes[0], /3 chamada\(s\) externa\(s\)/);
  assert.match(pergunta(rodar({ arquivosEsperados: () => ['test/marco9/integracoes/m9dnovo.test.js'] }), 1).verificacoes[1].detalhes[0], /fora da execução offline/);
  assert.equal(pergunta(rodar({ existeDocumento: () => false }), 1).ok, false);
  assert.equal(pergunta(rodar({ mapa: () => ({ ...mapaVerde(), erro: 'a tabela dos sprints I1 a I9 não foi encontrada' }) }), 1).ok, false);
});

test('autocheck_blindado_condicionado_lista_providers_nao_liberados', () => {
  const doze = Array.from({ length: 12 }, (_, i) => `provider-${i + 1}`);
  const r = rodar({ estadoDoPortao: () => ({ consultado: true, familiasTotal: 14, familiasLiberadas: 2, liberados: ['a', 'b'], naoLiberados: doze }) });
  const p = pergunta(r, 2);
  assert.equal(p.ok, true);
  assert.ok(p.resposta.startsWith('SIM para brechas previsíveis, condicionado a homologação por provider: 2 de 14 famílias com pelo menos um provider liberado para produção (D256); homologação pendente: provider-1, '));
  assert.ok(doze.every((c) => p.resposta.includes(c)), 'a lista dos NOT_RELEASED inteira');
  assert.equal(renderizar(r).code, 0, 'tudo verde com 2 de 14 liberadas: exit 0');
  // Sem consulta ao portão a resposta nunca vira SIM incondicional: a condição continua impressa.
  const sem = pergunta(rodar({ estadoDoPortao: () => ({ consultado: false, familiasTotal: 14, familiasLiberadas: 0, liberados: [], naoLiberados: ['x', 'y'] }) }), 2);
  assert.match(sem.resposta, /condicionado a homologação por provider: 0 de 14 .*homologação pendente: x, y/);
  assert.match(sem.resposta, /não consultado/);
  // Tudo liberado: ainda imprime a condição do livro.
  assert.match(pergunta(rodar({ estadoDoPortao: () => ({ consultado: true, familiasTotal: 14, familiasLiberadas: 14, liberados: ['a'], naoLiberados: [] }) }), 2).resposta, /^SIM para brechas previsíveis, condicionado a homologação por provider: 14 de 14 .*pendente: nenhuma/);
});

test('autocheck_blindado_nao_quando_adversarial_ou_guarda_vermelho', () => {
  const { relatorio } = ambienteVerde();
  const arq = relatorio.arquivos['test/marco9/integracoes/m9d251.webhook.test.js'];
  arq[3] = [arq[3][0], 'fail'];
  const adv = rodar({ relatorioOffline: () => relatorio });
  assert.equal(pergunta(adv, 2).ok, false);
  assert.ok(pergunta(adv, 2).verificacoes[0].detalhes[0].includes(`${arq[3][0]} vermelho`));
  assert.match(renderizar(adv).stderr, /INTEGRATION_DOD_AUTOCHECK_FAILED Não está blindado: os 18 testes adversariais do manifesto \(D251\/D252\) vermelho\./);
  assert.equal(renderizar(adv).code, 1);
  // Um dos 18 nomes que nem consta da execução também reprova.
  assert.equal(pergunta(rodar({ nomesAdversariais: () => ['adv_nome_que_nao_rodou'] }), 2).ok, false);
  assert.equal(pergunta(rodar({ guardasNaoImprovisar: () => ({ ok: false, detalhe: 'ARCH_RULE_VIOLATION em 1 arquivo' }) }), 2).ok, false);
  assert.equal(pergunta(rodar({ varreduraSegredos: () => ({ ok: false, detalhe: '2 achados' }) }), 2).ok, false);
  assert.equal(pergunta(rodar({ contratosFaltando: () => ['bank-sandbox'] }), 2).ok, false);
  const ssrf = ambienteVerde().relatorio;
  ssrf.arquivos['test/marco9/integracoes/m9d252.ssrf.test.js'] = [['x', 'fail']];
  assert.equal(pergunta(rodar({ relatorioOffline: () => ssrf }), 2).ok, false);
  const pulado = ambienteVerde().relatorio;
  pulado.arquivos['test/marco9/integracoes/m9d222.cenarios.test.js'] = [['x', 'skip']];
  assert.equal(pergunta(rodar({ relatorioOffline: () => pulado }), 2).ok, false, 'teste pulado não conta como verde');
});

const COMPONENTES = ['framework', 'adapters', 'webhooks', 'retry', 'CI', 'tests', 'sprints'];

test('autocheck_caminho_tecnico_lista_os_sete_componentes', () => {
  const r = rodar();
  const p = pergunta(r, 3);
  assert.deepEqual(p.verificacoes.map((v) => v.nome.split(' ')[0]), COMPONENTES);
  assert.ok(p.verificacoes.every((v) => v.ok));
  const s = renderizar(r).stdout;
  COMPONENTES.forEach((c) => assert.match(s, new RegExp(`OK\\s+${c} `)));
});

test('autocheck_caminho_tecnico_nao_quando_componente_falta', () => {
  const casos = {
    framework: { demandas: () => idsDoBloco.map((id) => demandaOk(id, id === 'M9-D205' ? 'corrigida' : 'verificada')) },
    adapters: { familiasSemAdapter: () => ['FISCAL'] },
    webhooks: { demandas: () => idsDoBloco.map((id) => demandaOk(id, id === 'M9-D212' ? 'aberta' : 'verificada')) },
    retry: { demandas: () => idsDoBloco.map((id) => demandaOk(id, id === 'M9-D217' ? 'reaberta' : 'verificada')) },
    CI: { esteira: () => ({ problemas: ['são 12 etapas; o livro tem 13'] }) },
    tests: { demandas: () => idsDoBloco.map((id) => demandaOk(id, id === 'M9-D252' ? 'em_execucao' : 'verificada')) },
    sprints: { mapa: () => ({ ...mapaVerde(), semSprint: ['M9-D259'] }) },
  };
  for (const [componente, mexer] of Object.entries(casos)) {
    const r = rodar(mexer);
    const p = pergunta(r, 3);
    const falhas = p.verificacoes.filter((v) => !v.ok);
    assert.equal(p.ok, false, componente);
    assert.equal(falhas.length, 1, `${componente}: só o componente que falta reprova (${falhas.map((f) => f.nome)})`);
    assert.ok(falhas[0].nome.startsWith(componente), componente);
    assert.match(renderizar(r).stderr, new RegExp(`Caminho técnico incompleto: ${componente} `));
  }
  // Webhook e retry também reprovam por teste vermelho, não só por status.
  const rel = ambienteVerde().relatorio;
  rel.arquivos['test/marco9/integracoes/m9d216.fluxo.test.js'] = [['x', 'fail']];
  assert.equal(pergunta(rodar({ relatorioOffline: () => rel }), 3).verificacoes.find((v) => v.nome.startsWith('retry')).ok, false);
});

test('autocheck_outro_programador_nao_quando_mapa_ou_parametros_incompletos', () => {
  const f = (mexer) => pergunta(rodar(mexer), 4);
  assert.equal(f({}).ok, true);
  assert.deepEqual(f({ parametrosNaoCobertos: () => ['integration.portal.unpublish_retry_interval_min'] }).verificacoes[1].detalhes, ['parâmetro sem linha no catálogo: integration.portal.unpublish_retry_interval_min']);
  assert.equal(f({ parametrosNaoCobertos: () => ['integration.x.y'] }).ok, false);
  assert.equal(f({ mapa: () => ({ ...mapaVerde(), semSprint: ['M9-D259'] }) }).ok, false);
  assert.equal(f({ mapa: () => ({ ...mapaVerde(), dependenciasIncoerentes: [{ id: 'M9-D230', sprint: 'I4', dependencia: 'M9-D240', sprintDaDependencia: 'I6' }] }) }).ok, false);
  assert.equal(f({ mapa: () => ({ ...mapaVerde(), ciclos: ['M9-D1, M9-D2'] }) }).ok, false);
  assert.equal(f({ problemasDaMatriz: () => ['INT-004: o teste x não existe em nenhum arquivo de teste'] }).ok, false);
  assert.equal(f({ existeArquivo: () => false }).ok, false);
  const r = rodar({ parametrosNaoCobertos: () => ['integration.x.y'] });
  assert.match(renderizar(r).stderr, /INTEGRATION_DOD_AUTOCHECK_FAILED Outro programador não assume: o _parametros-bloco-B\.csv cobre todo parâmetro integration\.\* citado nas demandas\./);
});

test('autocheck_marcelo_sozinho_escopo_ia_nay_calculado_com_condicao_do_livro', () => {
  const r = rodar({}, 'ia-nay');
  assert.deepEqual(r.perguntas.map((p) => p.n), [1], 'a IA NAY consome só a pergunta 1: a M9-D258 é a dona do cálculo');
  assert.equal(r.escopo, 'ia-nay');
  assert.equal(r.perguntas[0].resposta, 'SIM, em LAB, se dominar backend e integração de APIs/LLMs.');
  assert.ok(renderizar(r).stdout.includes('Marcelo consegue fazer sozinho? SIM, em LAB, se dominar backend e integração de APIs/LLMs.\n'));
  // (a) vale para D001 a D047, não para o bloco de integrações.
  const demandas = () => [{ ...demandaOk('M9-D030'), erros: ['seção 3 vazia'] }, ...idsDoBloco.map((id) => demandaOk(id))];
  assert.equal(rodar({ demandas }, 'ia-nay').perguntas[0].ok, false);
  assert.equal(rodar({ demandas: () => [{ ...demandaOk('M9-D230'), erros: ['seção 3 vazia'] }, demandaOk('M9-D010')] }, 'ia-nay').perguntas[0].ok, true);
  // (b) a suíte da IA offline e (c) o runbook de operação da IA.
  const pedidos = [];
  const estado = rodar({ relatorioOffline: (e) => { pedidos.push(e); return ambienteVerde().relatorio; } }, 'ia-nay');
  assert.ok(pedidos.every((e) => e === 'ia-nay') && pedidos.length > 0);
  assert.equal(estado.ok, true);
  const semRunbook = rodar({ runbookIa: () => ['arquivo docs/runbooks/ai/operacao.md ausente'] }, 'ia-nay');
  assert.equal(semRunbook.ok, false);
  assert.match(renderizar(semRunbook).stderr, /Marcelo não consegue fazer sozinho: existe o runbook de operação da IA com as 7 seções falhou\./);
  assert.equal(rodar({ relatorioOffline: () => ({ chamadasExternas: 1, arquivos: ambienteVerde().relatorio.arquivos }) }, 'ia-nay').ok, false);
  assert.throws(() => rodar({}, 'outro'), /escopo desconhecido/);
});

test('autocheck_mapa_detecta_dependencia_circular_no_sprint', () => {
  const { ciclosDoSprint } = require('../../../scripts/int-autocheck/lib/ambienteDemandas');
  const dep = (id, ...dependencias) => [id, { id, dependencias }];
  const sprint = { demandas: ['M9-D1', 'M9-D2', 'M9-D3'] };
  assert.deepEqual(ciclosDoSprint(sprint, new Map([dep('M9-D1'), dep('M9-D2', 'M9-D1'), dep('M9-D3', 'M9-D2')])), []);
  assert.deepEqual(ciclosDoSprint(sprint, new Map([dep('M9-D1'), dep('M9-D2', 'M9-D3'), dep('M9-D3', 'M9-D2')])), ['M9-D2', 'M9-D3']);
});
