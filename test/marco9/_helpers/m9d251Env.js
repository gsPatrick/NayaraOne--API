'use strict';

// Apoio da suíte adversarial 1 a 8 (M9-D251): espera o app de teste subir sem dormir mais que 100 ms por vez (relógio simulado, nada de sleep longo), recusa por 413 ou corte da conexão
// e leitura do consumo de memória do processo.

/** Espera o app responder (qualquer status), em passos de 50 ms, até 10 s. `base`: função que devolve a URL base da API. */
async function aguardarApp(base) {
  for (let i = 0; i < 200; i += 1) {
    try { await fetch(`${base()}/v1/__pronto__`); return; } catch { await new Promise((resolve) => { setTimeout(resolve, 50); }); }
  }
  throw new Error('O app de teste não respondeu em 10 s.');
}

/** POST de corpo grande: o servidor pode responder 413 ou cortar a conexão (os dois valem como recusa). Devolve { status } ou { cortada: true }. */
async function postarGrande(url, corpo, headers) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: corpo });
    await res.text();
    return { status: res.status };
  } catch { return { cortada: true }; }
}
const recusado = (r) => r.status === 413 || r.cortada === true;

const rssMiB = () => Math.round(process.memoryUsage().rss / 1048576);

module.exports = { aguardarApp, postarGrande, recusado, rssMiB };
