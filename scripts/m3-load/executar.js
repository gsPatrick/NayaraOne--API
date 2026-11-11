'use strict';

/**
 * Carga do Marco 3 (Pessoas, Imóveis, CRM e Radar) no banco descartável: roda as fases (fases.js), lê o banco (coleta.js) e confere as
 * invariantes do livro (invariantes.js). Devolve o relatório; `ok` só se todas as invariantes ficarem sem violação.
 */
const { fasePessoas, faseOportunidades, faseRadar, faseLeituras } = require('./fases');
const { coletar } = require('./coleta');
const inv = require('./invariantes');

const CAMPOS_DO_VOLUME = ['pessoasPorEmpresa', 'tentativasMesmoCpf', 'oportunidades', 'oportunidadesSemProximaAcao', 'imoveisComOferta',
  'reprocessamentosSimultaneosDoRadar', 'leiturasPorConsulta', 'concorrencia', 'limiteP95Ms'];

/** Confere o volume vindo de scripts/ci-marco3/etapas.json (`carga`): todo campo presente, inteiro e positivo. */
function validarVolume(volume) {
  const ruins = CAMPOS_DO_VOLUME.filter((c) => !(Number.isInteger(volume && volume[c]) && volume[c] > 0));
  if (ruins.length) throw new Error(`carga inválida em scripts/ci-marco3/etapas.json: ${ruins.join(', ')} (inteiro positivo)`);
  if (volume.tentativasMesmoCpf < 2) throw new Error('carga.tentativasMesmoCpf precisa ser pelo menos 2 (senão não há disputa)');
  return volume;
}

async function executarCarga(tenants, volume) {
  validarVolume(volume);
  const inicio = new Date();
  const rodada = Date.now().toString(36);
  const semente = (Date.now() % 9000) * 100000;
  const pessoas = await fasePessoas(tenants, volume, rodada, semente);
  const oportunidades = await faseOportunidades(tenants.tenantA, pessoas.porEmpresa.A.ids, volume);
  const radar = await faseRadar(tenants.tenantA, pessoas.porEmpresa.A.ids[0], volume, rodada);
  const leituras = await faseLeituras(tenants.tenantA, radar.radares[0].radarId, volume);
  const banco = await coletar(tenants, rodada, { pessoas, oportunidades, radar });
  const lat = inv.latencia(leituras, volume.limiteP95Ms);
  const violacoes = {
    pessoaUnica: inv.pessoaUnica(pessoas.mesmoCpf, banco.pessoasComOCpfDisputado),
    pessoasPerdidas: inv.pessoasPerdidas(pessoas.porEmpresa, banco.pessoasDaRodada, volume),
    proximaAcao: inv.proximaAcao(oportunidades, banco, volume),
    radarIdempotente: inv.radarIdempotente(radar, banco, volume),
    isolamento: inv.isolamento(banco.vistoPelaEmpresaB),
    latencia: lat.violacoes,
  };
  const totais = Object.fromEntries(Object.entries(violacoes).map(([k, v]) => [k, v.length]));
  return {
    volume, rodada,
    operacoes: {
      pessoasCriadas: pessoas.porEmpresa.A.ids.length + pessoas.porEmpresa.B.ids.length,
      criacoesSimultaneasMesmoCpf: pessoas.mesmoCpf,
      oportunidadesCriadas: oportunidades.ids.length,
      oportunidadesSemProximaAcao: oportunidades.semProximaAcao,
      imoveisComOferta: radar.imoveis.length,
      reprocessamentosDoRadar: radar.radares.map((r) => ({ tipo: r.tipo, ...r.reprocessamentos })),
      p95CriacaoPessoaMs: inv.percentil([...pessoas.porEmpresa.A.ms, ...pessoas.porEmpresa.B.ms], 95),
      p95CriacaoOportunidadeMs: inv.percentil(oportunidades.ms, 95),
    },
    leituras: lat.resumo,
    banco,
    violacoes, totais,
    ok: Object.values(totais).every((t) => t === 0),
    duracaoMs: Date.now() - inicio.getTime(),
    executadoEm: inicio.toISOString(),
  };
}

module.exports = { executarCarga, validarVolume, CAMPOS_DO_VOLUME };
