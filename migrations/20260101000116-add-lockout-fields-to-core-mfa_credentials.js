'use strict';

/**
 * Migration: adiciona campos de política de tentativas falhas e reconhecimento de dispositivo
 * a "core"."mfa_credentials".
 *
 * DECISÃO DE ENGENHARIA — não especificado no Caderno: o Caderno pede "tentativas repetidas/
 * falhas conforme política" e "comportamento de novo dispositivo em ação crítica", sem definir
 * o limite de tentativas nem o mecanismo de reconhecimento de dispositivo. Adotamos:
 *   - `failed_attempts`: contador de tentativas de `verify`/`disable` com código inválido,
 *     resetado a cada sucesso. Após 5 falhas seguidas (ver mfa.service.js MAX_FAILED_ATTEMPTS),
 *     bloqueia novas tentativas por `locked_until` (15 minutos) — fail closed, nunca deixa
 *     tentativa ilimitada de força bruta contra o TOTP/código de recuperação.
 *   - `last_device_fingerprint`: hash (SHA-256) do User-Agent + IP da última verificação MFA
 *     bem-sucedida — não é uma solução de device-fingerprinting robusta (não há client-side
 *     fingerprint/cookie dedicado neste marco), mas permite DETECTAR e AUDITAR quando uma
 *     verificação vem de um dispositivo/rede diferente do último conhecido, sem bloquear a
 *     ação (evita bloquear o usuário legítimo atrás de um IP dinâmico/rede corporativa com
 *     NAT) — fica registrado em auditoria como sinal para revisão humana.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'mfa_credentials', schema: 'core' },
      'failed_attempts',
      { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 }
    );
    await queryInterface.addColumn(
      { tableName: 'mfa_credentials', schema: 'core' },
      'locked_until',
      { type: Sequelize.DATE, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'mfa_credentials', schema: 'core' },
      'last_device_fingerprint',
      { type: Sequelize.STRING(64), allowNull: true }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'mfa_credentials', schema: 'core' }, 'failed_attempts');
    await queryInterface.removeColumn({ tableName: 'mfa_credentials', schema: 'core' }, 'locked_until');
    await queryInterface.removeColumn({ tableName: 'mfa_credentials', schema: 'core' }, 'last_device_fingerprint');
  },
};
