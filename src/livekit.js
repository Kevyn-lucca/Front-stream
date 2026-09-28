import { Room, VideoPresets, Track, RoomEvent } from "livekit-client";
const TOKEN_SERVER = import.meta.env.VITE_TOKEN_SERVER_URL;

const LOG = "[LiveKit]";

const DEBUG = import.meta.env.DEV;

function log(...args) {
  if (DEBUG) console.log(...args);
}
function warnLog(...args) {
  if (DEBUG) console.warn(...args);
}
function errLog(...args) {
  if (DEBUG) {
    console.error(...args);
  } else {
    console.error(`${LOG} Ocorreu um erro.`);
  }
}
function groupLog(label) {
  if (DEBUG) console.group(label);
}
function groupEndLog() {
  if (DEBUG) console.groupEnd();
}

async function pegarTokens(room, identity) {
  if (!TOKEN_SERVER) {
    throw new Error("VITE_TOKEN_SERVER_URL não está definida no .env.");
  }

  try {
    new URL(TOKEN_SERVER);
  } catch {
    throw new Error("VITE_TOKEN_SERVER_URL não é uma URL válida.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(TOKEN_SERVER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room, identity }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const texto = await res.text().catch(() => "");
      throw new Error(
        `Token server respondeu ${res.status} ${res.statusText}: ${texto}`,
      );
    }

    const { primary, fallback } = await res.json();
    if (!primary?.url || !primary?.token) {
      throw new Error("Token server respondeu sem 'primary' completo.");
    }
    if (!fallback?.url || !fallback?.token) {
      throw new Error("Token server respondeu sem 'fallback' completo.");
    }

    return { primary, fallback };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Timeout ao conectar ao token server.');
    }
    errLog(`${LOG} Falha ao obter tokens:`, err.message);
    throw err;
  }
}
export function isFirefox() {
  return /firefox/i.test(navigator.userAgent);
}

export function isSafari() {
  return (
    /safari/i.test(navigator.userAgent) &&
    !/chrome|chromium|edg/i.test(navigator.userAgent)
  );
}

export function isChromium() {
  return !isFirefox() && !isSafari();
}

function escolherCodecDeVideo() {
  if (isFirefox()) {
    return "vp8";
  }
  if (isSafari()) {
    return "vp8";
  }
  return "h264";
}

// scalabilityMode só tem suporte em Chromium, então mata se não suporta pra não dá o erro de impedir transmissão.

function suportaScalabilityMode() {
  const suportado = isChromium();
  return suportado;
}

// Firefox não aceita múltiplas camadas de encoding
function suportaSimulcastDeTela() {
  const suportado = isChromium();
  return suportado;
}

export function criarSala() {
  const codec = escolherCodecDeVideo();
  const simulcast = suportaSimulcastDeTela();

  const room = new Room({
    dynacast: true,
    adaptiveStream: true,
    publishDefaults: {
      simulcast,
      videoCodec: codec,
      dtx: true,
      screenShareEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
      ...(simulcast
        ? {
            screenShareSimulcastLayers: [
              {
                width: 1280,
                height: 720,
                encoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
              },
              {
                width: 854,
                height: 480,
                encoding: { maxBitrate: 1_200_000, maxFramerate: 24 },
              },
            ],
          }
        : {}),
    },
  });

  return room;
}

// registra os listeners no room ANTES de chamar isso, senão perde quem já estava transmitindo antes de você entrar
export async function conectarSala(room, nomeDaSala, identity) {
  const TIMEOUT_MS = 8000;

  async function tentarConectar(url, token) {
    const endpoint = new URL(url);
    if (!["ws:", "wss:"].includes(endpoint.protocol)) {
      throw new Error("O endereço do LiveKit precisa usar ws:// ou wss://.");
    }
    if (window.location.protocol === "https:" && endpoint.protocol !== "wss:") {
      throw new Error(
        "Uma página HTTPS só pode conectar ao LiveKit via wss://.",
      );
    }

    let timeoutId;
    try {
      await Promise.race([
        room.connect(url, token),
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`Timeout após ${TIMEOUT_MS}ms`)),
            TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const { primary, fallback } = await pegarTokens(nomeDaSala, identity);

  try {
    await tentarConectar(primary.url, primary.token);
    log(`${LOG} Conectado via primário`);
    return;
  } catch (primaryError) {
    warnLog(`${LOG} Primário falhou; tentando fallback.`);
    await room.disconnect();
  }

  try {
    await tentarConectar(fallback.url, fallback.token);
    log(`${LOG} Conectado via fallback`);
  } catch (fallbackError) {
    await room.disconnect();
    errLog(`${LOG} Primário e fallback falharam.`);
    throw fallbackError;
  }
}
export function precisaDeLoopbackDeAudio() {
  const precisa = isFirefox() || isSafari();
  return precisa;
}

export function criarRequisicaoDisplayMedia(config) {
  const video = {
    frameRate: { ideal: config.frameRate },
    width: { ideal: config.width },
    height: { ideal: config.height },
    aspectRatio: 16 / 9,
  };

  if (isFirefox()) {
    return { video, audio: true };
  }

  if (isSafari()) {
    return { video, audio: false };
  }

  return {
    video,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      systemAudio: "include",
    },
  };
}

export async function listarDispositivosDeAudio() {
  try {
    const dispositivos = await navigator.mediaDevices.enumerateDevices();
    const entradas = dispositivos.filter((d) => d.kind === "audioinput");
    return entradas;
  } catch (err) {
    errLog(`${LOG} Falha ao enumerar dispositivos de áudio:`, err);
    return [];
  }
}

export async function solicitarPermissaoEListarDispositivosDeAudio() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (e) {
    warnLog(`${LOG} Permissão de áudio negada ou indisponível:`, e);
  }
  return listarDispositivosDeAudio();
}

export async function listarDispositivosDeSaida() {
  try {
    const dispositivos = await navigator.mediaDevices.enumerateDevices();
    const saidas = dispositivos.filter((d) => d.kind === "audiooutput");

    return saidas;
  } catch (err) {
    errLog(`${LOG} Falha ao enumerar dispositivos de saída:`, err);
    return [];
  }
}

const PISTAS_CABO_VIRTUAL = [
  "cable",
  "vb-audio",
  "blackhole",
  "loopback",
  "monitor of",
  "stereo mix",
  "what u hear",
];

export function sugerirDispositivoDeAudio(dispositivos) {
  const sugestao =
    dispositivos.find((d) =>
      PISTAS_CABO_VIRTUAL.some((pista) =>
        d.label.toLowerCase().includes(pista),
      ),
    ) || null;
  return sugestao;
}

let audioContext = null;
let gainNode = null;
let streamAudioExtra = null;

export class PrecisaDeDispositivoDeAudioError extends Error {
  constructor() {
    super(
      "Selecione o dispositivo de áudio virtual (loopback) antes de transmitir.",
    );
    this.name = "PrecisaDeDispositivoDeAudioError";
  }
}

export const QUALIDADES_STREAM = {
  Auto: { width: 1280, height: 720, frameRate: 30, maxBitrate: 2_500_000 },
  "2K": { width: 2560, height: 1440, frameRate: 24, maxBitrate: 4_500_000 },
  "1080p": { width: 1920, height: 1080, frameRate: 30, maxBitrate: 3_500_000 },
  "720p": { width: 1280, height: 720, frameRate: 30, maxBitrate: 2_500_000 },
  "480p": { width: 854, height: 480, frameRate: 24, maxBitrate: 1_200_000 },
};

export function detectarQualidadeAutomatica() {
  const connection = navigator.connection || navigator.mozConnection;
  const effectiveType = connection?.effectiveType || "4g";
  const downlink = connection?.downlink || 10;

  let resultado;
  if (
    effectiveType === "slow-2g" ||
    effectiveType === "2g" ||
    downlink <= 1.5
  ) {
    resultado = "480p";
  } else if (effectiveType === "3g" || downlink <= 4) {
    resultado = "720p";
  } else if (downlink >= 15) {
    resultado = "1080p";
  } else {
    resultado = "720p";
  }

  return resultado;
}

export function pegarConfiguracaoQualidade(qualidade = "Auto") {
  if (qualidade === "Auto") {
    return QUALIDADES_STREAM[detectarQualidadeAutomatica()];
  }

  return (
    QUALIDADES_STREAM[qualidade] || {
      width: 1920,
      height: 1080,
      frameRate: 30,
      maxBitrate: 4_000_000,
    }
  );
}

export async function iniciarTransmissao(
  room,
  volumeInicial = 1,
  audioDeviceId = null,
  qualidade = "Auto",
) {
  groupLog(`${LOG} iniciarTransmissao (qualidade=${qualidade})`);

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error(
        "Este navegador não oferece suporte a compartilhamento de tela.",
      );
    }

    if (room?.localParticipant) {
      room.localParticipant.getTrackPublications().forEach((pub) => {
        if (
          pub.source === Track.Source.ScreenShare ||
          pub.source === Track.Source.ScreenShareAudio
        ) {
          pub.track?.stop?.();
        }
      });
    }

    const config = pegarConfiguracaoQualidade(qualidade);

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(
        criarRequisicaoDisplayMedia(config),
      );
    } catch (err) {
      errLog(
        `${LOG} getDisplayMedia falhou (usuário cancelou ou permissão negada?):`,
        err,
      );
      throw err;
    }

    const videoTrack = stream.getVideoTracks()[0];

    let audioTrackOriginal = stream.getAudioTracks()[0];
    let semAudio = false;

    if (audioTrackOriginal) {
    } else if (audioDeviceId) {
      try {
        streamAudioExtra = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: audioDeviceId },
            autoGainControl: false,
            echoCancellation: false,
            noiseSuppression: false,
            sampleRate: 48000,
          },
        });
        audioTrackOriginal = streamAudioExtra.getAudioTracks()[0];
      } catch (e) {
        errLog(`${LOG} Falha ao capturar áudio do dispositivo virtual:`, e);
        semAudio = true;
      }
    } else {
      warnLog(
        precisaDeLoopbackDeAudio()
          ? `${LOG} Nenhum dispositivo de áudio virtual selecionado`
          : `${LOG} Sem áudio embutido e nenhum dispositivo de loopback selecionado`,
      );
      semAudio = true;
    }

    // Fallback de sem scalabilitymode
    const videoEncodingBase = {
      maxBitrate: config.maxBitrate,
      maxFramerate: config.frameRate,
      priority: "high",
    };
    const videoEncoding = suportaScalabilityMode()
      ? {
          ...videoEncodingBase,
          scalabilityMode: config.width >= 1920 ? "L1T2" : "L1T1",
        }
      : videoEncodingBase;

    try {
      await room.localParticipant.publishTrack(videoTrack, {
        source: Track.Source.ScreenShare,
        videoEncoding,
      });
    } catch (err) {
      if (err?.name === "PublishTrackError" && err?.status === 403) {
        videoTrack.stop();
        stream.getTracks().forEach((track) => track.stop());
        throw new Error(
          "O token LiveKit não permite publicar. Atualize/reinicie o token server para emitir tokens com canPublish habilitado e reconecte à sala.",
          { cause: err },
        );
      }

      errLog(
        `${LOG} Falha ao publicar vídeo com encoding avançado, tentando fallback simples sem scalabilityMode:`,
        err,
      );
      try {
        await room.localParticipant.publishTrack(videoTrack, {
          source: Track.Source.ScreenShare,
          videoEncoding: videoEncodingBase,
        });
      } catch (err2) {
        errLog(
          `${LOG} Falha ao publicar vídeo mesmo com fallback — abortando transmissão:`,
          err2,
        );
        videoTrack.stop();
        stream.getTracks().forEach((t) => t.stop());
        throw err2;
      }
    }

    if (audioTrackOriginal) {
      try {
        if (!audioContext) {
          audioContext = new (window.AudioContext || window.webkitAudioContext)(
            {
              latencyHint: "interactive",
              sampleRate: 48000,
            },
          );
        }

        const fonte = audioContext.createMediaStreamSource(
          new MediaStream([audioTrackOriginal]),
        );
        gainNode = audioContext.createGain();
        gainNode.gain.value = volumeInicial;
        const destino = audioContext.createMediaStreamDestination();

        fonte.connect(gainNode).connect(destino);

        const audioTrackProcessado = destino.stream.getAudioTracks()[0];
        await room.localParticipant.publishTrack(audioTrackProcessado, {
          source: Track.Source.ScreenShareAudio,
        });
      } catch (err) {
        errLog(
          `${LOG} Falha ao processar/publicar áudio de tela — transmissão continuará só com vídeo:`,
          err,
        );
        semAudio = true;
      }
    } else {
      semAudio = true;
      warnLog(
        `${LOG} Nenhuma track de áudio do sistema foi detectada. No Chrome, marque "Compartilhar também o áudio da guia/sistema" no seletor.`,
      );
    }

    videoTrack.addEventListener("ended", () => {
      pararTransmissao(room);
    });

    return { stream, semAudio };
  } catch (err) {
    errLog(`${LOG} iniciarTransmissao falhou:`, err);
    throw err;
  } finally {
    groupEndLog();
  }
}

export function pararTransmissao(room) {
  try {
    room?.localParticipant?.getTrackPublications().forEach((pub) => {
      if (
        pub.source === Track.Source.ScreenShare ||
        pub.source === Track.Source.ScreenShareAudio
      ) {
        pub.track?.stop?.();
        room.localParticipant.unpublishTrack(pub.track);
      }
    });
  } catch (err) {
    errLog(`${LOG} Erro ao despublicar tracks:`, err);
  }

  try {
    audioContext?.close();
  } catch (err) {
    warnLog(`${LOG} Erro ao fechar AudioContext:`, err);
  }
  audioContext = null;
  gainNode = null;

  streamAudioExtra?.getTracks().forEach((t) => t.stop());
  streamAudioExtra = null;
}

export function ajustarVolumeSaida(valor) {
  if (gainNode) {
    gainNode.gain.value = valor;
  } else {
    warnLog(
      `${LOG} ajustarVolumeSaida chamado sem gainNode ativo (nenhuma transmissão de áudio em andamento?)`,
    );
  }
}

export function ajustarVolume(audioTrack, valor) {
  try {
    audioTrack.setVolume(valor);
  } catch (err) {
    errLog(`${LOG} Falha ao ajustar volume de uma track remota:`, err);
  }
}

export function habilitarAudio(room) {
  room.startAudio().catch((err) => {
    errLog(`${LOG} startAudio() falhou:`, err);
  });
}
