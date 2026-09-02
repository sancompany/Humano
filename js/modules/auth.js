/**
 * SAN & CO. — js/modules/auth.js
 * Autenticação e trava de sessão (Zero-Trust).
 *
 * ATENÇÃO: este arquivo NÃO segue o contrato de módulo de rota
 * ({ id, title, render, mount, unmount }). Ele é um serviço, não uma tela.
 * Exporta funções nomeadas e é inicializado uma única vez pelo app.js,
 * antes do roteador.
 *
 * O QUE ELE FAZ
 *   - Trava a sessão por inatividade (padrão: 2 minutos).
 *   - Trava a sessão quando a aba sai de foco, para proteger a miniatura que
 *     o alternador de apps do celular tira da tela.
 *   - Aplica blur de 12px sobre o conteúdo e sobe um overlay de desbloqueio.
 *   - Desbloqueia por biometria (WebAuthn) ou PIN.
 *
 * MODO DE DESENVOLVIMENTO
 *   Com DEV_MODE = true nada disso é armado: a sessão nasce autenticada e
 *   nunca trava sozinha, para você poder recarregar a página à vontade
 *   enquanto desenha as telas. Para testar a trava sem desligar a flag,
 *   chame no console:  SANCO_AUTH.lockSession()
 */

import { estado } from '../state.js';

/* ------------------------------------------------------------------
   1. CONFIGURAÇÃO
------------------------------------------------------------------ */

/** >>> TROCAR PARA false ANTES DE PUBLICAR <<< */
const DEV_MODE = true;

/** Minutos de inatividade até travar. */
const MINUTOS_INATIVIDADE = 2;

/**
 * SÓ PARA TESTE EM APARELHO. Com DEV_MODE ligado e esta flag em true,
 * verifyBiometrics() chama o WebAuthn de verdade usando um desafio gerado
 * no próprio navegador — o suficiente para a digital/face aparecer na tela
 * e você validar a experiência.
 *
 * ISTO NÃO É SEGURANÇA. Desafio gerado no cliente não protege contra
 * replay: qualquer um que capture a resposta pode reenviá-la. Serve para
 * ver o prompt, nada além disso. O fluxo real depende do backend.
 *
 * Exige contexto seguro (https ou localhost).
 */
const DEV_BIOMETRIA_LOCAL = false;

/** Travar quando a aba/app sai de foco. */
const TRAVAR_AO_SAIR = true;

/** Intervalo mínimo entre dois reinícios do contador, em ms (evita reiniciar
 *  o timer a cada pixel de scroll). */
const THROTTLE_ATIVIDADE = 5000;

/** Classe aplicada ao <body> enquanto a sessão está travada. */
const CLASSE_TRAVA = 'app-locked';

/** Endpoint que emite o desafio do WebAuthn. Vai viver no backend/routes/. */
const ENDPOINT_DESAFIO = '/api/auth/desafio';

/**
 * Hash SHA-256 do PIN de acesso, em hexadecimal.
 * Null enquanto o fluxo de cadastro não existir — com null, o desbloqueio
 * por PIN sempre recusa.
 *
 * Para gerar um hash de teste, cole no console:
 *   SANCO_AUTH.gerarHashPin('123456').then(console.log)
 */
const PIN_HASH = null;

/**
 * Hash SHA-256 do PIN de pânico.
 * O comportamento do pânico ainda NÃO foi definido — hoje apenas emite o
 * evento `sanco:panico`. Ver acionarPanico() no fim do arquivo.
 */
const PIN_PANICO_HASH = null;

/* ------------------------------------------------------------------
   2. ESTADO INTERNO
------------------------------------------------------------------ */
let iniciado = false;
let temporizador = null;
let minutosConfigurados = MINUTOS_INATIVIDADE;
let ultimaAtividade = 0;
let overlay = null;
let elementoFocadoAntes = null;

const EVENTOS_ATIVIDADE = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'focusin'];

/**
 * O que fica inerte com a sessão travada. O `.status` do header fica de fora
 * de propósito: ele não é clicável e precisa continuar legível pelo leitor de
 * tela para anunciar "Bloqueado". O logo entra porque é um link e trocaria a
 * rota por trás do desfoque.
 */
const SELETORES_CONGELADOS = ['#app-content', '#app-nav', '.app-header .logo'];

/** Liga/desliga a inércia de tudo que não é o overlay. */
function congelarInterface(travar) {
  SELETORES_CONGELADOS.forEach((seletor) => {
    const elemento = document.querySelector(seletor);
    if (elemento) elemento.inert = travar;
  });
}

/* ------------------------------------------------------------------
   3. UTILITÁRIOS
------------------------------------------------------------------ */

/** Atualiza o indicador do header sem acoplar este arquivo ao app.js. */
function status(label, tone) {
  document.dispatchEvent(new CustomEvent('sanco:status', { detail: { label, tone } }));
}

/** SHA-256 de uma string, devolvido em hexadecimal. */
export async function gerarHashPin(texto) {
  const bytes = new TextEncoder().encode(String(texto));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** base64url -> Uint8Array (formato que o WebAuthn exige). */
function base64UrlParaBytes(texto) {
  const base64 = texto.replace(/-/g, '+').replace(/_/g, '/');
  const preenchido = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binario = atob(preenchido);
  return Uint8Array.from(binario, (c) => c.charCodeAt(0));
}

/* ------------------------------------------------------------------
   4. OVERLAY DE DESBLOQUEIO
------------------------------------------------------------------ */
function construirOverlay() {
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.className = 'lock-overlay';
  overlay.id = 'app-lock';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Sessão bloqueada');

  overlay.innerHTML = `
    <div class="lock-card">
      <img class="lock-card__mark" src="assets/logo/logo-sanco.svg" alt="" width="44" height="44">
      <p class="lock-card__title">Sessão bloqueada</p>
      <p class="lock-card__desc" data-lock="motivo">Confirme sua identidade para continuar.</p>

      <button class="btn btn--gold" type="button" data-lock="biometria">
        Desbloquear com biometria
      </button>

      <div class="lock-pin">
        <label class="lock-pin__label" for="lock-pin-input">Ou use seu PIN</label>
        <div class="lock-pin__row">
          <input class="lock-pin__input" id="lock-pin-input" type="password"
                 inputmode="numeric" autocomplete="off" maxlength="12"
                 placeholder="••••••">
          <button class="btn" type="button" data-lock="pin">Entrar</button>
        </div>
      </div>

      <p class="lock-card__erro" data-lock="erro" role="alert" hidden></p>
    </div>
  `;

  // biometria
  overlay.querySelector('[data-lock="biometria"]').addEventListener('click', async () => {
    mostrarErro('');
    const ok = await unlockSession();
    if (!ok) mostrarErro('Não foi possível confirmar sua identidade.');
  });

  // PIN
  const campoPin = overlay.querySelector('[data-lock="pin"]');
  const inputPin = overlay.querySelector('#lock-pin-input');

  const enviarPin = async () => {
    mostrarErro('');
    const ok = await unlockComPin(inputPin.value);
    inputPin.value = '';
    if (!ok) mostrarErro('PIN incorreto.');
  };

  campoPin.addEventListener('click', enviarPin);
  inputPin.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') enviarPin();
  });

  // enquanto travado, o foco não escapa do overlay
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focaveis = overlay.querySelectorAll('button, input');
    const primeiro = focaveis[0];
    const ultimo = focaveis[focaveis.length - 1];
    if (e.shiftKey && document.activeElement === primeiro) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && document.activeElement === ultimo) {
      e.preventDefault();
      primeiro.focus();
    }
  });

  document.body.appendChild(overlay);
  return overlay;
}

function mostrarErro(mensagem) {
  const alvo = overlay?.querySelector('[data-lock="erro"]');
  if (!alvo) return;
  alvo.textContent = mensagem;
  alvo.hidden = !mensagem;
}

function definirMotivo(motivo) {
  const alvo = overlay?.querySelector('[data-lock="motivo"]');
  if (!alvo) return;
  const textos = {
    inatividade: 'Você ficou um tempo sem interagir. Confirme sua identidade para continuar.',
    ausencia: 'O app saiu de foco. Confirme sua identidade para continuar.',
    inicial: 'Confirme sua identidade para abrir o painel.',
    manual: 'Confirme sua identidade para continuar.'
  };
  alvo.textContent = textos[motivo] || textos.manual;
}

/* ------------------------------------------------------------------
   5. TRAVA E DESTRAVA
------------------------------------------------------------------ */

/**
 * Trava a sessão: blur no conteúdo, overlay por cima, conteúdo inerte.
 * @param {'inatividade'|'ausencia'|'inicial'|'manual'} motivo
 */
export function lockSession(motivo = 'manual') {
  if (estado.bloqueado) return;

  construirOverlay();
  clearTimeout(temporizador);
  temporizador = null;

  elementoFocadoAntes = document.activeElement;

  congelarInterface(true);   // bloqueia clique, foco e leitor de tela

  document.body.classList.add(CLASSE_TRAVA);
  overlay.hidden = false;

  definirMotivo(motivo);
  estado.bloqueado = true;
  status('Bloqueado', 'offline');

  overlay.querySelector('[data-lock="biometria"]').focus();
}

/** Remove a trava. Uso interno — o caminho público é unlockSession(). */
function destravar() {
  congelarInterface(false);

  document.body.classList.remove(CLASSE_TRAVA);
  if (overlay) overlay.hidden = true;
  mostrarErro('');

  estado.bloqueado = false;
  estado.autenticado = true;
  status('Sessão ativa', 'secure');

  elementoFocadoAntes?.focus?.();
  elementoFocadoAntes = null;

  resetInactivityTimer(minutosConfigurados);
}

/**
 * Desbloqueia após validação biométrica.
 * @returns {Promise<boolean>} true se a sessão foi liberada
 */
export async function unlockSession() {
  const ok = await verifyBiometrics();
  if (!ok) return false;
  destravar();
  return true;
}

/**
 * Desbloqueia por PIN. Se o PIN informado for o de pânico, aciona o
 * procedimento de pânico em vez de abrir a sessão normalmente.
 * @param {string} pin
 * @returns {Promise<boolean>}
 */
export async function unlockComPin(pin) {
  if (DEV_MODE) {
    destravar();
    return true;
  }
  if (!pin) return false;

  const hash = await gerarHashPin(pin);

  if (PIN_PANICO_HASH && hash === PIN_PANICO_HASH) {
    acionarPanico();
    return false;
  }

  if (!PIN_HASH) {
    console.warn('[auth] PIN ainda não cadastrado — desbloqueio por PIN indisponível.');
    return false;
  }

  if (hash !== PIN_HASH) return false;

  destravar();
  return true;
}

/* ------------------------------------------------------------------
   6. BIOMETRIA (WebAuthn)
------------------------------------------------------------------ */

/**
 * Confirma a identidade pelo autenticador da plataforma (digital / face).
 *
 * ESTRUTURA BASE. Para funcionar de verdade faltam duas coisas do backend:
 *   1. O desafio precisa ser gerado no servidor e verificado lá. Desafio
 *      gerado no navegador não protege contra replay — é teatro.
 *   2. É preciso ter registrado uma credencial antes, com
 *      registrarBiometria(), e guardado o ID dela no servidor.
 *
 * @returns {Promise<boolean>}
 */
export async function verifyBiometrics() {
  if (DEV_MODE) {
    return DEV_BIOMETRIA_LOCAL ? demoBiometriaLocal() : true;
  }

  if (!window.PublicKeyCredential || !navigator.credentials) {
    console.warn('[auth] WebAuthn indisponível neste navegador.');
    status('Biometria indisponível', 'pending');
    return false;
  }

  try {
    const resposta = await fetch(ENDPOINT_DESAFIO, { credentials: 'include' });
    if (!resposta.ok) throw new Error(`desafio recusado (HTTP ${resposta.status})`);

    // O servidor devolve o desafio e os IDs das credenciais registradas,
    // ambos em base64url.
    const { desafio, credenciais = [] } = await resposta.json();

    const credencial = await navigator.credentials.get({
      publicKey: {
        challenge: base64UrlParaBytes(desafio),
        timeout: 60000,
        userVerification: 'required',
        allowCredentials: credenciais.map((id) => ({
          type: 'public-key',
          id: base64UrlParaBytes(id),
          transports: ['internal']
        }))
      }
    });

    if (!credencial) return false;

    // >>> FALTA: enviar `credencial` ao servidor para validar a assinatura.
    // Só depois da validação no backend a sessão pode ser considerada válida.
    return true;
  } catch (erro) {
    console.warn('[auth] falha na verificação biométrica:', erro.message);
    return false;
  }
}

/**
 * Registra a digital/face deste aparelho. Precisa rodar uma vez, com a
 * sessão já autenticada por outro meio, antes de verifyBiometrics() servir
 * para alguma coisa. Os dados de usuário e o desafio vêm do servidor.
 *
 * @returns {Promise<PublicKeyCredential|null>}
 */
export async function registrarBiometria() {
  if (DEV_MODE) {
    console.info('[auth] DEV_MODE: registro biométrico ignorado.');
    return null;
  }

  const resposta = await fetch(`${ENDPOINT_DESAFIO}?tipo=registro`, { credentials: 'include' });
  const { desafio, usuario, rpId } = await resposta.json();

  return navigator.credentials.create({
    publicKey: {
      challenge: base64UrlParaBytes(desafio),
      rp: { name: 'SAN & CO.', id: rpId },
      user: {
        id: base64UrlParaBytes(usuario.id),
        name: usuario.login,
        displayName: usuario.nome
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },    // ES256
        { type: 'public-key', alg: -257 }   // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred'
      },
      timeout: 60000,
      attestation: 'none'
    }
  });
}

/* ------------------------------------------------------------------
   6.1 DIAGNÓSTICO E DEMO (só desenvolvimento)
------------------------------------------------------------------ */

/** ID da credencial criada na demo, guardado só enquanto a aba viver. */
let credencialDemo = null;

/**
 * Responde por que a biometria não aparece neste aparelho.
 * @returns {Promise<{seguro:boolean, api:boolean, sensor:boolean, motivo:string}>}
 */
export async function diagnosticarBiometria() {
  const resultado = {
    seguro: window.isSecureContext,
    api: typeof window.PublicKeyCredential === 'function',
    sensor: false,
    motivo: ''
  };

  if (!resultado.seguro) {
    resultado.motivo = 'Sem HTTPS';   // http://IP-da-rede não é contexto seguro
    return resultado;
  }
  if (!resultado.api) {
    resultado.motivo = 'Sem WebAuthn';
    return resultado;
  }

  try {
    resultado.sensor = await PublicKeyCredential
      .isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    resultado.sensor = false;
  }
  if (!resultado.sensor) resultado.motivo = 'Sem sensor';

  return resultado;
}

/**
 * Dispara o prompt de digital/face com desafio local. Só para ver a
 * experiência funcionando — ver o aviso em DEV_BIOMETRIA_LOCAL.
 * @returns {Promise<boolean>}
 */
async function demoBiometriaLocal() {
  const diag = await diagnosticarBiometria();
  if (diag.motivo) {
    console.warn(`[auth] demo de biometria indisponível: ${diag.motivo}`);
    mostrarErro(`Biometria indisponível: ${diag.motivo.toLowerCase()}.`);
    return false;
  }

  const desafio = crypto.getRandomValues(new Uint8Array(32));

  try {
    // primeiro uso da aba: registra este aparelho
    if (!credencialDemo) {
      const idUsuario = crypto.getRandomValues(new Uint8Array(16));
      const nova = await navigator.credentials.create({
        publicKey: {
          challenge: desafio,
          rp: { name: 'SAN & CO.' },   // sem rp.id: assume o domínio atual
          user: { id: idUsuario, name: 'demo@sanco', displayName: 'Demo' },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 }
          ],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required'
          },
          timeout: 60000,
          attestation: 'none'
        }
      });
      if (!nova) return false;
      credencialDemo = new Uint8Array(nova.rawId);
      return true;   // o registro já pediu a digital: teste cumprido
    }

    // usos seguintes: autentica com a credencial registrada
    const credencial = await navigator.credentials.get({
      publicKey: {
        challenge: desafio,
        timeout: 60000,
        userVerification: 'required',
        allowCredentials: [{ type: 'public-key', id: credencialDemo, transports: ['internal'] }]
      }
    });
    return Boolean(credencial);
  } catch (erro) {
    console.warn('[auth] demo de biometria falhou:', erro.name, erro.message);
    mostrarErro('Não foi possível ler a biometria.');
    return false;
  }
}

/* ------------------------------------------------------------------
   7. INATIVIDADE
------------------------------------------------------------------ */

/**
 * Reinicia o contador de inatividade.
 * @param {number} minutos tempo até travar
 */
export function resetInactivityTimer(minutos = MINUTOS_INATIVIDADE) {
  if (DEV_MODE) return;

  minutosConfigurados = minutos;
  clearTimeout(temporizador);
  temporizador = null;

  if (estado.bloqueado) return;   // travado não conta tempo

  temporizador = setTimeout(() => lockSession('inatividade'), minutos * 60_000);
}

/** Handler das interações do usuário, com throttle. */
function registrarAtividade() {
  const agora = Date.now();
  if (agora - ultimaAtividade < THROTTLE_ATIVIDADE) return;
  ultimaAtividade = agora;
  resetInactivityTimer(minutosConfigurados);
}

/* ------------------------------------------------------------------
   8. PÂNICO
------------------------------------------------------------------ */

/**
 * PENDENTE DE DECISÃO.
 * Hoje só emite o evento `sanco:panico`. Antes de virar produção é preciso
 * decidir o que ele faz: abrir um painel isca com números falsos, apagar o
 * cache local, encerrar a sessão no servidor, ou avisar alguém em silêncio.
 */
function acionarPanico() {
  console.warn('[auth] PIN de pânico acionado — comportamento ainda não definido.');
  document.dispatchEvent(new CustomEvent('sanco:panico', {
    detail: { em: new Date().toISOString() }
  }));
}

/* ------------------------------------------------------------------
   9. INICIALIZAÇÃO
------------------------------------------------------------------ */

/**
 * Liga os vigias de sessão. Deve ser chamada uma única vez, no boot do
 * app.js, antes do roteador.
 *
 * @param {{ minutos?: number }} opcoes
 */
export function initAuth(opcoes = {}) {
  if (iniciado) return;
  iniciado = true;

  minutosConfigurados = opcoes.minutos ?? MINUTOS_INATIVIDADE;
  construirOverlay();

  // atividade do usuário
  EVENTOS_ATIVIDADE.forEach((tipo) => {
    document.addEventListener(tipo, registrarAtividade, { passive: true });
  });

  // sair da aba trava; voltar não destrava sozinho
  document.addEventListener('visibilitychange', () => {
    if (!TRAVAR_AO_SAIR || DEV_MODE) return;
    if (document.hidden) lockSession('ausencia');
  });

  if (DEV_MODE) {
    estado.autenticado = true;
    estado.bloqueado = false;
    console.warn(
      '%c[auth] DEV_MODE ativo — sessão nunca trava sozinha. ' +
      'Use SANCO_AUTH.lockSession() para testar a trava.',
      'color:#D4AF37'
    );

    // No celular não dá para abrir o console com facilidade, então um
    // impedimento de biometria aparece no próprio indicador do header.
    diagnosticarBiometria().then((diag) => {
      if (!diag.motivo) return;
      console.warn(`[auth] biometria indisponível: ${diag.motivo}`);
      status(diag.motivo, 'pending');
    });

    window.SANCO_AUTH = {
      lockSession, unlockSession, unlockComPin,
      verifyBiometrics, resetInactivityTimer, gerarHashPin,
      diagnostico: diagnosticarBiometria,

      /**
       * Só para teste: arma o contador de inatividade mesmo com DEV_MODE
       * ligado, ignorando a guarda de resetInactivityTimer().
       * Ex.: SANCO_AUTH.testarInatividade(0.1)  -> trava em 6 segundos
       */
      testarInatividade(minutos = 0.1) {
        clearTimeout(temporizador);
        temporizador = setTimeout(() => lockSession('inatividade'), minutos * 60_000);
        console.info(`[auth] teste: a sessão trava em ${minutos * 60}s se você não interagir.`);
      }
    };
    return;
  }

  // produção: a sessão nasce fechada
  estado.autenticado = false;
  lockSession('inicial');
}
