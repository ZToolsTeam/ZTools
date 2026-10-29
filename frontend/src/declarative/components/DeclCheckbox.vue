<template>
  <button
    :id="id || undefined"
    type="button"
    role="checkbox"
    class="decl-checkbox"
    :class="{ 'is-checked': isChecked, 'is-mixed': isMixed }"
    :aria-checked="isMixed ? 'mixed' : isChecked ? 'true' : 'false'"
    :aria-label="ariaLabel || undefined"
    :disabled="disabled"
    @click="handleClick"
  >
    <MinusIcon v-if="isMixed" class="decl-checkbox-glyph" aria-hidden="true" />
    <CheckIcon v-else-if="isChecked" class="decl-checkbox-glyph" aria-hidden="true" />
  </button>
</template>

<script setup>
// 声明式渲染器统一复选框：主题色描边，勾选为余烬橙实底 + 深色勾；indeterminate 显示横线
import { computed } from "vue";
import { CheckIcon, MinusIcon } from "@lucide/vue";

const props = defineProps({
  /** true / false，或 'indeterminate'（部分选中） */
  checked: {
    type: [Boolean, String],
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  },
  id: {
    type: String,
    default: ""
  },
  ariaLabel: {
    type: String,
    default: ""
  }
});

const emit = defineEmits(["change"]);

const isMixed = computed(() => props.checked === "indeterminate");
const isChecked = computed(() => props.checked === true);

/** 点击不冒泡到所在行（否则会同时选中行）；部分选中时点击变为全选 */
function handleClick(e) {
  e?.stopPropagation?.();
  if (props.disabled) return;
  emit("change", !isChecked.value);
}
</script>

<style scoped>
.decl-checkbox {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 4px;
  border: 1px solid var(--rc-border-highlight);
  background: var(--rc-surface);
  color: var(--rc-accent-contrast);
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease;
}

.decl-checkbox:hover:not(:disabled) {
  border-color: var(--rc-text-muted);
}

.decl-checkbox.is-checked,
.decl-checkbox.is-mixed {
  background: var(--rc-accent);
  border-color: var(--rc-accent);
}

.decl-checkbox:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.decl-checkbox:focus-visible {
  outline: none;
  box-shadow: var(--rc-focus-ring);
}

.decl-checkbox-glyph {
  width: 10px;
  height: 10px;
  stroke-width: 3;
}
</style>
