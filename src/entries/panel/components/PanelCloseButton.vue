<template>
  <button type="button" class="panel-close-button" :title="label" :aria-label="label" @click="$emit('click', $event)"></button>
</template>

<script setup>
defineProps({ label: { type: String, default: '关闭' } });
defineEmits(['click']);
</script>
