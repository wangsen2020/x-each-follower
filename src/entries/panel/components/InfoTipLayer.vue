<template>
  <Teleport to="body">
    <div v-if="visible" id="panel-info-tip-tooltip" ref="bubble" class="panel-info-tip-tooltip" role="tooltip" :style="bubbleStyle">{{ content }}</div>
  </Teleport>
</template>

<script setup>
import { nextTick, onMounted, onUnmounted, ref } from 'vue';
import { positionInfoTip } from '../tooltip-position.js';

const visible = ref(false);
const content = ref('');
const bubble = ref(null);
const bubbleStyle = ref({ left: '8px', top: '8px' });
let active = null;
let previousDescription = null;
let sequence = 0;

function restoreDescription() {
  if (!active) return;
  if (previousDescription === null) active.removeAttribute('aria-describedby');
  else active.setAttribute('aria-describedby', previousDescription);
  active = null;
  previousDescription = null;
}

function hide() {
  sequence++;
  visible.value = false;
  restoreDescription();
}

function place() {
  if (!active?.isConnected || !bubble.value) { hide(); return; }
  const anchor = active.getBoundingClientRect();
  if (!anchor.width || !anchor.height) { hide(); return; }
  const bubbleRect = bubble.value.getBoundingClientRect();
  const result = positionInfoTip(anchor, bubbleRect, { width: window.innerWidth, height: window.innerHeight });
  bubbleStyle.value = { left: `${result.left}px`, top: `${result.top}px`, width: `${result.width}px` };
}

async function show(target) {
  const tip = target?.closest?.('.info-tip[data-tip]');
  const message = tip?.getAttribute('data-tip');
  if (!tip || !message) return;
  if (active !== tip) {
    restoreDescription();
    active = tip;
    previousDescription = tip.getAttribute('aria-describedby');
    const descriptions = [previousDescription, 'panel-info-tip-tooltip'].filter(Boolean).join(' ');
    tip.setAttribute('aria-describedby', descriptions);
  }
  content.value = message;
  visible.value = true;
  const current = ++sequence;
  await nextTick();
  if (current === sequence) place();
}

function onPointerOver(event) { show(event.target); }
function onPointerOut(event) {
  if (!active || !active.contains(event.target) || active.contains(event.relatedTarget)) return;
  if (document.activeElement !== active) hide();
}
function onFocusIn(event) { show(event.target); }
function onFocusOut(event) {
  if (active?.contains(event.target) && !active.contains(event.relatedTarget)) hide();
}
function onKeyDown(event) { if (event.key === 'Escape') hide(); }
function onDocumentClick(event) { if (active && !active.contains(event.target)) hide(); }
function onVisibilityChange() { if (document.hidden) hide(); }
function onViewportChange() { if (visible.value) place(); }

onMounted(() => {
  document.body.classList.add('info-tip-layer-active');
  document.addEventListener('pointerover', onPointerOver);
  document.addEventListener('pointerout', onPointerOut);
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onViewportChange, true);
});

onUnmounted(() => {
  hide();
  document.body.classList.remove('info-tip-layer-active');
  document.removeEventListener('pointerover', onPointerOver);
  document.removeEventListener('pointerout', onPointerOut);
  document.removeEventListener('focusin', onFocusIn);
  document.removeEventListener('focusout', onFocusOut);
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('click', onDocumentClick, true);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('resize', onViewportChange);
  window.removeEventListener('scroll', onViewportChange, true);
});
</script>

<style>
body.info-tip-layer-active .info-tip::after { content: none; }
.panel-info-tip-tooltip {
  position: fixed;
  z-index: 10000;
  box-sizing: border-box;
  width: 280px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  overflow-wrap: anywhere;
  overflow-y: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background: #2c3834;
  color: #fff;
  box-shadow: 0 4px 12px rgba(18, 32, 26, .18);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
  white-space: normal;
  pointer-events: none;
}
</style>
