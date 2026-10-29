'use strict';

/**
 * M9-D409 — redução de preço, em aritmética inteira exata (centavos em BigInt; nunca float). Só queda conta: preço novo menor que
 * o anterior. O percentual é arredondado meio para cima, uma única vez, com o número de casas do parâmetro (padrão 2: 800.000 ->
 * 780.000 = 2,50%).
 */
const toCents = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? BigInt(Math.round(number * 100)) : null;
};

/** { isReduction, percent: '2,50', percentValue: '2.50' } ou { isReduction: false } (aumento, igual ou valor inválido). */
function reductionPercent(previousPrice, newPrice, decimals = 2) {
  const old = toCents(previousPrice);
  const now = toCents(newPrice);
  if (old === null || now === null || old <= 0n || now < 0n || now >= old) return { isReduction: false };
  const scale = 10n ** BigInt(decimals);
  const scaled = ((old - now) * 100n * scale * 2n + old) / (2n * old); // meio para cima
  const whole = scaled / scale;
  const fraction = decimals > 0 ? String(scaled % scale).padStart(decimals, '0') : '';
  return {
    isReduction: true,
    percent: decimals > 0 ? `${whole},${fraction}` : String(whole),
    percentValue: decimals > 0 ? `${whole}.${fraction}` : String(whole),
  };
}

/** Preço vigente do imóvel: a venda quando existe; senão a locação (a visão pública calcula o anterior sobre essa mesma oferta). */
function currentPriceOf(facts) {
  const sale = facts && facts.precoVenda;
  if (sale !== null && sale !== undefined) return sale;
  const rent = facts && facts.precoLocacao;
  return rent === null || rent === undefined ? null : rent;
}

module.exports = { reductionPercent, currentPriceOf, toCents };
