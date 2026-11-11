'use strict';

/**
 * Fases da carga do Marco 3: operações REAIS pelos serviços (mesmo caminho da API, RLS da role de runtime), cada uma na sua transação
 * commitada, em paralelo até `concorrencia`. Pessoas (volume nas duas empresas + o MESMO CPF ao mesmo tempo), oportunidades (com e sem
 * próxima ação), Radar (ofertas que disparam o match ao mesmo tempo + reprocessamentos simultâneos do job) e leituras medidas.
 */
const peopleService = require('../../src/features/people/people.service');
const propertiesService = require('../../src/features/properties/properties.service');
const offersService = require('../../src/features/properties/propertyOffers.service');
const opportunitiesService = require('../../src/features/crm/opportunities.service');
const radarService = require('../../src/features/radar/radar.service');
const { processRadar } = require('../../src/engines/jobs/radarMatchingJob');
const { PropertyRadar } = require('../../src/models');
const { comoTenant, emParalelo, cpfValido } = require('./ambiente');
const { avisosDoRadar } = require('./coleta');

const codigo = (r) => (r.erro && (r.erro.code || r.erro.name)) || 'SEM_CODIGO';
const contarCodigos = (lista) => lista.filter((r) => !r.ok).reduce((m, r) => ({ ...m, [codigo(r)]: (m[codigo(r)] || 0) + 1 }), {});
const erros = (lista) => lista.filter((r) => !r.ok).map((r) => `${codigo(r)}: ${r.erro.message}`);
const novaPessoa = (tenant, legalName, taxIdNormalized) => (t) => peopleService.createPerson(
  { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName, ...(taxIdNormalized ? { taxIdNormalized } : {}) }, tenant.userId, t,
);

async function fasePessoas({ tenantA, tenantB }, volume, rodada, semente) {
  const porEmpresa = {};
  for (const [nome, tenant] of [['A', tenantA], ['B', tenantB]]) {
    const tarefas = Array.from({ length: volume.pessoasPorEmpresa }, (_, i) => () => comoTenant(tenant, novaPessoa(tenant, `Carga M3 ${rodada} ${nome} ${i}`, cpfValido(semente + (nome === 'A' ? 0 : 50000) + i))));
    const r = await emParalelo(tarefas, volume.concorrencia);
    porEmpresa[nome] = { ids: r.filter((x) => x.ok).map((x) => x.valor.id), erros: erros(r), ms: r.map((x) => x.ms) };
  }
  const cpf = cpfValido(semente + 99999);
  const disputa = await emParalelo(Array.from({ length: volume.tentativasMesmoCpf }, (_, i) => () => comoTenant(tenantA, novaPessoa(tenantA, `Carga M3 ${rodada} CPF ${i}`, cpf))), volume.tentativasMesmoCpf);
  return { porEmpresa, mesmoCpf: { tentativas: disputa.length, aceitas: disputa.filter((x) => x.ok).length, recusas: contarCodigos(disputa) } };
}

async function faseOportunidades(tenant, pessoas, volume) {
  const base = { groupId: tenant.groupId, companyId: tenant.companyId, stage: 'NEW' };
  const amanha = () => new Date(Date.now() + 86400000);
  const pessoa = (i) => pessoas[i % pessoas.length];
  const com = Array.from({ length: volume.oportunidades }, (_, i) => () => comoTenant(tenant, (t) => opportunitiesService.createOpportunity(
    { ...base, personId: pessoa(i), nextAction: `Ligar (carga ${i})`, nextActionDueAt: amanha() }, tenant.userId, t,
  )));
  const sem = Array.from({ length: volume.oportunidadesSemProximaAcao }, (_, i) => () => comoTenant(tenant, (t) => opportunitiesService.createOpportunity(
    { ...base, personId: pessoa(i) }, tenant.userId, t,
  )));
  const [rc, rs] = [await emParalelo(com, volume.concorrencia), await emParalelo(sem, volume.concorrencia)];
  return {
    ids: rc.filter((x) => x.ok).map((x) => x.valor.id), erros: erros(rc), ms: rc.map((x) => x.ms),
    semProximaAcao: { tentativas: rs.length, aceitas: rs.filter((x) => x.ok).length, recusas: contarCodigos(rs) },
  };
}

/**
 * Dois radares com os mesmos critérios: o de "evento" nasce ANTES das ofertas (as ofertas, criadas em paralelo, disparam o match na hora)
 * e o de "job" nasce DEPOIS (só o job o encontra). Os dois são reprocessados por N execuções SIMULTÂNEAS do job e por mais uma depois.
 */
async function faseRadar(tenant, pessoaId, volume, rodada) {
  const city = `CargaM3${rodada}`;
  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId };
  const novoRadar = async () => (await comoTenant(tenant, (t) => radarService.createRadar({ ...ctx, personId: pessoaId, criteriaJson: { propertyType: 'RESIDENTIAL', offerType: 'SALE', city } }, tenant.userId, t))).radar;
  const radarEvento = await novoRadar();
  const ofertas = await emParalelo(Array.from({ length: volume.imoveisComOferta }, (_, i) => () => comoTenant(tenant, async (t) => {
    const p = await propertiesService.createProperty({ ...ctx, title: `Carga M3 ${rodada} ${i}`, internalCode: `CM3-${rodada}-${i}`, propertyType: 'RESIDENTIAL', city, areaTotalM2: 80 + i }, tenant.userId, t);
    await offersService.createOffer(p.id, { offerType: 'SALE', askingPrice: 300000 + i * 1000 }, tenant.userId, t);
    return p;
  })), volume.concorrencia);
  const radarJob = await novoRadar();
  const radares = [];
  for (const [tipo, radar] of [['evento', radarEvento], ['job', radarJob]]) {
    const reprocessar = () => comoTenant(tenant, async (t) => processRadar(await PropertyRadar.findByPk(radar.id, { transaction: t }), t));
    const n = volume.reprocessamentosSimultaneosDoRadar;
    const avisosAntes = await avisosDoRadar(tenant);
    const simultaneos = await emParalelo(Array.from({ length: n }, () => reprocessar), n);
    const final = await emParalelo([reprocessar], 1);
    const avisosDepois = await avisosDoRadar(tenant);
    radares.push({ tipo, radarId: radar.id, avisosAntes, avisosDepois, reprocessamentos: { simultaneos: n, comErro: erros(simultaneos), finalComErro: erros(final) } });
  }
  return { cidade: city, imoveis: ofertas.filter((x) => x.ok).map((x) => x.valor.id), errosNasOfertas: erros(ofertas), radares };
}

/** Mede as consultas comuns do Marco 3 (`leiturasPorConsulta` vezes cada, em sequência) pelo serviço, com o RLS de runtime. */
async function faseLeituras(tenant, radarId, volume) {
  const consultas = {
    listPersons: (t) => peopleService.listPersons(t, {}),
    listOpportunities: (t) => opportunitiesService.listOpportunities(t, {}),
    getStoredRadarMatches: (t) => radarService.getStoredRadarMatches(radarId, t),
  };
  const saida = {};
  for (const [nome, fn] of Object.entries(consultas)) {
    const tempos = [];
    let linhas = 0;
    for (let i = 0; i < volume.leiturasPorConsulta; i += 1) {
      const t0 = process.hrtime.bigint();
      linhas = (await comoTenant(tenant, fn)).length;
      tempos.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    saida[nome] = { n: tempos.length, linhas, tempos };
  }
  return saida;
}

module.exports = { fasePessoas, faseOportunidades, faseRadar, faseLeituras };
