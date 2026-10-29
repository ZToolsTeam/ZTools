<template>
  <div class="decl-input-wrap" :class="{ 'has-trailing': $slots.trailing }">
    <textarea
      v-if="multiline"
      v-bind="$attrs"
      :id="id || undefined"
      :rows="rows"
      :value="modelValue"
      :placeholder="placeholder || undefined"
      class="decl-input is-multiline"
      :class="{ 'is-error': invalid, 'is-mono': monospace }"
      :aria-invalid="invalid ? 'true' : undefined"
      :aria-describedby="describedby || undefined"
      @input="onInput"
    />
    <input
      v-else
      v-bind="$attrs"
      :id="id || undefined"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder || undefined"
      class="decl-input"
      :class="{ 'is-error': invalid, 'is-mono': monospace }"
      :aria-invalid="invalid ? 'true' : undefined"
      :aria-describedby="describedby || undefined"
      @input="onInput"
    />
    <span v-if="$slots.trailing" class="decl-input-trailing">
      <slot name="trailing" />
    </span>
  </div>
</template>

<script setup>
// 声明式表单统一输入框：单行 / 密码 / 多行共用一套外观（圆角与 RcSelect 一致，高 32、13px）
defineOptions({ inheritAttrs: false });

defineProps({
  modelValue: {
    type: [String, Number],
    default: ""
  },
  id: {
    type: String,
    default: ""
  },
  type: {
    type: String,
    default: "text"
  },
  placeholder: {
    type: String,
    default: ""
  },
  multiline: {
    type: Boolean,
    default: false
  },
  rows: {
    type: Number,
    default: 5
  },
  /** 插件声明为代码类输入时才用等宽字体，其余一律正文字体 */
  monospace: {
    type: Boolean,
    default: false
  },
  invalid: {
    type: Boolean,
    default: false
  },
  describedby: {
    type: String,
    default: ""
  }
});

const emit = defineEmits(["update:modelValue"]);

function onInput(e) {
  emit("update:modelValue", e.target.value);
}
</script>

<style scoped>
.decl-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}

.decl-input {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--rc-radius-md);
  border: 1px solid var(--rc-border);
  background: var(--rc-surface-hover);
  color: var(--rc-text-primary);
  font-family: var(--rc-font-sans);
  font-size: 13px;
  line-height: 20px;
  outline: none;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}

.decl-input-wrap.has-trailing .decl-input {
  padding-right: 60px;
}

.decl-input::placeholder {
  color: var(--rc-text-faint);
}

.decl-input:hover {
  border-color: var(--rc-border-highlight);
}

.decl-input:focus {
  border-color: var(--rc-accent);
  box-shadow: var(--rc-focus-ring);
}

.decl-input.is-multiline {
  height: auto;
  min-height: 32px;
  padding: 6px 10px;
  resize: vertical;
}

.decl-input.is-mono {
  font-family: var(--rc-font-mono);
  font-size: 12px;
}

.decl-input.is-error,
.decl-input.is-error:hover,
.decl-input.is-error:focus {
  border-color: var(--rc-error);
}

.decl-input.is-error:focus {
  box-shadow: 0 0 0 2px var(--rc-error-subtle);
}

.decl-input-trailing {
  position: absolute;
  right: 4px;
  display: inline-flex;
  align-items: center;
}
</style>
