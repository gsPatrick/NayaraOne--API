'use strict';

/**
 * M9-D614 — passo de CI "guardas do Não improvisar": roda as regras 1, 2, 3, 5 e 6 (as que só leem arquivos) e sai com código 1 citando
 * a regra violada pelo número. As regras 4 e 7 rodam no teste m9d614 (precisam de banco e servidor). Sem flag para desligar.
 */
const { runStaticGuards, formatViolation } = require('./guardrails');

const { violations } = runStaticGuards();
if (violations.length) {
  violations.forEach((v) => console.error(formatViolation(v)));
  process.exit(1);
}
console.log('OK: guardas 1, 2, 3, 5 e 6 do "Não improvisar" sem violação.');
