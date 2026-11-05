'use strict';

// Datas de teste derivadas da execução. Os serviços gravam created_at/occurred_at com o relógio
// real; um "agora" fixo no teste fica, com o passar dos dias, ANTES desses registros e a janela
// (90 dias, cooldown, cap de 7 dias…) deixa de enxergá-los. Aqui o "agora" do cenário é sempre
// alguns dias à frente do relógio real, preservando hora do dia e dia da semana do cenário.

const DIA_MS = 86400000;

/** 'YYYY-MM-DD' (UTC) de hoje + deltaDias. */
function diaUtc(deltaDias = 0) {
  return new Date(Date.now() + deltaDias * DIA_MS).toISOString().slice(0, 10);
}

/** Soma dias a um 'YYYY-MM-DD'. */
function somaDias(dia, n) {
  return new Date(Date.parse(`${dia}T00:00:00Z`) + n * DIA_MS).toISOString().slice(0, 10);
}

/** Primeira data (UTC) com o dia da semana pedido (0 = domingo … 6 = sábado) a partir de hoje + minDias. */
function proximoDiaDaSemana(diaDaSemana, minDias = 0) {
  const base = diaUtc(minDias);
  const atual = new Date(`${base}T00:00:00Z`).getUTCDay();
  return somaDias(base, (diaDaSemana - atual + 7) % 7);
}

/** Date em `dia` (YYYY-MM-DD) + deltaDias, no horário UTC 'HH:MM:SS.mmm' ou 'HH:MM:SS'. */
function instante(dia, horaUtc, deltaDias = 0) {
  return new Date(`${somaDias(dia, deltaDias)}T${horaUtc}Z`);
}

module.exports = { DIA_MS, diaUtc, somaDias, proximoDiaDaSemana, instante };
