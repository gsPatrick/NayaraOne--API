'use strict';

/** M9-D255 — executa `fn(i)` para i de 0 a n-1 com no máximo `limite` chamadas ao mesmo tempo; devolve os resultados na ordem de i. */
async function rodarEmPool(n, limite, fn) {
  const saida = new Array(n);
  let proximo = 0;
  const trabalhador = async () => {
    for (let i = proximo; i < n; i = proximo) {
      proximo += 1;
      saida[i] = await fn(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, n) }, trabalhador));
  return saida;
}

/** Sequência determinística (LCG) para embaralhar sem aleatoriedade: a mesma carga sai igual a cada execução. */
function embaralhar(lista, semente = 255) {
  let s = semente;
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

module.exports = { rodarEmPool, embaralhar };
