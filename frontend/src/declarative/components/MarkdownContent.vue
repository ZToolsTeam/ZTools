<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { renderMarkdown } from '../markdown.js';
import { typesetMath } from '../math.js';

const props = defineProps({ markdown: { type: String, default: '' } });
const root = ref(null);
const html = computed(() => renderMarkdown(props.markdown));
const typeset = () => void typesetMath(root.value);
onMounted(typeset);
watch(html, typeset, { flush: 'post' });
</script>

<template>
  <div ref="root" class="declarative-markdown" v-html="html" />
</template>
