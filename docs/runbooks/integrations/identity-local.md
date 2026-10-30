# Runbook da integração identity-local

Família: Identidade e autenticação (IDENTITY). A autenticação própria do sistema (login por e-mail e senha, token de acesso JWT com sessão em core.sessions e MFA) atrás do port de identidade. É o adapter padrão e o fallback natural quando um provedor externo de login cai.

## 1. O que é e criticidade

Valida o token de acesso do próprio sistema (assinatura HS256, emissor, público, validade e não-antes obrigatórios, tolerância de relógio configurável), confere se a sessão está ativa e revoga sessões. Não fala com nenhum serviço externo. Criticidade padrão da família: CRITICAL (parâmetro integration.catalog.criticality.identity). Efeito de uma queda: ninguém consegue entrar nem manter a sessão no sistema.

## 2. Sintomas e alertas

- Aumento de 401 INVALID_ACCESS_TOKEN, SESSION_INVALID ou INTEGRATION_IDENTITY_TOKEN_INVALID.
- Usuários relatando que caem do sistema logo após entrar (relógio do servidor fora de hora, segredo do token trocado).
- 403 INTEGRATION_IDENTITY_FALLBACK_DENIED: o provedor externo de identidade está fora e a política não libera o login local para aquele usuário.
- Aviso de contingência ativada na família IDENTITY.

Os alertas chegam pelo motor de notificações aos papéis configurados (parâmetros integration.alert.*) e cada um aponta para este documento. Alertas possíveis: PROVIDER_DOWN, ERROR_RATE_UP, AUTH_FAILURE, SECRET_EXPIRING, SYNC_STALLED e QUOTA_LOW.

## 3. Diagnóstico passo a passo

1. Conferir a hora do servidor (a validade e o não-antes do token dependem dela) e a variável JWT_ACCESS_SECRET; trocar o segredo derruba todas as sessões ativas.
2. Abrir Integrações > Saúde e a lista de contingências ativas: se houver provedor externo de identidade configurado, ver o motivo (sem integração ativa, circuito aberto ou saúde em DOWN).
3. Conferir a política em Configurações > Registro de integrações > Identidade: login local na contingência ligado, administradores liberados e a lista de papéis tratados como administrador.
4. Consultar a auditoria pela ação integration.identity.local_fallback_used para ver quem entrou pelo acesso local durante a contingência.
5. Para sessão revogada indevidamente, conferir core.sessions (revoked_at) e pedir novo login; o refresh token revogado não renova.

## 4. Contingência

Modo de contingência da família: PRESERVE_AND_ALTERNATE_FLOW (INT-015). Com o provedor externo de identidade fora, o login local pelo identity-local segue para os administradores (parâmetros integration.identity.local_fallback_enabled e integration.identity.local_fallback_admin_enabled; papéis em integration.identity.local_fallback_admin_roles) e é auditado; os demais usuários recebem 403 INTEGRATION_IDENTITY_FALLBACK_DENIED até o provedor voltar. Empresa sem provedor externo não tem contingência: a autenticação própria é o estado normal. Referência: M9-D226 e M9-D242.

## 5. Como rotacionar credencial

O identity-local não usa credencial de fornecedor. O segredo de assinatura dos tokens (JWT_ACCESS_SECRET) é variável de ambiente do servidor: trocá-lo invalida todos os tokens emitidos e exige novo login de todos; combinar janela, avisar os usuários e trocar fora do horário comercial. A senha de cada usuário é trocada pela tela de perfil ou pelo administrador de usuários.

## 6. Quem acionar

Administrador do sistema (usuários, sessões e política de acesso local) e administrador de infraestrutura (relógio e variáveis do servidor). As pessoas são as que ocupam essas funções no momento; este runbook não guarda nomes nem telefones. Se a função estiver vaga, escalar à diretoria.

## 7. Como validar a recuperação

Um login de teste com o usuário administrador entra, o token novo é aceito em uma rota protegida e o refresh renova a sessão. Se havia provedor externo fora, o teste de saúde dele volta a ok por três verificações seguidas, a contingência da família IDENTITY é encerrada e o login local volta a valer para todos. Registrar o horário de normalização e os acessos locais auditados durante a contingência.
