'use strict';

/**
 * CHECK criada NOT VALID (vale para toda linha nova ou alterada) é VALIDADA na mesma migration quando nenhuma linha antiga a viola.
 * Verificador independente da integração (14/11/2026): CHECK que fica NOT VALID sem motivo faz uma linha antiga que já a viole falhar
 * em qualquer UPDATE, sem ninguém saber. A validação roda em SAVEPOINT: se uma linha antiga viola, a CHECK continua NOT VALID, a
 * migration segue e a linha de log diz qual (para a decisão no roteiro de deploy). `q(sql)` executa na transação da migration.
 */
async function validarSeLimpo(q, tabela, constraint, rotulo) {
  await q('SAVEPOINT validar_se_limpo');
  try {
    await q(`ALTER TABLE ${tabela} VALIDATE CONSTRAINT ${constraint}`);
    await q('RELEASE SAVEPOINT validar_se_limpo');
    return true;
  } catch (erro) {
    await q('ROLLBACK TO SAVEPOINT validar_se_limpo');
    if (!erro || !erro.original || erro.original.code !== '23514') throw erro;
    console.log(`[${rotulo}] ${tabela}.${constraint}: há linha antiga fora da regra — a CHECK continua NOT VALID (vale para linha nova ou alterada).`);
    return false;
  }
}

module.exports = { validarSeLimpo };
