'use strict';

/**
 * Avaliação dos 16 itens do DoD da NAY (M9-D047). Função pura sobre o `ambiente`: o script usa o real (ambiente.js), o teste usa um falso. Cada item precisa de
 * (a) cada teste nomeado existente nos arquivos de teste e verde no relatório da execução offline (reports/offline-run-ia.json), nunca pulado, e
 * (b) cada demanda `verificada` (só o verificador independente marca; a demanda dona do próprio script, M9-D047, vale em `corrigida` ou `verificada`,
 * porque o verificador a marca DEPOIS de rodar este script). O item 12 exige também o relatório da suíte adversarial com os 15 testes aprovados.
 */
const { casos } = require('../../int-autocheck/lib/relatorio');

const ESTADOS_DA_PROPRIA = ['corrigida', 'verificada'];

/** O nome da matriz é o do livro; o teste pode continuar o nome com `_` ou espaço (ex.: m9d004_empresa_b_nao_ve_agente_da_a_no_servico). Todo teste que casa tem de estar verde. */
const casaComNome = (nome, prova) => nome === prova || nome.startsWith(`${prova}_`) || nome.startsWith(`${prova} `);

function provaVerde(relatorio, prova) {
  const achados = casos(relatorio).filter((c) => casaComNome(c.nome, prova));
  if (!achados.length) return { ok: false, detalhe: `teste ${prova} não consta da execução offline` };
  const ruim = achados.find((c) => c.status !== 'pass');
  return ruim ? { ok: false, detalhe: `teste ${ruim.nome} ${ruim.status === 'fail' ? 'vermelho' : 'pulado'} em ${ruim.arquivo}` } : { ok: true, detalhe: '' };
}

function falhasDeDemandas(it, amb) {
  const por = new Map(amb.demandas().map((d) => [d.id, d]));
  return it.demandas.flatMap((id) => {
    const d = por.get(id);
    const aceitos = id === it.propria ? ESTADOS_DA_PROPRIA : ['verificada'];
    if (!d) return [`${id} ausente`];
    return aceitos.includes(d.status) ? [] : [`${id} está ${d.status || 'sem status'}`];
  });
}

function falhasDeTestes(it, amb, relatorio) {
  return it.provas.flatMap(({ teste }) => {
    if (!amb.testeDeclarado(teste)) return [`teste ${teste} não existe nos arquivos de teste`];
    if (!relatorio) return [`teste ${teste} sem execução offline (relatório ausente)`];
    const r = provaVerde(relatorio, teste);
    return r.ok ? [] : [r.detalhe];
  });
}

function falhasDoAdversarial(amb) {
  const r = amb.relatorioAdversarial();
  if (!r || r.ausente) return ['relatório da suíte adversarial ausente (npm run test:ai:adversarial)'];
  return r.problemas.map((x) => `relatório adversarial: ${x}`);
}

function avaliarItem(it, amb, relatorio) {
  const falhas = [...falhasDeTestes(it, amb, relatorio), ...falhasDeDemandas(it, amb), ...(it.relatorioAdversarial ? falhasDoAdversarial(amb) : [])];
  const grupos = [...new Set(it.provas.map((x) => x.grupo).filter(Boolean))];
  return { n: it.n, item: it.item, ok: falhas.length === 0, falhas, grupos, provas: it.provas.map((x) => x.teste), demandas: it.demandas };
}

/** Os itens da matriz avaliados, na ordem do livro. */
function avaliarItens(matriz, amb) {
  const relatorio = amb.relatorioOffline('ia-nay');
  return matriz.itens.map((it) => avaliarItem(it, amb, relatorio));
}

module.exports = { avaliarItens, avaliarItem, casaComNome };
