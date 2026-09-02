/**
 * SAN & CO. — módulo Ajustes (hub de configurações)
 *
 * Duas telas no mesmo módulo:
 *   #/ajustes            -> hub com os atalhos + segurança geral
 *   #/ajustes/<secao>    -> detalhe de uma seção (financas | panteao | agenda)
 */

/* ------------------------------------------------------------------
   1. SEÇÕES DE AJUSTE DE CADA MÓDULO
   Edite este mapa para acrescentar ou renomear seções.
------------------------------------------------------------------ */
const SECTIONS = {
  financas: {
    label: 'Finanças',
    icon: 'assets/icons/finance.svg',
    desc: 'Categorias, contas, cartões e provisão de impostos.',
    detail: 'Área reservada para as regras de categorias, limites e faturas.'
  },
  panteao: {
    label: 'Panteão',
    icon: 'assets/icons/panteao.svg',
    desc: 'Assistentes ativos, chaves de acesso e modelo padrão.',
    detail: 'Área reservada para as chaves de acesso e as preferências de cada assistente.'
  },
  agenda: {
    label: 'Rotina',
    icon: 'assets/icons/agenda.svg',
    desc: 'Calendários conectados, lembretes e rotina padrão.',
    detail: 'Área reservada para os calendários conectados e os horários da rotina.'
  }
};

/**
 * Preferências da aba de finanças. TODO: persistir no Supabase.
 *
 * As conexões bancárias (consentimento, sincronização, Data Passport) não
 * moram mais aqui — mudaram para dentro de Finanças (js/modules/conexoes.js),
 * porque conexão é assunto exclusivo de finanças, não de configuração geral.
 */
const preferenciasFinancas = {
  lentePadrao: 'todos',
  provisaoImpostos: null,
  sincronizacaoAutomatica: true
};

/* ------------------------------------------------------------------
   2. ESTADO DE SEGURANÇA
   Vive em memória. Para persistir, troque leituras/escritas por
   Supabase (tabela de preferências do usuário) dentro das funções
   readSecurity() / writeSecurity().
------------------------------------------------------------------ */
const security = {
  biometria: false,   // exigir autenticação ao abrir o app
  modestia: false     // abrir com os valores ocultos
};

function writeSecurity(key, value) {
  security[key] = value;
  // TODO: persistir no Supabase.
}

/* ------------------------------------------------------------------
   2B. TEMA — Sistema / Escuro / Claro
   Aplicado via atributo data-tema na tag <html> — o CSS inteiro (ver
   main.css e panteao.css) reage a esse atributo sozinho, nada aqui
   decide cor nenhuma, só liga a opção certa.
   Guardado em localStorage (não é dado de usuário, é preferência de
   aparelho — não faz sentido ir pro Supabase).
   A aplicação NA PRIMEIRA PINTURA da página (evitar o "flash" do tema
   errado antes deste módulo sequer carregar) é feita por um script
   próprio no <head> do index.html — este arquivo só cuida da troca
   depois que o app já está no ar.
------------------------------------------------------------------ */
const CHAVE_TEMA = 'humano:tema';
const TEMAS = [
  { id: 'sistema', rotulo: 'Sistema' },
  { id: 'escuro', rotulo: 'Escuro' },
  { id: 'claro', rotulo: 'Claro' }
];

function lerTema() {
  const atual = document.documentElement.dataset.tema;
  return TEMAS.some((t) => t.id === atual) ? atual : 'sistema';
}

function aplicarTema(tema) {
  document.documentElement.dataset.tema = tema;
  try { localStorage.setItem(CHAVE_TEMA, tema); } catch { /* modo privado, sem storage — segue só na sessão */ }
}

/* ------------------------------------------------------------------
   3. FRAGMENTOS DE HTML
------------------------------------------------------------------ */
/**
 * Resolve um caminho relativo ao index.html para URL absoluta — mesma
 * técnica e mesmo motivo do caminhoAsset() em app.js: --icon é consumida
 * por um mask() que mora em css/, então o caminho tem que ser resolvido
 * contra a página real, nunca escrito como texto fixo (relativo quebra
 * pelo local de consumo, absoluto com barra quebra fora da raiz do site).
 */
function caminhoAsset(relativo) {
  return new URL(relativo, document.baseURI).href;
}

function sectionCard(key, section) {
  return `
    <a class="card" href="#/ajustes/${key}" style="--icon: url('${caminhoAsset(section.icon)}')">
      <span class="card__icon" aria-hidden="true"></span>
      <span class="card__body">
        <span class="card__title">${section.label}</span>
        <span class="card__desc">${section.desc}</span>
      </span>
      <span class="card__chevron" aria-hidden="true">&rsaquo;</span>
    </a>
  `;
}

function switchRow({ key, title, desc, valor = null, grupo = 'seguranca' }) {
  return `
    <div class="row">
      <div class="row__body">
        <p class="row__title" id="label-${key}">${title}</p>
        <p class="row__desc">${desc}</p>
      </div>
      <button class="switch" type="button" role="switch"
              aria-checked="${(valor === null ? security[key] : valor) ? 'true' : 'false'}"
              aria-labelledby="label-${key}"
              data-toggle="${key}" data-grupo="${grupo}"></button>
    </div>
  `;
}

/* ------------------------------------------------------------------
   4. TELAS
------------------------------------------------------------------ */
function renderHub() {
  const view = document.createElement('section');
  view.dataset.module = 'config';
  view.dataset.screen = 'hub';

  const cards = Object.entries(SECTIONS)
    .map(([key, section]) => sectionCard(key, section))
    .join('');

  view.innerHTML = `
    <header class="view__head">
      <span class="view__eyebrow">Preferências</span>
      <h1 class="view__title">Configuração</h1>
      <p class="view__sub">Configure cada módulo e a segurança do aplicativo.</p>
      <div class="view__rule"></div>
    </header>

    <div class="section">
      <p class="section__label">Módulos</p>
      <div class="card-list">${cards}</div>
    </div>

    <div class="section">
      <p class="section__label">Aparência</p>

      <div class="row row--stack">
        <div class="row__body">
          <p class="row__title">Tema</p>
          <p class="row__desc">Sistema (padrão), escuro (preto) ou claro.</p>
        </div>
        <div class="lentes lentes--tema" role="group" aria-label="Tema do app">
          ${TEMAS.map((t) => `
            <button class="lentes__btn" type="button" data-tema-opcao="${t.id}"
                    aria-pressed="${lerTema() === t.id}">${t.rotulo}</button>
          `).join('')}
        </div>
      </div>
    </div>

    <div class="section">
      <p class="section__label">Segurança geral</p>

      ${switchRow({
        key: 'biometria',
        title: 'Bloqueio biométrico',
        desc: 'Pedir digital ou reconhecimento facial ao abrir o app.'
      })}

      ${switchRow({
        key: 'modestia',
        title: 'Modo modéstia',
        desc: 'Abrir com os valores ocultos (R$ ***.***,**).'
      })}

      <div class="row row--stack">
        <div class="row__main">
          <div class="row__body">
            <p class="row__title">Criptografia dos dados</p>
            <p class="row__desc">AES-256 · chave mestra ainda não definida.</p>
          </div>
          <button class="btn" type="button" data-action="chave-mestra">Definir chave</button>
        </div>
        <p class="row__note" data-note="chave-mestra" hidden>
          A chave mestra será criada quando o módulo de segurança for conectado.
          Ela não sai do aparelho e não pode ser recuperada — guarde-a fora do app.
        </p>
      </div>
    </div>

    <p class="signature">HUMANO · Desenvolvido por San &amp; Co.</p>
  `;

  return view;
}

function htmlAjustesFinancas() {
  return `
    <div class="section">
      <p class="section__label">Conexões bancárias</p>
      <p class="section__nota">
        Consentimento, sincronização e o Data Passport agora moram dentro de
        Finanças, não aqui — é onde o dado é usado.
      </p>
      <a class="btn btn--gold" href="#/financas/conexoes">Abrir Conexões em Finanças</a>
    </div>

    <div class="section">
      ${switchRow({
        key: 'sincronizacaoAutomatica',
        title: 'Sincronização automática',
        desc: 'Deixar o servidor buscar sozinho, uma vez por dia.',
        valor: preferenciasFinancas.sincronizacaoAutomatica,
        grupo: 'financas'
      })}
    </div>

    <div class="section">
      <p class="section__label">Preferências</p>

      <div class="row">
        <div class="row__body">
          <p class="row__title">Lente ao abrir</p>
          <p class="row__desc">Qual visão o painel mostra primeiro.</p>
        </div>
        <div class="seletor-perfil" role="group" aria-label="Lente padrão">
          <button class="seletor-perfil__btn" type="button" data-lente-padrao="entradas"
                  aria-pressed="${preferenciasFinancas.lentePadrao === 'entradas'}">Entradas</button>
          <button class="seletor-perfil__btn" type="button" data-lente-padrao="saidas"
                  aria-pressed="${preferenciasFinancas.lentePadrao === 'saidas'}">Saídas</button>
        </div>
      </div>

      <div class="row">
        <div class="row__body">
          <p class="row__title">Provisão de impostos</p>
          <p class="row__desc">Percentual reservado automaticamente sobre a receita PJ.</p>
        </div>
        <span class="row__valor">${
          Number.isFinite(preferenciasFinancas.provisaoImpostos)
            ? `${preferenciasFinancas.provisaoImpostos.toFixed(1).replace('.', ',')}%`
            : '<span class="valor-vazio">---%</span>'
        }</span>
      </div>
    </div>

  `;
}

function renderDetail(key) {
  const section = SECTIONS[key];
  const view = document.createElement('section');
  view.dataset.module = 'config';
  view.dataset.screen = key;

  view.innerHTML = `
    <a class="btn-back" href="#/ajustes">
      <span aria-hidden="true">&lsaquo;</span> Configuração
    </a>

    <header class="view__head">
      <span class="view__eyebrow">Configurações</span>
      <h1 class="view__title">${section.label}</h1>
      <p class="view__sub">${section.desc}</p>
      <div class="view__rule"></div>
    </header>

    <!-- ==========================================================
         >>> CONTROLES DESTA SEÇÃO ENTRAM AQUI <<<
         ========================================================== -->
    ${key === 'financas' ? htmlAjustesFinancas() : `
      <div class="slot" data-slot="config-${key}">
        <span class="slot__mark" aria-hidden="true"></span>
        <p class="slot__text">${section.detail}</p>
      </div>
    `}
  `;

  return view;
}

/**
 * Indicador do header em Configuração — o consentimento bancário mudou de
 * casa (agora é anunciado por conexoes.js, dentro de Finanças). Aqui sobra
 * o que ainda é genuinamente geral: o estado da segurança do app.
 */
function anunciarSeguranca() {
  if (security.biometria) return anunciar('Biometria ativa', 'secure');
  return anunciar('Biometria desativada', 'pending');
}

/** Atalho para o evento de status do header. */
function anunciar(label, tone) {
  document.dispatchEvent(new CustomEvent('sanco:status', { detail: { label, tone } }));
}

/* ------------------------------------------------------------------
   5. MÓDULO
------------------------------------------------------------------ */
let onClick = null; // referência do listener, para remover no unmount

const config = {
  id: 'config',
  title: 'Configuração',

  /**
   * @param {string[]} params ['financas'] em #/ajustes/financas
   * @returns {HTMLElement}
   */
  render(params = []) {
    const key = params[0];
    return SECTIONS[key] ? renderDetail(key) : renderHub();
  },

  /**
   * Delegação de eventos: um único listener cobre interruptores e botões.
   * @param {HTMLElement} view
   */
  mount(view) {
    anunciarSeguranca();

    onClick = (event) => {
      const opcaoTema = event.target.closest('[data-tema-opcao]');
      if (opcaoTema) {
        const escolhido = opcaoTema.dataset.temaOpcao;
        aplicarTema(escolhido);
        view.querySelectorAll('[data-tema-opcao]').forEach((botao) => {
          botao.setAttribute('aria-pressed', String(botao.dataset.temaOpcao === escolhido));
        });
        return;
      }

      const toggle = event.target.closest('[data-toggle]');
      if (toggle) {
        const key = toggle.dataset.toggle;
        const next = toggle.getAttribute('aria-checked') !== 'true';
        toggle.setAttribute('aria-checked', String(next));
        if (toggle.dataset.grupo === 'financas') preferenciasFinancas[key] = next;
        else { writeSecurity(key, next); if (key === 'biometria') anunciarSeguranca(); }
        return;
      }

      // lente padrão ao abrir o painel
      const lentePadrao = event.target.closest('[data-lente-padrao]');
      if (lentePadrao) {
        preferenciasFinancas.lentePadrao = lentePadrao.dataset.lentePadrao;
        view.querySelectorAll('[data-lente-padrao]').forEach((botao) => {
          botao.setAttribute(
            'aria-pressed',
            String(botao.dataset.lentePadrao === preferenciasFinancas.lentePadrao)
          );
        });
        return;
      }

      const action = event.target.closest('[data-action="chave-mestra"]');
      if (action) {
        const note = view.querySelector('[data-note="chave-mestra"]');
        note.hidden = !note.hidden;
      }
    };

    view.addEventListener('click', onClick);
  },

  unmount() {
    onClick = null; // o elemento é descartado junto com o listener
  }
};

export default config;
