'use strict';

/** M9-D706 — pasta de evidência da esteira do BI (resumo.json + log da etapa 11) para o portão do sprint B9. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CARGA = 'm9d699 dashboard pesado não degrada OLTP em teste de carga';
const P95 = 'm9d699 p95 dos painéis dentro das metas sob a carga';

function montarEsteira({ status = {}, fim = new Date().toISOString(), fase = 'pr', logEtapa11 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d706-esteira-'));
  const etapas = [];
  for (let n = 1; n <= 14; n += 1) {
    const dentro = n <= 11;
    etapas.push({ n, chave: `e${n}`, livro: `etapa ${n}`, fase: dentro ? 'pr' : 'promocao', status: dentro ? (status[n] || 'APROVADA') : 'FORA_DA_FASE', fim, log: `etapa-${n}.log` });
  }
  fs.writeFileSync(path.join(dir, 'resumo.json'), JSON.stringify({ fase, ok: true, reprovadaNaEtapa: null, etapas }));
  fs.writeFileSync(path.join(dir, 'etapa-11.log'), logEtapa11 === undefined ? `✔ ${CARGA} (10ms)\n✔ ${P95} (20ms)\n` : logEtapa11);
  return { dir, limpar: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { montarEsteira, CARGA, P95 };
