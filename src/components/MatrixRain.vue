<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";

const canvas = ref(null);
const glyphs = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ<>/{}[]*+-=";
let context;
let columns = [];
let frameId;
let resizeObserver;
let motionPreference;
let onMotionPreferenceChange;
let lastFrame = 0;
let reducedMotion = false;

function resize() {
  const element = canvas.value;
  if (!element || !context) return;

  const bounds = element.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
  element.width = Math.round(bounds.width * ratio);
  element.height = Math.round(bounds.height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);

  const count = Math.ceil(bounds.width / 24);
  columns = Array.from(
    { length: count },
    (_, index) => columns[index] ?? Math.random() * (bounds.height / 18),
  );

  if (reducedMotion) drawStatic(bounds.width, bounds.height);
}

function drawStatic(width, height) {
  context.clearRect(0, 0, width, height);
  context.font = '13px "JetBrains Mono", monospace';
  columns.forEach((row, index) => {
    const y = (row * 18) % height;
    const glyph = glyphs[Math.floor(Math.random() * glyphs.length)];
    context.fillStyle =
      index % 5 === 0 ? "rgba(232, 163, 61, .34)" : "rgba(84, 173, 125, .22)";
    context.fillText(glyph, index * 24, y);
  });
}

function draw(timestamp) {
  frameId = requestAnimationFrame(draw);
  if (document.hidden || timestamp - lastFrame < 45) return;
  lastFrame = timestamp;

  const width = canvas.value.clientWidth;
  const height = canvas.value.clientHeight;
  context.fillStyle = "rgba(13, 16, 18, .12)";
  context.fillRect(0, 0, width, height);
  context.font = '13px "JetBrains Mono", monospace';

  columns.forEach((row, index) => {
    const x = index * 24;
    const y = row * 18;
    const glyph = glyphs[Math.floor(Math.random() * glyphs.length)];
    context.fillStyle =
      Math.random() > 0.94
        ? "rgba(232, 163, 61, .72)"
        : "rgba(84, 190, 130, .58)";
    context.fillText(glyph, x, y);

    if (y > height && Math.random() > 0.975) columns[index] = 0;
    else columns[index] += 0.28 + Math.random() * 0.36;
  });
}

function startAnimation() {
  cancelAnimationFrame(frameId);
  if (!reducedMotion) frameId = requestAnimationFrame(draw);
}

onMounted(() => {
  context = canvas.value.getContext("2d", { alpha: true });
  if (!context) return;

  motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotion = motionPreference.matches;
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas.value);
  onMotionPreferenceChange = () => {
    reducedMotion = motionPreference.matches;
    resize();
    startAnimation();
  };
  motionPreference.addEventListener("change", onMotionPreferenceChange);
  resize();
  startAnimation();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frameId);
  resizeObserver?.disconnect();
  motionPreference?.removeEventListener("change", onMotionPreferenceChange);
});
</script>

<template>
  <canvas ref="canvas" class="matrix-rain" aria-hidden="true"></canvas>
</template>

<style scoped>
.matrix-rain {
  display: block;
  width: 100%;
  height: 100%;
  opacity: 0.68;
}
</style>
