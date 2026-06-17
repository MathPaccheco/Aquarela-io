<template>
  <!--
    GodePalette — simulates a physical watercolour pan palette (godê).
    Rendered as a row of round pigment pans arranged like the real object,
    with subtle texture and selection ring inspired by a wet paint surface.
  -->
  <div class="gode" role="group" aria-label="Godê de aquarela">
    <button
      v-for="pigmento in godePigmentos"
      :key="pigmento.hex"
      class="gode__pan"
      :class="{ 'gode__pan--selected': pigmento.hex === modelColor }"
      :style="{ '--pan-color': pigmento.hex }"
      :title="pigmento.nome"
      :aria-label="`Selecionar pigmento: ${pigmento.nome}`"
      :aria-pressed="pigmento.hex === modelColor"
      @click="selectPigmento(pigmento.hex)"
    >
      <!--
        Inner disc represents the pigment cake.
        A radial gradient from lighter centre to richer edge mimics
        the way light catches a slightly moist watercolour pan.
      -->
      <span class="gode__pan-disc" aria-hidden="true" />
    </button>
  </div>
</template>

<script setup>
/**
 * @file GodePalette.vue
 * @description Isolated colour-selection component that simulates a real watercolour
 * godê (pan palette). It owns no drawing state — it only emits the chosen pigment
 * hex value and exposes a `modelColor` prop so the parent can bind with v-model.
 *
 * @emits update:modelColor - Emitted when the user selects a pigment pan.
 *   Payload: {string} hex — the hex colour string of the selected pigment.
 *
 * @example
 * <GodePalette v-model:model-color="selectedColor" />
 */

import { defineProps, defineEmits } from 'vue';

// ---------------------------------------------------------------------------
// Pigment data — watercolour pigments chosen for layering and atmospheric
// perspective techniques. Each pigment is transparent enough to build glazes.
// ---------------------------------------------------------------------------

/**
 * @typedef {{ nome: string, hex: string }} Pigmento
 */

/** @type {Pigmento[]} */
const godePigmentos = [
  { nome: 'Azul Ultramar',          hex: '#120A8F' },
  { nome: 'Amarelo Ocre',           hex: '#E3A857' },
  { nome: 'Alizarin Crimson',       hex: '#E32636' },
  { nome: 'Verde Seiva',            hex: '#507D2A' },
  { nome: 'Cinza de Payne',         hex: '#536878' },
  { nome: 'Terra de Siena Queimada', hex: '#E97451' },
];

// ---------------------------------------------------------------------------
// Props & emits
// ---------------------------------------------------------------------------

const props = defineProps({
  /**
   * The currently selected pigment hex colour.
   * Bind with `v-model:model-color` from the parent.
   * Defaults to Azul Ultramar (#120A8F), the first pan in the godê.
   * @type {string}
   */
  modelColor: {
    type: String,
    default: '#120A8F',
  },
});

/**
 * @type {{ 'update:modelColor': [hex: string] }}
 */
const emit = defineEmits(['update:modelColor']);

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Handles a pigment pan click: emits the v-model update event so the parent
 * can update its `selectedColor` ref without any direct mutation here.
 *
 * SRP: this component knows nothing about canvas drawing or WebSocket — it
 * is purely a colour picker that follows the Vue v-model convention.
 *
 * @param {string} hex - The hex colour value of the clicked pigment pan.
 */
function selectPigmento(hex) {
  emit('update:modelColor', hex);
}
</script>

<style scoped>
/* ── Godê container ────────────────────────────────────────── */
.gode {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  padding: 0.55rem 0.9rem;
  background: #e8ddd4; /* weathered ceramic / porcelain palette colour */
  border: 1px solid #c4b8af;
  border-radius: 999px; /* pill shape mimics a real oval palette tray */
  box-shadow:
    inset 0 1px 3px rgba(0, 0, 0, 0.15),
    0 1px 2px rgba(255, 255, 255, 0.6);
}

/* ── Individual pan ────────────────────────────────────────── */
.gode__pan {
  position: relative;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  padding: 0;
  border: none;
  cursor: pointer;
  background: transparent;

  /* Selection ring — hidden by default, shown when active */
  outline: 3px solid transparent;
  outline-offset: 2px;
  transition: outline-color 0.15s ease, transform 0.12s ease;
}

.gode__pan:hover {
  transform: scale(1.18);
}

.gode__pan--selected {
  outline-color: #3a2e2e;
  transform: scale(1.22);
}

/* ── Pigment disc ──────────────────────────────────────────── */
.gode__pan-disc {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;

  /*
    Radial gradient: lighter centre fades to the full pigment colour at the
    edge, simulating a slightly moist watercolour cake under studio light.
    The CSS custom property --pan-color is set inline per pan.
  */
  background: radial-gradient(
    circle at 38% 35%,
    color-mix(in srgb, var(--pan-color) 55%, #fff 45%) 0%,
    var(--pan-color) 65%,
    color-mix(in srgb, var(--pan-color) 80%, #000 20%) 100%
  );

  /*
    Subtle inner shadow to give the disc a concave "pan" depth feel.
  */
  box-shadow:
    inset 0 2px 4px rgba(0, 0, 0, 0.25),
    inset 0 -1px 2px rgba(255, 255, 255, 0.2);
}
</style>
