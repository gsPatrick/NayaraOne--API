'use strict';

/**
 * Parâmetros "só da plataforma" (M9-D870, reabertura R3-M1): chaves do dicionário que decidem destino de rede, host de fornecedor ou política de saída. Levam
 * `platformOnly: true` no SETTINGS_SCHEMA e só gravam quando quem chama declara a permissão `integration:platform` (`options.platform === true` em `upsertSetting`).
 * A regra vive na camada de escrita do serviço de parâmetros, então vale para todo caminho: PUT /settings, PATCH /feature-flags com gravação nos parâmetros, importação,
 * seeds e scripts. Falha fechada: quem não declara a plataforma é recusado.
 */
const PLATFORM_PERMISSION = 'integration:platform';

/** Devolve o dicionário com `platformOnly: true` em cada entrada. */
const markPlatformOnly = (schema) => Object.freeze(Object.fromEntries(Object.entries(schema).map(([key, spec]) => [key, { ...spec, platformOnly: true }])));

const isPlatformOnly = (spec) => Boolean(spec && spec.platformOnly === true);

/** Opções de gravação de quem chega com a sessão HTTP (permissões já validadas pelo login). */
const optionsFromAuth = (auth) => ({ platform: Boolean(auth && Array.isArray(auth.permissions) && auth.permissions.includes(PLATFORM_PERMISSION)) });

module.exports = { PLATFORM_PERMISSION, markPlatformOnly, isPlatformOnly, optionsFromAuth };
