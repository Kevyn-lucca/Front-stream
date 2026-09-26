<script setup>
import {
  ref,
  reactive,
  computed,
  onMounted,
  onBeforeUnmount,
  shallowRef,
  onErrorCaptured,
} from "vue";
import { Track, RoomEvent } from "livekit-client";
import MatrixRain from "./components/MatrixRain.vue";
import {
  criarSala,
  conectarSala,
  iniciarTransmissao,
  pararTransmissao,
  ajustarVolumeSaida,
  ajustarVolume,
  habilitarAudio,
  listarDispositivosDeSaida,
  listarDispositivosDeAudio,
  solicitarPermissaoEListarDispositivosDeAudio,
  sugerirDispositivoDeAudio,
  precisaDeLoopbackDeAudio,
  detectarQualidadeAutomatica,
} from "./livekit.js";

const IS_DEV = import.meta.env.DEV;
const LOG = "[BigBrandingCasting]";

function logError(...args) {
  if (IS_DEV) console.error(...args);
}

function logWarn(...args) {
  if (IS_DEV) console.warn(...args);
}

const CAMPO_INVALIDO = /[^a-zA-Z0-9_-]/;
const CHAVE_SALAS_RECENTES = "bigbrandingcasting:salas-recentes";

function campoValido(valor) {
  return (
    typeof valor === "string" &&
    valor.length >= 1 &&
    valor.length <= 32 &&
    !CAMPO_INVALIDO.test(valor)
  );
}

function normalizarSalasRecentes(salas) {
  if (!Array.isArray(salas)) return [];
  return [...new Set(salas.filter(campoValido))].slice(0, 4);
}

function carregarSalasRecentes() {
  try {
    const valor = localStorage.getItem(CHAVE_SALAS_RECENTES) || "[]";
    if (valor.length > 4096) return [];
    return normalizarSalasRecentes(JSON.parse(valor));
  } catch {
    return [];
  }
}

function sanitizarEntrada(valor) {
  return valor.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
}

const nomeDaSala = ref("");
const meuNome = ref("");
const salasRecentes = ref(carregarSalasRecentes());
const status = ref("desconectado"); // 'desconectado' 'conectando'  'conectado'
const transmitindo = ref(false);
const volumeSaida = ref(1);
const qualidadeModo = ref("Auto");
const qualidadeAtual = ref("720p");
const qualidadeTransmissao = computed(() =>
  qualidadeModo.value === "Auto" ? qualidadeAtual.value : qualidadeModo.value,
);
const minhasQualidades = ["Auto", "2K", "1080p", "720p", "480p"];
const saidasAudio = ref([]);
const dispositivoSaidaAudio = ref("");
const entradasAudio = ref([]);
const dispositivoEntradaAudio = ref("");
const permissaoAudioSolicitada = ref(false);
const precisaLoopback = precisaDeLoopbackDeAudio();
const minhaPreview = shallowRef(null);
const audioBloqueado = ref(false);
const avisoSemAudio = ref(false);
const avisoErroTransmissao = ref("");
const avisoMobile = ref(false);
const avisoEncerradoBrowser = ref(false);
const erroValidacao = ref("");
const erroGlobal = ref("");
const conectando = computed(() => status.value === "conectando");

const semSuporteATela = !navigator.mediaDevices?.getDisplayMedia;
const ehMobile =
  /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent) ||
  semSuporteATela;

const camposValidos = computed(
  () => campoValido(nomeDaSala.value) && campoValido(meuNome.value),
);

function aoDigitarCampo(campo, evento) {
  const limpo = sanitizarEntrada(evento.target.value);
  if (campo === "sala") nomeDaSala.value = limpo;
  else meuNome.value = limpo;
  erroValidacao.value = "";
}

function registrarSalaRecente(sala) {
  if (!campoValido(sala)) return;
  salasRecentes.value = normalizarSalasRecentes([sala, ...salasRecentes.value]);
  try {
    localStorage.setItem(
      CHAVE_SALAS_RECENTES,
      JSON.stringify(salasRecentes.value),
    );
  } catch (err) {
    logWarn(`${LOG} Não foi possível salvar as salas recentes:`, err);
  }
}

function selecionarSalaRecente(sala) {
  nomeDaSala.value = sala;
  erroValidacao.value = "";
}

let room = null;
let transmissaoAtivaStream = null;
let qualidadeAutoTimer = null;
const streams = reactive([]);
const participantes = reactive([]);
const containers = {};

function anexarContainer(streamId) {
  return (el) => {
    if (!el) return;
    containers[streamId] = el;
    const s = streams.find((s) => s.id === streamId);
    if (s && s.videoEl && !el.contains(s.videoEl)) {
      el.appendChild(s.videoEl);
    }
  };
}

function obterOuCriarStream(identity) {
  let s = streams.find((s) => s.identity === identity);
  if (!s) {
    s = {
      id: `${identity}-video`,
      identity,
      videoEl: null,
      volume: 1,
      audioTrack: null,
      audioEl: null,
    };
    streams.push(s);
  }
  return s;
}

function aplicarDispositivoDeSaidaAoElemento(el) {
  if (!el || !("setSinkId" in el) || !dispositivoSaidaAudio.value) return;
  el.setSinkId(dispositivoSaidaAudio.value).catch((err) => {
    logWarn(`${LOG} Não foi possível aplicar dispositivo de saída:`, err);
  });
}

function lidarComTrackSubscrito(track, participant) {
  const fontesAceitas = new Set([
    Track.Source.ScreenShare,
    Track.Source.ScreenShareAudio,
    Track.Source.Microphone,
  ]);
  if (!fontesAceitas.has(track.source)) return;

  const s = obterOuCriarStream(participant.identity);
  try {
    if (track.kind === "video") {
      const el = track.attach();
      el.style.width = "100%";
      el.style.display = "block";
      s.videoEl = el;
    } else {
      const el = track.attach();
      el.style.display = "none";
      document.body.appendChild(el);
      aplicarDispositivoDeSaidaAoElemento(el);
      s.audioTrack = track;
      room.startAudio().catch(() => {});
    }
  } catch (err) {
    logError(`${LOG} Erro ao anexar track de "${participant.identity}":`, err);
  }
}

function espectadoresDe(identity) {
  return participantes.filter((p) => p !== identity);
}

async function conectar() {
  nomeDaSala.value = sanitizarEntrada(nomeDaSala.value.trim());
  meuNome.value = sanitizarEntrada(meuNome.value.trim());

  if (!nomeDaSala.value || !meuNome.value) {
    erroValidacao.value = "Preencha o canal e o seu identificador.";
    return;
  }
  if (!camposValidos.value) {
    erroValidacao.value =
      "Use só letras, números, hífen e underscore (até 32 caracteres).";
    return;
  }

  erroValidacao.value = "";
  status.value = "conectando";

  try {
    room = criarSala();

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      lidarComTrackSubscrito(track, participant);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      track.detach().forEach((el) => el.remove());
      const s = streams.find((s) => s.identity === participant.identity);
      if (!s) return;
      if (track.kind === "video") s.videoEl = null;
      if (track.kind === "audio") s.audioTrack = null;
      if (!s.videoEl && !s.audioTrack) {
        const idx = streams.indexOf(s);
        if (idx !== -1) streams.splice(idx, 1);
        delete containers[`${participant.identity}-video`];
      }
    });

    room.on(RoomEvent.ParticipantConnected, (participant) => {
      if (!participantes.includes(participant.identity))
        participantes.push(participant.identity);
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      const streamIdx = streams.findIndex(
        (s) => s.identity === participant.identity,
      );
      if (streamIdx !== -1) streams.splice(streamIdx, 1);
      const pIdx = participantes.indexOf(participant.identity);
      if (pIdx !== -1) participantes.splice(pIdx, 1);
      delete containers[`${participant.identity}-video`];
    });

    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      audioBloqueado.value = !room.canPlaybackAudio;
    });

    await conectarSala(room, nomeDaSala.value, meuNome.value);
    registrarSalaRecente(nomeDaSala.value);
    status.value = "conectado";

    room.startAudio().catch(() => {});

    participantes.push(meuNome.value);
    room.remoteParticipants.forEach((participant) => {
      if (!participantes.includes(participant.identity))
        participantes.push(participant.identity);
      participant.trackPublications.forEach((publication) => {
        if (publication.track)
          lidarComTrackSubscrito(publication.track, participant);
      });
    });

    audioBloqueado.value = !room.canPlaybackAudio;
  } catch (err) {
    logError(`${LOG} Falha ao conectar:`, err);
    erroValidacao.value = "Não foi possível conectar. Tente novamente.";
    status.value = "desconectado";
  }
}

function desconectar() {
  if (transmitindo.value) {
    pararTransmissao(room);
    limparTransmissaoLocal({ motivo: "manual" });
  }
  if (room) {
    room.disconnect();
    room = null;
  }
  streams.splice(0);
  participantes.splice(0);
  Object.keys(containers).forEach((key) => delete containers[key]);
  status.value = "desconectado";
  audioBloqueado.value = false;
}

function limparTransmissaoLocal({ motivo = "manual" } = {}) {
  if (qualidadeAutoTimer) {
    clearInterval(qualidadeAutoTimer);
    qualidadeAutoTimer = null;
  }
  if (minhaPreview.value) minhaPreview.value.srcObject = null;
  transmitindo.value = false;
  avisoSemAudio.value = false;
  avisoMobile.value = false;
  avisoEncerradoBrowser.value = motivo === "browser";

  if (transmissaoAtivaStream) {
    transmissaoAtivaStream.getTracks().forEach((track) => {
      track.removeEventListener("ended", finalizarTransmissaoPorBrowser);
      track.stop();
    });
    transmissaoAtivaStream = null;
  }
}

function finalizarTransmissaoPorBrowser() {
  if (!transmitindo.value) return;
  logWarn(`${LOG} Transmissão encerrada pelo navegador.`);
  pararTransmissao(room);
  limparTransmissaoLocal({ motivo: "browser" });
}

function ativarAudio() {
  habilitarAudio(room);
  audioBloqueado.value = false;
}

function iniciarQualidadeAutomatica() {
  if (qualidadeAutoTimer) clearInterval(qualidadeAutoTimer);
  qualidadeAutoTimer = setInterval(() => {
    if (!transmitindo.value || qualidadeModo.value !== "Auto") return;
    const recomendada = detectarQualidadeAutomatica();
    if (recomendada !== qualidadeAtual.value) {
      qualidadeAtual.value = recomendada;
      trocarQualidadeTransmissao(recomendada, true);
    }
  }, 5000);
}

async function alternarTransmissao() {
  if (ehMobile) {
    avisoMobile.value = true;
    return;
  }

  if (!transmitindo.value) {
    avisoErroTransmissao.value = "";
    try {
      if (!minhaPreview.value) {
        logWarn(`${LOG} Prévia não montada.`);
        return;
      }

      if (precisaLoopback && !dispositivoEntradaAudio.value) {
        logWarn(
          `${LOG} Nenhum dispositivo de loopback selecionado. Sem áudio.`,
        );
      }

      qualidadeAtual.value =
        qualidadeModo.value === "Auto"
          ? detectarQualidadeAutomatica()
          : qualidadeModo.value;

      if (transmissaoAtivaStream) {
        transmissaoAtivaStream.getTracks().forEach((track) => track.stop());
      }

      const { stream, semAudio } = await iniciarTransmissao(
        room,
        volumeSaida.value,
        dispositivoEntradaAudio.value || null,
        qualidadeAtual.value,
      );

      transmissaoAtivaStream = stream;
      stream.getTracks().forEach((track) => {
        track.addEventListener("ended", finalizarTransmissaoPorBrowser);
      });

      minhaPreview.value.srcObject = stream;
      transmitindo.value = true;
      room.startAudio().catch(() => {});
      avisoSemAudio.value = semAudio;
      iniciarQualidadeAutomatica();
    } catch (err) {
      logError(`${LOG} Erro ao iniciar transmissão:`, err);
      limparTransmissaoLocal();
      avisoErroTransmissao.value =
        err?.cause?.status === 403
          ? "O token não tem permissão para transmitir. volte mais tarde"
          : "Não foi possível iniciar a transmissão. Verifique a permissão de captura de tela e tente novamente.";
    }
  } else {
    try {
      pararTransmissao(room);
    } catch (err) {
      logError(`${LOG} Erro ao parar transmissão:`, err);
    } finally {
      limparTransmissaoLocal();
    }
  }
}

async function trocarQualidadeTransmissao(novaQualidade, silencioso = false) {
  if (novaQualidade === "Auto") {
    qualidadeModo.value = "Auto";
    qualidadeAtual.value = detectarQualidadeAutomatica();
  } else {
    qualidadeModo.value = novaQualidade;
    qualidadeAtual.value = novaQualidade;
  }

  if (!transmitindo.value) return;
  if (silencioso && qualidadeModo.value !== "Auto") return;

  if (minhaPreview.value) minhaPreview.value.srcObject = null;
  pararTransmissao(room);
  try {
    const { stream, semAudio } = await iniciarTransmissao(
      room,
      volumeSaida.value,
      dispositivoEntradaAudio.value || null,
      qualidadeAtual.value,
    );
    transmissaoAtivaStream = stream;
    stream.getTracks().forEach((track) => {
      track.addEventListener("ended", finalizarTransmissaoPorBrowser);
    });
    if (minhaPreview.value) minhaPreview.value.srcObject = stream;
    avisoSemAudio.value = semAudio;
  } catch (err) {
    logError(`${LOG} Erro ao mudar qualidade:`, err);
    limparTransmissaoLocal();
  }
}

function mudarVolumeSaida(valor) {
  volumeSaida.value = valor;
  ajustarVolumeSaida(valor);
}

function mudarVolumeEntrada(stream, valor) {
  stream.volume = valor;
  if (stream.audioTrack) ajustarVolume(stream.audioTrack, valor);
}

const telaCheiaId = ref(null);

function elementoParaTelaCheia(id) {
  if (id === "preview") return minhaPreview.value;
  return containers[id] || null;
}

function alternarTelaCheia(id) {
  if (document.fullscreenElement) {
    document.exitFullscreen();
    return;
  }
  const el = elementoParaTelaCheia(id);
  if (!el || !el.requestFullscreen) {
    logWarn(`${LOG} Elemento para tela cheia não encontrado (id=${id})`);
    return;
  }
  el.requestFullscreen()
    .then(() => {
      telaCheiaId.value = id;
    })
    .catch((err) => logWarn(`${LOG} Erro ao entrar em tela cheia:`, err));
}

function aoMudarTelaCheia() {
  if (!document.fullscreenElement) telaCheiaId.value = null;
}

async function carregarSaidasDeAudio() {
  try {
    const dispositivos = await listarDispositivosDeSaida();
    saidasAudio.value = dispositivos;
    if (dispositivos.length && !dispositivoSaidaAudio.value) {
      dispositivoSaidaAudio.value = dispositivos[0].deviceId;
    }
  } catch (err) {
    logWarn(`${LOG} Não foi possível listar saídas:`, err);
  }
}

async function carregarEntradasDeAudio() {
  try {
    const dispositivos = await listarDispositivosDeAudio();
    entradasAudio.value = dispositivos;
    if (dispositivos.length && !dispositivoEntradaAudio.value) {
      const sugestao = sugerirDispositivoDeAudio(dispositivos);
      if (sugestao) dispositivoEntradaAudio.value = sugestao.deviceId;
    }
  } catch (err) {
    logWarn(`${LOG} Não foi possível listar entradas:`, err);
  }
}

async function detectarEntradasDeAudioComPermissao() {
  if (permissaoAudioSolicitada.value) return;
  permissaoAudioSolicitada.value = true;
  try {
    const dispositivos = await solicitarPermissaoEListarDispositivosDeAudio();
    entradasAudio.value = dispositivos;
    if (dispositivos.length && !dispositivoEntradaAudio.value) {
      const sugestao = sugerirDispositivoDeAudio(dispositivos);
      if (sugestao) dispositivoEntradaAudio.value = sugestao.deviceId;
    }
  } catch (err) {
    logWarn(`${LOG} Erro ao obter permissão de áudio:`, err);
  }
}

onMounted(() => {
  document.addEventListener("fullscreenchange", aoMudarTelaCheia);
  carregarSaidasDeAudio();
  carregarEntradasDeAudio();
});

onBeforeUnmount(() => {
  if (qualidadeAutoTimer) clearInterval(qualidadeAutoTimer);
  document.removeEventListener("fullscreenchange", aoMudarTelaCheia);
  if (room) room.disconnect();
});

onErrorCaptured((err, instance, info) => {
  logError(`${LOG} Erro capturado:`, err, info);
  erroGlobal.value =
    "Ocorreu um erro inesperado. Recarregue a página se necessário.";
  return false; // impede propagação
});
</script>

<template>
  <div class="app" role="main" aria-label="BigBrandingCasting">
    <div v-if="status !== 'conectado'" class="gate">
      <div class="gate-matrix" aria-hidden="true">
        <MatrixRain />
      </div>
      <div class="gate-card">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <span class="brand-name">BigBrandingCasting</span>
        </div>
        <p class="gate-lead">Entre em um canal de transmissão.</p>

        <label class="field">
          <span>Canal</span>
          <input
            :value="nomeDaSala"
            @input="aoDigitarCampo('sala', $event)"
            placeholder="minha-sala"
            maxlength="32"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            @keyup.enter="conectar"
            :disabled="conectando"
            aria-label="Nome do canal"
          />
        </label>

        <label class="field">
          <span>Seu identificador</span>
          <input
            :value="meuNome"
            @input="aoDigitarCampo('nome', $event)"
            placeholder="usuario-123"
            maxlength="32"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            @keyup.enter="conectar"
            :disabled="conectando"
            aria-label="Seu nome"
          />
        </label>
        <section
          v-if="salasRecentes.length"
          class="recent-rooms"
          aria-label="Salas recentes"
        >
          <div class="recent-rooms-heading">
            <span class="mono muted">recentes</span>
          </div>
          <div class="recent-rooms-grid">
            <button
              v-for="(sala, index) in salasRecentes"
              :key="sala"
              class="recent-room"
              :class="{ selected: nomeDaSala === sala }"
              type="button"
              @click="selecionarSalaRecente(sala)"
              :aria-label="`Selecionar sala ${sala}`"
            >
              <span class="recent-room-name">{{ sala }}</span>
              <span v-if="index === 0" class="recent-room-tag">última</span>
            </button>
          </div>
        </section>
        <p v-if="erroValidacao" class="field-error mono">{{ erroValidacao }}</p>
        <p v-if="erroGlobal" class="field-error mono">{{ erroGlobal }}</p>

        <button class="btn-primary" :disabled="conectando" @click="conectar">
          {{ conectando ? "Conectando…" : "Entrar no canal" }}
        </button>
      </div>
    </div>

    <div v-else class="room">
      <div v-if="audioBloqueado" class="audio-banner" @click="ativarAudio">
        Áudio bloqueado pelo navegador
      </div>
      <div
        v-if="avisoSemAudio"
        class="audio-banner"
        @click="avisoSemAudio = false"
      >
        Transmitindo sem áudio — nenhum dispositivo configurado
      </div>
      <div
        v-if="avisoErroTransmissao"
        class="audio-banner danger"
        role="alert"
        @click="avisoErroTransmissao = ''"
      >
        {{ avisoErroTransmissao }}
      </div>
      <div v-if="avisoMobile" class="audio-banner" @click="avisoMobile = false">
        📱 Transmissão de tela não é suportada em mobile. Use desktop/Chrome.
      </div>
      <div
        v-if="avisoEncerradoBrowser"
        class="audio-banner danger"
        @click="avisoEncerradoBrowser = false"
      >
        Transmissão encerrada pelo navegador.
      </div>

      <header class="topbar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <span class="brand-name">BigBrandingCasting</span>
        </div>
        <div class="topbar-meta">
          <span class="channel-name">{{ nomeDaSala }}</span>
          <span class="dot-sep" aria-hidden="true">·</span>
          <span class="mono muted">{{ participantes.length }} na sala</span>
          <span class="dot-sep" aria-hidden="true">·</span>
          <span class="mono muted">{{ streams.length }} em transmissão</span>
          <button
            class="btn-outline"
            @click="desconectar"
            aria-label="Sair da sala"
          >
            Sair
          </button>
        </div>
      </header>

      <section class="control-strip">
        <button
          class="rec-btn"
          :class="{ live: transmitindo }"
          :disabled="ehMobile"
          @click="alternarTransmissao"
          :aria-pressed="transmitindo"
          :aria-label="
            transmitindo ? 'Parar transmissão' : 'Iniciar transmissão'
          "
        >
          <span class="rec-ring" aria-hidden="true"></span>
          <span class="rec-dot" aria-hidden="true"></span>
        </button>

        <div class="control-info">
          <span class="control-label">
            {{ transmitindo ? "Transmitindo sua tela" : "Transmitir sua tela" }}
          </span>
          <span class="control-hint mono muted">
            {{ transmitindo ? "clique para encerrar" : "clique para iniciar" }}
          </span>
        </div>

        <div v-if="transmitindo" class="control-fader">
          <span class="fader-label mono">saída</span>
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            :value="volumeSaida"
            @input="mudarVolumeSaida(+$event.target.value)"
            aria-label="Volume da sua transmissão"
          />
          <span class="fader-value mono"
            >{{ Math.round(volumeSaida * 100) }}%</span
          >
        </div>

        <div v-if="transmitindo" class="quality-picker">
          <label class="quality-label mono muted" for="qualidade-stream"
            >qualidade</label
          >
          <select
            id="qualidade-stream"
            :value="qualidadeModo"
            @change="trocarQualidadeTransmissao($event.target.value)"
          >
            <option v-for="q in minhasQualidades" :key="q" :value="q">
              {{ q }}
            </option>
          </select>
        </div>

        <div v-if="entradasAudio.length" class="quality-picker">
          <label class="quality-label mono muted" for="loopback-audio"
            >áudio alt.</label
          >
          <select
            id="loopback-audio"
            v-model="dispositivoEntradaAudio"
            @focus="detectarEntradasDeAudioComPermissao"
          >
            <option value="">automático</option>
            <option
              v-for="d in entradasAudio"
              :key="d.deviceId"
              :value="d.deviceId"
            >
              {{ d.label || d.deviceId }}
            </option>
          </select>
        </div>
      </section>

      <div v-show="transmitindo" class="preview-strip">
        <span class="preview-label mono muted">sua prévia</span>
        <div class="preview-video-wrap">
          <video
            ref="minhaPreview"
            autoplay
            muted
            playsinline
            class="preview-video"
          ></video>
          <button
            class="expand-btn"
            @click="alternarTelaCheia('preview')"
            :aria-label="
              telaCheiaId === 'preview'
                ? 'Sair da tela cheia'
                : 'Ver em tela cheia'
            "
          >
            <svg
              v-if="telaCheiaId !== 'preview'"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="15 3 21 3 21 9"></polyline>
              <polyline points="9 21 3 21 3 15"></polyline>
              <line x1="21" y1="3" x2="14" y2="10"></line>
              <line x1="3" y1="21" x2="10" y2="14"></line>
            </svg>
            <svg
              v-else
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="4 14 10 14 10 20"></polyline>
              <polyline points="20 10 14 10 14 4"></polyline>
              <line x1="14" y1="10" x2="21" y2="3"></line>
              <line x1="3" y1="21" x2="10" y2="14"></line>
            </svg>
          </button>
        </div>
      </div>

      <section class="grid" v-if="streams.length">
        <article v-for="stream in streams" :key="stream.id" class="tile">
          <div class="tile-video" :ref="anexarContainer(stream.id)">
            <button
              class="expand-btn"
              @click="alternarTelaCheia(stream.id)"
              :aria-label="
                telaCheiaId === stream.id
                  ? 'Sair da tela cheia'
                  : 'Ver em tela cheia'
              "
            >
              <svg
                v-if="telaCheiaId !== stream.id"
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="15 3 21 3 21 9"></polyline>
                <polyline points="9 21 3 21 3 15"></polyline>
                <line x1="21" y1="3" x2="14" y2="10"></line>
                <line x1="3" y1="21" x2="10" y2="14"></line>
              </svg>
              <svg
                v-else
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="4 14 10 14 10 20"></polyline>
                <polyline points="20 10 14 10 14 4"></polyline>
                <line x1="14" y1="10" x2="21" y2="3"></line>
                <line x1="3" y1="21" x2="10" y2="14"></line>
              </svg>
            </button>
          </div>
          <div class="tile-bar">
            <span class="live-pill">
              <span class="live-dot" aria-hidden="true"></span>
              LIVE
            </span>
            <span class="tile-name mono">{{ stream.identity }}</span>
          </div>
          <div v-if="stream.audioTrack" class="tile-fader">
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="stream.volume"
              @input="mudarVolumeEntrada(stream, +$event.target.value)"
              :aria-label="`Volume de ${stream.identity}`"
            />
            <span class="fader-value mono"
              >{{ Math.round(stream.volume * 100) }}%</span
            >
          </div>
          <p v-else class="tile-no-audio mono muted">
            sem áudio nessa transmissão
          </p>
          <p class="tile-viewers mono muted">
            <span v-if="espectadoresDe(stream.identity).length">
              assistindo: {{ espectadoresDe(stream.identity).join(", ") }}
            </span>
            <span v-else>ninguém mais na sala ainda</span>
          </p>
        </article>
      </section>

      <div v-else class="empty">
        <span class="empty-mark" aria-hidden="true"></span>
        <p>Nenhuma transmissão no ar.</p>
        <p class="mono muted">assim que alguém ligar a tela, aparece aqui</p>
      </div>
    </div>
  </div>
</template>

<style>
@import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500&display=swap");

:root {
  --bg: #0d1012;
  --panel: #15191b;
  --panel-raised: #1b2023;
  --line: #262c2f;
  --line-bright: #34393c;
  --amber: #e8a33d;
  --amber-dim: #8a6427;
  --live: #e5473a;
  --live-dim: #5c2620;
  --text: #ecece7;
  --text-muted: #8b9195;
  --text-faint: #545a5d;
  --font-display: "Space Grotesk", sans-serif;
  --font-mono: "JetBrains Mono", monospace;
  --font-body: "Inter", sans-serif;
}

* {
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;
}
html,
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-body);
  overflow-x: hidden;
}
:focus-visible {
  outline: 2px solid var(--amber);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
</style>

<style scoped>
.app {
  min-height: 100vh;
  min-height: 100dvh;
  overflow-x: hidden;
}
.mono {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.02em;
}
.muted {
  color: var(--text-muted);
}

/* marca */
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
}
.brand-mark {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--amber);
  box-shadow: 0 0 0 3px rgba(232, 163, 61, 0.15);
}
.brand-name {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.14em;
}

/* tela de entrada */
.gate {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 24px;
  padding-top: max(24px, env(safe-area-inset-top));
  padding-bottom: max(24px, env(safe-area-inset-bottom));
  background:
    radial-gradient(
      circle at 20% 10%,
      rgba(232, 163, 61, 0.06),
      transparent 40%
    ),
    var(--bg);
}
.gate-matrix {
  position: absolute;
  z-index: 0;
  inset: 0;
  pointer-events: none;
}
.gate-card {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 360px;
  background: rgba(21, 25, 27, 0.88);
  backdrop-filter: blur(8px);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.gate-lead {
  margin: -8px 0 0;
  font-size: 13px;
  color: var(--text-muted);
}
.recent-rooms {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: -4px;
}
.recent-rooms-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  text-transform: uppercase;
}
.recent-rooms-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}
.recent-room {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 38px;
  padding: 7px 9px;
  color: var(--text-muted);
  text-align: left;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s,
    background 0.15s;
}
.recent-room:hover,
.recent-room.selected {
  color: var(--text);
  border-color: var(--amber-dim);
  background: var(--panel-raised);
}
.recent-room-mark {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border-radius: 50%;
  background: var(--amber-dim);
}
.recent-room.selected .recent-room-mark {
  background: var(--amber);
}
.recent-room-name {
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.recent-room-tag {
  margin-left: auto;
  color: var(--amber);
  font-family: var(--font-mono);
  font-size: 9px;
  flex: 0 0 auto;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
}
.field input {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 12px;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 16px; /* >=16px evita zoom automático no iOS */
}
.field input:focus {
  border-color: var(--amber-dim);
}
.field-error {
  margin: -8px 0 0;
  color: var(--live);
  font-size: 11px;
}
.btn-primary {
  margin-top: 4px;
  background: var(--amber);
  color: #201404;
  border: none;
  border-radius: 4px;
  padding: 14px;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 14px;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: filter 0.15s ease;
}
.btn-primary:hover:not(:disabled) {
  filter: brightness(1.08);
}
.btn-primary:disabled {
  opacity: 0.55;
  cursor: default;
}

.btn-outline {
  background: transparent;
  border: 1px solid var(--line-bright);
  border-radius: 4px;
  padding: 4px 12px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.btn-outline:hover {
  border-color: var(--amber-dim);
  color: var(--text);
}

/* avisos */
.audio-banner {
  background: var(--amber-dim);
  color: #fff3de;
  text-align: center;
  padding: 10px 12px;
  font-size: 12px;
  font-family: var(--font-mono);
  cursor: pointer;
}
.audio-banner.danger {
  background: var(--live-dim);
  color: #ffe5e5;
}

/* topbar */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 16px 24px;
  padding-top: max(16px, env(safe-area-inset-top));
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}
.topbar-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  flex-wrap: wrap;
  row-gap: 4px;
}
.channel-name {
  font-family: var(--font-mono);
  color: var(--text);
  word-break: break-all;
}
.dot-sep {
  color: var(--text-faint);
}

/* controles */
.control-strip {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 24px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  flex-wrap: wrap;
}

.rec-btn {
  position: relative;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  background: transparent;
  cursor: pointer;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  touch-action: manipulation;
}
.rec-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid var(--amber-dim);
  transition: border-color 0.2s ease;
}
.rec-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--amber);
  transition:
    background 0.2s ease,
    border-radius 0.2s ease;
}
.rec-btn.live .rec-ring {
  border-color: var(--live);
}
.rec-btn.live .rec-dot {
  background: var(--live);
  border-radius: 3px;
  width: 12px;
  height: 12px;
}
@keyframes pulse-ring {
  0% {
    transform: scale(1);
    opacity: 0.5;
  }
  100% {
    transform: scale(1.9);
    opacity: 0;
  }
}
.rec-btn.live .rec-ring::before,
.rec-btn.live .rec-ring::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid var(--live);
  opacity: 0;
  animation: pulse-ring 2s ease-out infinite;
}
.rec-btn.live .rec-ring::after {
  animation-delay: 1s;
}
.rec-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.control-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.control-label {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 14px;
}
.control-hint {
  font-size: 11px;
}

.control-fader {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
  padding: 10px 12px;
  background: var(--panel-raised);
  border: 1px solid var(--line);
  border-radius: 4px;
  width: 100%;
}
.fader-label {
  color: var(--text-muted);
  text-transform: uppercase;
  flex-shrink: 0;
}
.fader-value {
  color: var(--text-muted);
  min-width: 34px;
  text-align: right;
  flex-shrink: 0;
}

.quality-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--panel-raised);
  border: 1px solid var(--line);
  border-radius: 4px;
  flex-shrink: 0;
}
.quality-label {
  color: var(--text-muted);
  text-transform: uppercase;
  flex-shrink: 0;
  white-space: nowrap;
}
.quality-picker select {
  -webkit-appearance: none;
  appearance: none;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--line-bright);
  border-radius: 4px;
  padding: 6px 26px 6px 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.02em;
  cursor: pointer;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238b9195' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 6px center;
  background-size: 14px;
}
.quality-picker select:focus {
  border-color: var(--amber-dim);
}
.quality-picker select:hover {
  border-color: var(--line-bright);
  filter: brightness(1.1);
}

input[type="range"] {
  -webkit-appearance: none;
  appearance: none;
  width: 120px;
  flex: 1;
  min-width: 0;
  height: 4px;
  background: var(--line-bright);
  border-radius: 2px;
  outline-offset: 4px;
  touch-action: pan-x;
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--amber);
  cursor: pointer;
  border: 2px solid #0d1012;
}
input[type="range"]::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--amber);
  cursor: pointer;
  border: 2px solid #0d1012;
}

/* prévia */
.preview-strip {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--line);
}
.preview-label {
  text-transform: uppercase;
  flex-shrink: 0;
}
.preview-video-wrap {
  position: relative;
  width: 160px;
  max-width: 45vw;
}
.preview-video {
  width: 100%;
  border-radius: 4px;
  border: 1px solid var(--line-bright);
  display: block;
}

/* botão expandir (tela cheia) */
.expand-btn {
  position: absolute;
  bottom: 6px;
  right: 6px;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  background: rgba(13, 16, 18, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  color: var(--text);
  cursor: pointer;
  touch-action: manipulation;
  backdrop-filter: blur(2px);
}
.expand-btn:hover {
  background: rgba(13, 16, 18, 0.9);
  color: var(--amber);
}

/* grade */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
  padding: 20px 24px;
  padding-bottom: max(20px, env(safe-area-inset-bottom));
}
.tile {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.tile-video {
  position: relative;
  background: #000;
  aspect-ratio: 16 / 9;
  display: flex;
  align-items: center;
}
.tile-video :deep(video) {
  width: 100%;
  display: block;
}
.tile-video:fullscreen,
.preview-video-wrap:fullscreen {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
}
.tile-video:fullscreen :deep(video),
.preview-video-wrap:fullscreen .preview-video {
  width: auto;
  height: 100%;
  max-width: 100%;
  object-fit: contain;
}
.tile-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
}
.live-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--live);
  background: var(--live-dim);
  padding: 3px 7px;
  border-radius: 3px;
}
.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--live);
}
.tile-name {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tile-fader {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 12px;
}
.tile-fader input[type="range"] {
  flex: 1;
  width: auto;
}
.tile-fader .fader-value {
  min-width: 30px;
}
.tile-no-audio {
  margin: 0;
  padding: 0 12px 10px;
}
.tile-viewers {
  margin: 0;
  padding: 0 12px 12px;
  border-top: 1px solid var(--line);
  padding-top: 8px;
  word-break: break-word;
}

/* vazio */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 64px 24px;
  text-align: center;
  color: var(--text-muted);
}
.empty-mark {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid var(--line-bright);
  margin-bottom: 8px;
}
.empty p {
  margin: 0;
}

/* responsivo */
@media (max-width: 640px) {
  .topbar,
  .control-strip,
  .preview-strip,
  .grid {
    padding-left: 16px;
    padding-right: 16px;
  }
  .topbar {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .control-strip {
    padding-top: 14px;
    padding-bottom: 14px;
  }
  .control-fader {
    margin-left: 0;
  }
  .quality-picker {
    width: 100%;
    justify-content: space-between;
  }
  .quality-picker select {
    max-width: none;
    flex: 1;
    margin-left: 8px;
  }
  .grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 400px) {
  .gate {
    padding: 16px;
  }
  .gate-card {
    padding: 18px;
  }
  .preview-video-wrap {
    max-width: 55vw;
  }
  .control-label {
    font-size: 13px;
  }
}
</style>
