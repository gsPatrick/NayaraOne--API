'use strict';

/**
 * M9-D706 (critério transferido da M9-D705) — o portão do sprint B9 exige a evidência da esteira do BI (`node scripts/analytics/ci/run.js
 * --fase pr`): resumo.json com as 11 etapas APROVADAS, etapa 11 (carga e rebuild) com os dois testes de carga verdes no log e a evidência
 * recente. A idade máxima é parâmetro (`--idade-max-horas`); o padrão é o mais conservador (24 h).
 */
const fs = require('node:fs');
const path = require('node:path');

const PADRAO_DIR = path.join(__dirname, '..', '..', '..', 'docs', 'evidencias', 'ci', 'bi-pipeline');
const IDADE_PADRAO_HORAS = 24;
const TESTES_DA_ETAPA_11 = [
  'm9d699 dashboard pesado não degrada OLTP em teste de carga',
  'm9d699 p95 dos painéis dentro das metas sob a carga',
];

const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const passou = (log, nome) => new RegExp(`^\\s*(?:✔|ok \\d+ -)\\s+${escapar(nome)}(?:\\s|$)`, 'm').test(log);

const TODAS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** `etapas`: quais etapas precisam estar APROVADAS (o B9 exige as 11; o DoD, item 11, as etapas 4, 6, 7 e 11). */
function avaliarEsteira({ dir = PADRAO_DIR, idadeMaximaHoras = IDADE_PADRAO_HORAS, agora = () => new Date(), etapas: exigidas = TODAS } = {}) {
  const arq = path.join(dir, 'resumo.json');
  if (!fs.existsSync(arq)) return { ok: false, motivos: [`sem evidência da esteira do BI: ${arq} não existe (rode node scripts/analytics/ci/run.js --fase pr)`] };
  let resumo;
  try { resumo = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return { ok: false, motivos: [`resumo da esteira ilegível: ${arq}`] }; }
  const motivos = [];
  if (!['pr', 'tudo'].includes(resumo.fase)) motivos.push(`fase da esteira "${resumo.fase}": só a fase pr ou tudo cobre as etapas 1 a 11`);
  const etapas = Array.isArray(resumo.etapas) ? resumo.etapas : [];
  for (const n of exigidas) {
    const e = etapas.find((x) => x.n === n);
    if (!e) motivos.push(`etapa ${n}: ausente no resumo`);
    else if (e.status !== 'APROVADA') motivos.push(`etapa ${n}: ${e.status}`);
  }
  const e11 = etapas.find((x) => x.n === 11);
  if (exigidas.includes(11) && e11 && e11.status === 'APROVADA') {
    const logArq = path.join(dir, String(e11.log || ''));
    const log = e11.log && fs.existsSync(logArq) ? fs.readFileSync(logArq, 'utf8') : '';
    for (const nome of TESTES_DA_ETAPA_11) if (!passou(log, nome)) motivos.push(`etapa 11: o log não mostra "${nome}" verde`);
    const horas = (agora().getTime() - new Date(e11.fim).getTime()) / 3600000;
    if (!Number.isFinite(horas) || horas > idadeMaximaHoras) motivos.push(`etapa 11: evidência com mais de ${idadeMaximaHoras} h (rode a esteira de novo)`);
  }
  return { ok: motivos.length === 0, motivos };
}

module.exports = { avaliarEsteira, PADRAO_DIR, IDADE_PADRAO_HORAS, TESTES_DA_ETAPA_11 };
