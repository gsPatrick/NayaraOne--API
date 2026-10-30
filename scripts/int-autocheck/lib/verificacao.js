'use strict';

/** Ajudantes das verificações da autochecagem (M9-D258): uma verificação é { nome, ok, detalhes } e só é ok sem nenhum detalhe de falha. */
const verificacao = (nome, falhas) => ({ nome, ok: falhas.length === 0, detalhes: falhas });

/** Demandas do escopo que não estão `verificada` (só o verificador independente marca assim). */
function naoVerificadas(amb, ids) {
  const por = new Map(amb.demandas().map((d) => [d.id, d]));
  return ids.filter((id) => !por.has(id) || por.get(id).status !== 'verificada').map((id) => `${id} está ${por.has(id) ? por.get(id).status || 'sem status' : 'ausente'}`);
}

/** M9-D200 a M9-D210 -> ['M9-D200', ...]. */
const faixa = (de, ate) => Array.from({ length: ate - de + 1 }, (_, i) => `M9-D${String(de + i).padStart(3, '0')}`);

/** Falhas de estrutura das demandas do escopo (12 seções não vazias, dependências existentes): as do demandas-check.js, sem erro. */
function falhasDasDemandas(amb, esc) {
  const doEscopo = amb.demandas().filter((d) => esc.demandas.test(d.id) || d.id === '(demandas)');
  if (!doEscopo.length) return [`nenhuma demanda ${esc.faixa} encontrada`];
  return doEscopo.flatMap((d) => (d.erros || []).map((e) => `${d.id}: ${e}`));
}

/** Falhas do mapa de passos e sprints (cobertura sem órfã, ordem que respeita as dependências). */
function falhasDoMapa(mapa) {
  if (mapa.erro) return [`mapa de passos e sprints: ${mapa.erro}`];
  return [
    ...mapa.semSprint.map((id) => `${id}: demanda órfã (fora de todos os sprints)`),
    ...mapa.emVarios.map((x) => `${x.id}: em mais de um sprint (${x.sprints.join(', ')})`),
    ...mapa.inexistentes.map((id) => `${id}: o mapa cita demanda sem arquivo`),
    ...mapa.passosSemDestino.map((n) => `passo ${n} sem demanda ou com demanda fora dos sprints`),
    ...mapa.dependenciasIncoerentes.map((x) => `${x.id} (${x.sprint}) depende de ${x.dependencia}, do sprint posterior ${x.sprintDaDependencia}`),
    ...mapa.ciclos.map((c) => `dependência circular entre ${c}`),
  ];
}

module.exports = { verificacao, naoVerificadas, faixa, falhasDasDemandas, falhasDoMapa };
