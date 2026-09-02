/**
 * SAN & CO. — app.js
 * Kernel do App Shell: roteamento por hash, ciclo de vida dos módulos,
 * transição entre telas e indicador de status.
 *
 * CONTRATO DE MÓDULO (todo arquivo em js/modules/ exporta um objeto default):
 *   {
 *     id:      'financeiro',                  // identificador interno
 *     title:   'Finanças',                    // usado no <title> do documento
 *     render(params) -> HTMLElement,          // OBRIGATÓRIO: devolve a tela
 *     mount(el, params) -> void,              // opcional: roda após inserir no DOM
 *     unmount() -> void                       // opcional: roda antes de remover
 *   }
 *
 * ROTAS: #/financas · #/panteao · #/agenda · #/ajustes
 * Sub-rotas viram params: #/financas/patrimonio -> params = ['patrimonio']
 * Patrimônio NÃO é aba: é sub-tela de Finanças, montada pelo financeiro.js.
 */

import financeiro from './modules/financeiro.js';
import panteao    from './modules/panteao.js';
import agenda     from './modules/agenda.js';
import config     from './modules/config.js';

import { initAuth } from './modules/auth.js';
import { estado }   from './state.js';

/* ------------------------------------------------------------------
   1. TABELA DE ROTAS
   index = posição na barra inferior (move o trilho dourado)
------------------------------------------------------------------ */
const ROUTES = {
  financas: { module: financeiro, index: 0 },
  panteao:  { module: panteao,    index: 1 },
  agenda:   { module: agenda,     index: 2 },
  ajustes:  { module: config,     index: 3 }
};

const DEFAULT_ROUTE = 'financas';
const LEAVE_MS = 160; // deve casar com a animação .view--leaving do CSS

/* ------------------------------------------------------------------
   1.1 CAMINHO DE ASSETS — resolvido contra a página real, não a URL
   Nunca escreva 'assets/x.svg' nem '/assets/x.svg' num atributo estático.
   O projeto já foi servido a partir da raiz (127.0.0.1:5500/) e de uma
   subpasta (127.0.0.1:5500/san-and-co/), dependendo de onde o Live Server
   foi aberto — e vai continuar mudando entre máquina, pen drive e futura
   publicação. Um caminho relativo resolve errado quando embutido numa
   custom property CSS consumida de dentro de css/ (ver o comentário no
   index.html); um caminho absoluto com barra na frente resolve errado
   assim que o site não estiver na raiz do domínio. `caminhoAsset()` é a
   única forma que não quebra em nenhum dos dois casos: ela pergunta ao
   navegador, em tempo de execução, "qual é a URL completa disso a partir
   de onde esta página realmente está?".
------------------------------------------------------------------ */

/**
 * Resolve um caminho relativo ao index.html para uma URL absoluta.
 * @param {string} relativo ex.: 'assets/icons/finance.svg'
 * @returns {string}
 */
function caminhoAsset(relativo) {
  return new URL(relativo, document.baseURI).href;
}

/* ------------------------------------------------------------------
   2. REFERÊNCIAS DO DOM
------------------------------------------------------------------ */
const content     = document.getElementById('app-content');
const nav         = document.getElementById('app-nav');
const navItems    = Array.from(document.querySelectorAll('.nav-item'));
const statusEl    = document.getElementById('app-status');
const statusLabel = document.getElementById('app-status-label');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/* estado do shell */
let activeModule  = null;  // módulo montado no momento
let renderToken   = 0;     // evita corrida entre cliques rápidos
let isFirstRender = true;  // controla o foco no primeiro carregamento

/* ------------------------------------------------------------------
   3. UTILITÁRIOS
------------------------------------------------------------------ */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lê o hash atual e devolve { name, params }.
 * "#/ajustes/financas" -> { name: 'ajustes', params: ['financas'] }
 */
function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  const name = parts.shift() || DEFAULT_ROUTE;
  return { name, params: parts };
}

/* ------------------------------------------------------------------
   4. STATUS DO HEADER
   Qualquer módulo pode atualizar sem importar este arquivo:
     document.dispatchEvent(new CustomEvent('sanco:status', {
       detail: { label: 'Sincronizando', tone: 'pending' }
     }));
------------------------------------------------------------------ */
function setStatus({ label, tone } = {}) {
  if (label) statusLabel.textContent = label;
  if (tone)  statusEl.dataset.tone = tone;
}

document.addEventListener('sanco:status', (event) => setStatus(event.detail));

/* ------------------------------------------------------------------
   5. ESTADO VISUAL DA NAVEGAÇÃO
------------------------------------------------------------------ */
function setActiveNav(routeName) {
  const route = ROUTES[routeName];
  if (!route) return;

  // o trilho dourado acompanha a quantidade de abas: nada de 25% fixo
  nav.style.setProperty('--nav-total', String(navItems.length));
  nav.style.setProperty('--nav-index', String(route.index));

  navItems.forEach((item) => {
    const isActive = item.dataset.route === routeName;
    if (isActive) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
}

/* ------------------------------------------------------------------
   6. RENDERIZAÇÃO DA ROTA
------------------------------------------------------------------ */
async function renderRoute() {
  const { name, params } = parseHash();

  // rota inexistente: redireciona para a padrão (dispara hashchange de novo)
  if (!ROUTES[name]) {
    window.location.replace('#/' + DEFAULT_ROUTE);
    return;
  }

  const token = ++renderToken;
  const { module } = ROUTES[name];

  setActiveNav(name);
  document.title = `${module.title} · SAN & CO.`;

  // 6.1 desmonta a tela anterior (libera timers, listeners, etc.)
  if (activeModule && typeof activeModule.unmount === 'function') {
    activeModule.unmount();
  }
  activeModule = null;

  // 6.2 fade-out da tela atual
  const outgoing = content.firstElementChild;
  if (outgoing && !reducedMotion.matches) {
    outgoing.classList.add('view--leaving');
    await wait(LEAVE_MS);
    if (token !== renderToken) return; // outra navegação assumiu no meio do caminho
  }

  // 6.3 monta a nova tela
  const view = module.render(params);
  view.classList.add('view');
  view.setAttribute('tabindex', '-1'); // permite mover o foco para a tela nova

  content.replaceChildren(view);
  window.scrollTo({ top: 0, behavior: 'auto' });

  if (typeof module.mount === 'function') module.mount(view, params);
  activeModule = module;

  // leitores de tela precisam saber que a tela mudou; no primeiro carregamento
  // não movemos o foco para não roubar o início da navegação por teclado, e
  // com a sessão travada o foco pertence ao overlay de desbloqueio
  if (!isFirstRender && !estado.bloqueado) view.focus({ preventScroll: true });
  isFirstRender = false;
}

/* ------------------------------------------------------------------
   7. BOOT
------------------------------------------------------------------ */
/** Escreve --icon com a URL absoluta de cada item que tiver data-icon. */
function resolverIconesDaNavegacao() {
  navItems.forEach((item) => {
    const arquivo = item.dataset.icon;
    if (!arquivo) return;
    const url = caminhoAsset(`assets/icons/${arquivo}`);
    item.style.setProperty('--icon', `url("${url}")`);
  });
}

function boot() {
  resolverIconesDaNavegacao();

  // O gate de segurança vem antes do roteador: com DEV_MODE = false a
  // sessão nasce travada e o conteúdo já aparece atrás do blur.
  initAuth();

  if (!window.location.hash) {
    window.history.replaceState(null, '', '#/' + DEFAULT_ROUTE);
  }

  window.addEventListener('hashchange', renderRoute);
  renderRoute();

  // Service worker do PWA — ative quando o sw.js existir.
  // if ('serviceWorker' in navigator) {
  //   window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
  // }
}

boot();
