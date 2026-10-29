'use strict';

// M9-D044 (estágio 2, typecheck): tipos JSDoc dos três contratos da NAY, conferidos por `npm run typecheck:ai`
// (tsc --noEmit --allowJs --checkJs). Este arquivo só declara tipos (typedefs globais do programa de checagem) e não exporta nada.

/** @typedef {'READ' | 'WRITE'} ToolCategory */
/** @typedef {'FINANCIAL' | 'LEGAL' | 'BANKING' | 'PERMISSION' | 'PUBLICATION' | 'OTHER'} ToolDomain */

/**
 * Definição de uma tool (contrato do ToolRegistry, M9-D016).
 * @typedef {object} ToolDefinition
 * @property {string} name
 * @property {number} version
 * @property {string} description
 * @property {string} permissionCode
 * @property {string} riskLevel
 * @property {ToolCategory} category
 * @property {ToolDomain} domain
 * @property {{ type: 'object', [chave: string]: any }} inputSchema
 * @property {{ type: 'object', [chave: string]: any }} outputSchema
 * @property {boolean} requiresHumanApproval
 * @property {boolean} idempotent
 * @property {(ctx: any, input: any) => any} execute
 * @property {string} [servicePermissionCode]
 * @property {'INFORMATIVE'} [servicePath]
 * @property {Array<{ arg: string, entity: string }>} [entityRefs]
 */

/**
 * @typedef {object} ProviderMessage
 * @property {'system' | 'user' | 'assistant' | 'tool'} role
 * @property {string} content
 */

/**
 * Pedido de geração ao adapter de modelo (contrato do AIProviderAdapter, M9-D010).
 * @typedef {object} ProviderGenerateRequest
 * @property {string} model
 * @property {string} [system]
 * @property {ProviderMessage[]} messages
 * @property {any[]} [tools]
 * @property {object} [responseSchema]
 * @property {number} maxOutputTokens
 * @property {number} [temperature]
 * @property {number} [timeoutMs]
 * @property {string} [correlationId]
 * @property {string} [idempotencyKey]
 */

/**
 * @typedef {object} ModelCatalogEntry
 * @property {string} model
 * @property {string} [classe]
 * @property {boolean} [generate]
 * @property {boolean} [embed]
 * @property {boolean} [transcribe]
 * @property {boolean} [vision]
 * @property {number} [maxInputTokens]
 */

/**
 * Entrada do orquestrador (M9-D020).
 * @typedef {object} RunInput
 * @property {string} agentCode
 * @property {string} purpose
 * @property {any} input
 * @property {string} [taskType]
 * @property {string} [idempotencyKey]
 * @property {string} [correlationId]
 */

/**
 * @typedef {object} RunAuth
 * @property {string} userId
 * @property {string} groupId
 * @property {string} [companyId]
 * @property {string[]} permissions
 * @property {string[]} [roles]
 */
