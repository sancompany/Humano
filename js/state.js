/**
 * SAN & CO. — js/state.js
 * Camada de estado global reativa, sem dependências.
 *
 * COMO FUNCIONA
 * Um Proxy recursivo observa o objeto de estado. Toda escrita dispara dois
 * eventos no `document`:
 *
 *   sanco:state            -> qualquer alteração
 *   sanco:state:<chave>    -> alterações na chave raiz (ex.: sanco:state:perfil)
 *
 * O `detail` de ambos tem o mesmo formato:
 *   { caminho, chave, valor, anterior, estado }
 *   caminho  -> 'modalDetalhe.aberto'  (caminho completo da propriedade)
 *   chave    -> 'modalDetalhe'         (chave raiz, usada no nome do evento)
 *
 * Há ainda um evento de ciclo de vida, emitido só por hidratar():
 *   sanco:hidratado        -> detail: { chaves: ['perfil', 'lenteFinanceira'] }
 *
 * COMO USAR NUM MÓDULO
 *   import { estado, observar, alternarPerfil } from '../state.js';
 *
 *   // dentro de mount(): guarde o cancelador
 *   this._parar = observar('perfil', ({ valor }) => redesenhar(valor));
 *
 *   // dentro de unmount(): sempre cancele
 *   this._parar();
 *
 * REGRA IMPORTANTE
 * Escrever direto (`estado.perfil = 'PJ'`) funciona e notifica. Ainda assim,
 * prefira os métodos exportados abaixo: eles validam o valor e mantêm as
 * transições em um lugar só.
 */

/* ------------------------------------------------------------------
   1. CONSTANTES DE DOMÍNIO
------------------------------------------------------------------ */
const EVENTO = 'sanco:state';
const EVENTO_HIDRATADO = 'sanco:hidratado';

/** Chaves que sobrevivem a um F5 dentro da mesma aba. */
const PERSISTIDAS = ['perfil', 'lenteFinanceira'];
const CHAVE_CACHE = 'contexto';

export const PERFIS = Object.freeze(['PF', 'PJ']);
export const LENTES = Object.freeze(['todos', 'entradas', 'saidas']);

/**
 * Objeto que o Proxy envolve. ATENÇÃO: este é o estado VIVO — depois da
 * primeira escrita ele não contém mais os valores de fábrica. Para os
 * valores de fábrica use PADROES, logo abaixo.
 */
const RAIZ = {
  /** Perfil financeiro em foco: 'PF' (pessoa física) ou 'PJ' (empresa). */
  perfil: 'PF',

  /** Lente da tela de finanças: 'todos', 'entradas' ou 'saidas'. */
  lenteFinanceira: 'todos',

  /** Drawer/modal de dados detalhados. */
  modalDetalhe: { aberto: false, tipo: null, dados: null },

  /** Identidade já confirmada nesta sessão. */
  autenticado: false,

  /** Sessão travada por inatividade ou por sair da aba. */
  bloqueado: false
};

/** Congela em profundidade — Object.freeze sozinho é raso. */
function congelar(valor) {
  if (valor && typeof valor === 'object') {
    Object.values(valor).forEach(congelar);
    Object.freeze(valor);
  }
  return valor;
}

/** Valores de fábrica, imutáveis. Use para reset e para validar chaves. */
export const PADROES = congelar(structuredClone(RAIZ));

/* ------------------------------------------------------------------
   2. NÚCLEO REATIVO
------------------------------------------------------------------ */

/** Proxies já criados, para que `estado.x === estado.x` continue verdadeiro. */
const cacheProxies = new WeakMap();

/** Quando true, as escritas não emitem eventos (usado por hidratar()). */
let silencioso = false;

function ehObjetoSimples(valor) {
  if (valor === null || typeof valor !== 'object') return false;
  return Array.isArray(valor) || Object.getPrototypeOf(valor) === Object.prototype;
}

function notificar(caminho, valor, anterior) {
  const detalhe = {
    caminho,
    chave: caminho.split('.')[0],
    valor,
    anterior,
    estado
  };

  document.dispatchEvent(new CustomEvent(EVENTO, { detail: detalhe }));
  document.dispatchEvent(new CustomEvent(`${EVENTO}:${detalhe.chave}`, { detail: detalhe }));
}

/**
 * Envolve um objeto em Proxy, propagando para os objetos aninhados.
 * @param {object} alvo
 * @param {string} prefixo caminho acumulado ('' na raiz, 'modalDetalhe.' abaixo)
 */
function reativo(alvo, prefixo = '') {
  const emCache = cacheProxies.get(alvo);
  if (emCache) return emCache;

  const proxy = new Proxy(alvo, {
    get(obj, chave, receptor) {
      const valor = Reflect.get(obj, chave, receptor);
      if (typeof chave === 'symbol') return valor;
      // objetos aninhados também precisam notificar
      return ehObjetoSimples(valor) ? reativo(valor, `${prefixo}${chave}.`) : valor;
    },

    set(obj, chave, valor, receptor) {
      const anterior = obj[chave];
      if (Object.is(anterior, valor)) return true;   // nada mudou, nada a anunciar

      const ok = Reflect.set(obj, chave, valor, receptor);
      if (ok && !silencioso) notificar(`${prefixo}${String(chave)}`, valor, anterior);
      return ok;
    },

    deleteProperty(obj, chave) {
      const anterior = obj[chave];
      const ok = Reflect.deleteProperty(obj, chave);
      if (ok && !silencioso) notificar(`${prefixo}${String(chave)}`, undefined, anterior);
      return ok;
    }
  });

  cacheProxies.set(alvo, proxy);
  return proxy;
}

/** Instância única do estado global. */
export const estado = reativo(RAIZ);

/* ------------------------------------------------------------------
   3. OBSERVAÇÃO
------------------------------------------------------------------ */

/**
 * Casa caminhos por segmento, não por prefixo de string.
 * 'modalDetalhe' casa com 'modalDetalhe' e com 'modalDetalhe.aberto',
 * mas NÃO casa com uma hipotética chave 'modalDetalheAntigo'.
 */
function casaCaminho(caminho, alvo) {
  return caminho === alvo || caminho.startsWith(`${alvo}.`);
}

/**
 * Escuta alterações e devolve a função que cancela a escuta.
 * Sempre chame o cancelador no unmount() do módulo — senão o listener
 * sobrevive à troca de tela e você redesenha uma view que já saiu do DOM.
 *
 * @param {string} caminho 'perfil', 'modalDetalhe.aberto' ou '*' para tudo
 * @param {(detalhe: object) => void} callback
 * @returns {() => void} cancelador
 *
 * @example
 *   const parar = observar('lenteFinanceira', ({ valor }) => console.log(valor));
 *   parar();
 */
export function observar(caminho, callback) {
  const tudo = caminho === '*';
  const nomeEvento = tudo ? EVENTO : `${EVENTO}:${caminho.split('.')[0]}`;

  const ouvinte = (evento) => {
    if (!tudo && !casaCaminho(evento.detail.caminho, caminho)) return;
    callback(evento.detail);
  };

  document.addEventListener(nomeEvento, ouvinte);
  return () => document.removeEventListener(nomeEvento, ouvinte);
}

/**
 * Igual a observar(), mas dispara uma vez e cancela sozinho.
 */
export function observarUmaVez(caminho, callback) {
  const parar = observar(caminho, (detalhe) => {
    parar();
    callback(detalhe);
  });
  return parar;
}

/* ------------------------------------------------------------------
   4. MÉTODOS DE TRANSIÇÃO
------------------------------------------------------------------ */

/**
 * Alterna entre pessoa física e empresa.
 * @returns {'PF'|'PJ'} o perfil que passou a valer
 */
export function alternarPerfil() {
  estado.perfil = estado.perfil === 'PF' ? 'PJ' : 'PF';
  return estado.perfil;
}

/**
 * Define o perfil explicitamente.
 * @param {'PF'|'PJ'} perfil
 */
export function setPerfil(perfil) {
  if (!PERFIS.includes(perfil)) {
    console.warn(`[state] perfil inválido: ${perfil}. Use ${PERFIS.join(' ou ')}.`);
    return estado.perfil;
  }
  estado.perfil = perfil;
  return estado.perfil;
}

/**
 * Troca a lente da tela de finanças.
 * @param {'entradas'|'saidas'} lente
 */
export function setLenteFinanceira(lente) {
  if (!LENTES.includes(lente)) {
    console.warn(`[state] lente inválida: ${lente}. Use ${LENTES.join(' ou ')}.`);
    return estado.lenteFinanceira;
  }
  estado.lenteFinanceira = lente;
  return estado.lenteFinanceira;
}

/**
 * Abre o drawer de detalhamento.
 * Substitui o objeto inteiro de propósito: uma escrita, um evento.
 *
 * @param {string} tipo identificador da view de detalhe ('fatura', 'categoria'…)
 * @param {any} dados carga entregue ao componente que renderiza o detalhe
 */
export function abrirDetalhe(tipo, dados = null) {
  estado.modalDetalhe = { aberto: true, tipo, dados };
}

/** Fecha o drawer e limpa a carga, para não vazar dados entre aberturas. */
export function fecharDetalhe() {
  estado.modalDetalhe = { aberto: false, tipo: null, dados: null };
}

/* ------------------------------------------------------------------
   5. SESSÃO
------------------------------------------------------------------ */

/**
 * Porteiro para qualquer módulo antes de buscar dado sensível.
 * Com a sessão travada, nada de rede: a tela está desfocada, mas a
 * requisição continuaria saindo.
 *
 * @returns {boolean}
 * @example
 *   if (!sessaoLiberada()) return;
 *   const dados = await buscarSaldo();
 */
export function sessaoLiberada() {
  return estado.autenticado === true && estado.bloqueado === false;
}

/* ------------------------------------------------------------------
   6. SNAPSHOT E HIDRATAÇÃO
------------------------------------------------------------------ */

/**
 * Cópia do estado ATUAL, sem Proxy. Útil para log, depuração e persistência.
 * @returns {object}
 */
export function instantaneo() {
  return structuredClone(RAIZ);
}

/**
 * Aplica vários campos de uma vez sem disparar evento por escrita
 * intermediária e, no fim, emite um evento por chave efetivamente alterada
 * — para que quem observa `perfil` seja avisado normalmente — mais um
 * `sanco:hidratado` com a lista completa.
 *
 * Pensado para a carga inicial vinda do Supabase.
 *
 * @param {object} parcial campos a sobrescrever
 * @returns {string[]} chaves que realmente mudaram
 */
export function hidratar(parcial = {}) {
  const anterior = instantaneo();
  const alteradas = [];

  silencioso = true;
  try {
    for (const [chave, valor] of Object.entries(parcial)) {
      if (!(chave in PADROES)) {
        console.warn(`[state] chave desconhecida ignorada: ${chave}`);
        continue;
      }
      if (Object.is(RAIZ[chave], valor)) continue;
      estado[chave] = valor;
      alteradas.push(chave);
    }
  } finally {
    silencioso = false;
  }

  // um evento por chave: quem observa por chave precisa ser avisado
  alteradas.forEach((chave) => notificar(chave, RAIZ[chave], anterior[chave]));

  if (alteradas.length) {
    document.dispatchEvent(new CustomEvent(EVENTO_HIDRATADO, {
      detail: { chaves: alteradas, estado }
    }));
  }

  return alteradas;
}

/**
 * Devolve o estado aos valores de fábrica pela mesma via de hidratar(),
 * então as notificações saem normalmente.
 * @returns {string[]} chaves que mudaram
 */
export function resetar() {
  return hidratar(structuredClone(PADROES));
}

/* ------------------------------------------------------------------
   7. PERSISTÊNCIA DE CONTEXTO
   O seletor PF/PJ e a lente sobrevivem ao recarregamento da página, mas
   não à aba fechada.

   sessionStorage de propósito, não localStorage: num painel financeiro,
   herdar em silêncio o perfil de ontem é um jeito fácil de ler o número
   errado. Toda operação é tolerante a falha — em navegação anônima o
   sessionStorage lança em vez de gravar, e nada aqui justifica derrubar
   a aplicação.
------------------------------------------------------------------ */

const PREFIXO_CACHE = 'sanco:';
const TTL_CACHE_MS = 60 * 60 * 1000;   // 1 hora, igual ao cache do backend

/** sessionStorage existe e aceita escrita? */
function cacheDisponivel() {
  try {
    const teste = `${PREFIXO_CACHE}__teste`;
    sessionStorage.setItem(teste, '1');
    sessionStorage.removeItem(teste);
    return true;
  } catch {
    return false;
  }
}

const CACHE_ATIVO = cacheDisponivel();

/** Grava um valor com prazo de validade. */
function guardarCache(chave, valor) {
  if (!CACHE_ATIVO) return;
  try {
    sessionStorage.setItem(PREFIXO_CACHE + chave, JSON.stringify({
      valor,
      expira: Date.now() + TTL_CACHE_MS
    }));
  } catch { /* cota estourada — o app segue sem persistir */ }
}

/** Lê um valor. Entrada vencida é apagada e tratada como ausente. */
function lerCache(chave) {
  if (!CACHE_ATIVO) return null;
  try {
    const bruto = sessionStorage.getItem(PREFIXO_CACHE + chave);
    if (!bruto) return null;

    const { valor, expira } = JSON.parse(bruto);
    if (Date.now() > expira) {
      sessionStorage.removeItem(PREFIXO_CACHE + chave);
      return null;
    }
    return valor;
  } catch {
    return null;   // conteúdo corrompido
  }
}

/** Grava as chaves persistidas no cache de sessão. */
function persistirContexto() {
  const recorte = {};
  PERSISTIDAS.forEach((chave) => { recorte[chave] = RAIZ[chave]; });
  guardarCache(CHAVE_CACHE, recorte);
}

/**
 * Restaura o contexto salvo e passa a acompanhar as mudanças.
 * Chamada uma única vez, no fim deste módulo: qualquer import de state.js
 * já recebe o estado com o contexto certo.
 */
function iniciarPersistencia() {
  const salvo = lerCache(CHAVE_CACHE);

  if (salvo) {
    // valida antes de aplicar: cache adulterado não vira estado inválido
    const limpo = {};
    if (PERFIS.includes(salvo.perfil)) limpo.perfil = salvo.perfil;
    if (LENTES.includes(salvo.lenteFinanceira)) limpo.lenteFinanceira = salvo.lenteFinanceira;
    if (Object.keys(limpo).length) hidratar(limpo);
  }

  PERSISTIDAS.forEach((chave) => observar(chave, persistirContexto));
}

iniciarPersistencia();

/* ------------------------------------------------------------------
   8. DEPURAÇÃO
   Atalho de console: SANCO_STATE.perfil = 'PJ' e a interface reage.
   Remover antes de publicar.
------------------------------------------------------------------ */
window.SANCO_STATE = estado;
