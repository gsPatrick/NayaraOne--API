'use strict';

const AppError = require('../../../utils/AppError');

/**
 * SLO específico por criticidade (Marco 9, M9-D225; livro, seção 17: "SLO específico por criticidade; não usar uma meta única").
 * A meta de cada criticidade é o parâmetro `integration.slo.<CRITICIDADE>` (sucesso mínimo em 30 dias, latência p95 e p99, atraso máximo da
 * fila). O livro não fixa números: os padrões estão em sloParse.js e o administrador os edita dentro do piso e do teto abaixo.
 */
const SLO_SUCCESS_FLOOR = 90;
const SLO_SUCCESS_CEILING = 99.99;

const outOfRange = (key, value) => AppError.unprocessable('Meta de SLO fora do intervalo permitido.', 'INTEGRATION_SLO_OUT_OF_RANGE', { key, value, min: SLO_SUCCESS_FLOOR, max: SLO_SUCCESS_CEILING });

/** Recusa (422 INTEGRATION_SLO_OUT_OF_RANGE) a meta com sucesso fora do piso e do teto, ou com p99 menor que p95. */
function assertSloInRange(key, value, slo) {
  const { minSuccessRate: pct, p95Ms, p99Ms, backlogMin } = slo;
  if (pct < SLO_SUCCESS_FLOOR || pct > SLO_SUCCESS_CEILING || p95Ms <= 0 || p99Ms < p95Ms || backlogMin <= 0) throw outOfRange(key, value);
}

const round2 = (n) => Math.round(n * 100) / 100;
const maxOf = (values) => {
  const v = values.filter((x) => x !== null && x !== undefined).map(Number);
  return v.length ? Math.max(...v) : null;
};

/**
 * Julga o período contra a meta. `points`: janelas agregadas { callsTotal, callsSuccess, latencyP95Ms, latencyP99Ms } (as chamadas já
 * excluem o erro de VALIDATION, que é dado nosso). `backlogOldestMin`: há quantos minutos o envio vencido mais antigo espera (0 = fila em dia).
 * Sem chamadas não existe taxa (null) e a taxa não julga; a latência é a da pior janela (conservador: um percentil mensal exato não
 * se refaz a partir de percentis diários). `violated` é null só quando não há nenhum dado para julgar.
 */
function evaluateSlo({ target, points, backlogOldestMin }) {
  const total = points.reduce((s, p) => s + Number(p.callsTotal || 0), 0);
  const ok = points.reduce((s, p) => s + Number(p.callsSuccess || 0), 0);
  const p95 = maxOf(points.map((p) => p.latencyP95Ms));
  const p99 = maxOf(points.map((p) => p.latencyP99Ms));
  const backlog = backlogOldestMin === null || backlogOldestMin === undefined ? null : Number(backlogOldestMin);
  const compliance = {
    successRate: total === 0 ? null : (ok / total) * 100 >= target.minSuccessRate,
    latencyP95: p95 === null ? null : p95 <= target.p95Ms,
    latencyP99: p99 === null ? null : p99 <= target.p99Ms,
    backlog: backlog === null ? null : backlog <= target.backlogMin,
  };
  const julgados = Object.values(compliance).filter((v) => v !== null);
  return {
    measured: {
      callsTotal: total, callsSuccess: ok, callsFailed: total - ok, successRate: total === 0 ? null : round2((ok / total) * 100),
      latencyP95Ms: p95, latencyP99Ms: p99, backlogOldestMin: backlog,
    },
    compliance,
    violated: julgados.length === 0 ? null : julgados.includes(false),
  };
}

/** `integration.slo.<CRITICIDADE>`: a edição exige integration:manage além de settings:update (rota de parâmetros). */
const isSloSettingKey = (key) => /^integration\.slo\.(CRITICAL|HIGH|MEDIUM|LOW)$/.test(String(key));

module.exports = { isSloSettingKey, SLO_SUCCESS_FLOOR, SLO_SUCCESS_CEILING, assertSloInRange, evaluateSlo, outOfRange };
