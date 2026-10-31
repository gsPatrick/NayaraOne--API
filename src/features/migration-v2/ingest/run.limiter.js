'use strict';

/**
 * Teto global de execuções rodando ao mesmo tempo neste processo da API (parâmetro `migracao.execucao.max_no_processo`; auditoria M3). Quem não consegue vaga deixa a execução
 * em QUEUED: o job de retomada (migrationRunJob) a pega depois. O contador é do processo; cada instância da API tem o seu.
 */
let active = 0;

function tryAcquire(max) {
  if (active >= max) return false;
  active += 1;
  return true;
}

function release() {
  active = Math.max(0, active - 1);
}

const current = () => active;

module.exports = { tryAcquire, release, current };
