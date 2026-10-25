<template>
  <div ref="formRootRef" class="flex flex-col h-full overflow-hidden select-none">
    <!-- 表单滚动容器 -->
    <div class="flex-1 overflow-y-auto declarative-scrollbar p-6 space-y-6 max-w-2xl mx-auto w-full">
      <div
        v-for="(field, fIdx) in formFields"
        :key="field.props?.id || fIdx"
        class="space-y-2 text-sm"
      >
        <!-- 标签与信息提示 -->
        <div class="flex items-center justify-between">
          <label
            :for="field.props?.id"
            class="font-medium text-[var(--rc-text-primary)] flex items-center gap-1.5"
          >
            <span>{{ field.props?.title || field.props?.id }}</span>
          </label>
          <span v-if="field.props?.info" class="text-xs text-[var(--rc-text-muted)]">
            {{ field.props.info }}
          </span>
        </div>

        <!-- 1. Form.TextField 单行输入 -->
        <div v-if="field.type === 'Form.TextField'">
          <input
            :id="field.props?.id"
            type="text"
            data-form-text-field
            :data-autofocus="field.props?.autoFocus ? '' : null"
            :value="formValues[field.props.id] ?? field.props?.defaultValue ?? ''"
            :placeholder="field.props?.placeholder"
            class="w-full bg-[var(--rc-surface-hover)] border rounded-xl px-3.5 py-2.5 text-[var(--rc-text-primary)] placeholder:text-[var(--rc-text-faint)] outline-none transition-all duration-150"
            :class="[
              field.props?.error
                ? 'border-[var(--rc-error)] focus:border-[var(--rc-error)] focus:ring-2 focus:ring-[var(--rc-error-subtle)]'
                : 'border-[var(--rc-border)] focus:border-[var(--rc-accent)] focus:ring-2 focus:ring-[var(--rc-accent-subtle)]'
            ]"
            @input="e => updateFieldValue(field, e.target.value)"
          />
        </div>

        <!-- 1b. Form.PasswordField 密码输入 -->
        <div v-else-if="field.type === 'Form.PasswordField'" class="relative flex items-center">
          <input
            :id="field.props?.id"
            :type="revealedPasswords[field.props?.id] ? 'text' : 'password'"
            data-form-text-field
            :data-autofocus="field.props?.autoFocus ? '' : null"
            :value="formValues[field.props.id] ?? field.props?.defaultValue ?? ''"
            :placeholder="field.props?.placeholder || '请输入密码...'"
            class="w-full bg-[var(--rc-surface-hover)] border rounded-xl pl-3.5 pr-16 py-2.5 text-[var(--rc-text-primary)] placeholder:text-[var(--rc-text-faint)] outline-none transition-all duration-150 font-mono"
            :class="[
              field.props?.error
                ? 'border-[var(--rc-error)] focus:border-[var(--rc-error)] focus:ring-2 focus:ring-[var(--rc-error-subtle)]'
                : 'border-[var(--rc-border)] focus:border-[var(--rc-accent)] focus:ring-2 focus:ring-[var(--rc-accent-subtle)]'
            ]"
            @input="e => updateFieldValue(field, e.target.value)"
          />
          <button
            type="button"
            class="absolute right-2.5 px-2 py-1 rounded text-xs text-[var(--rc-text-muted)] hover:text-[var(--rc-text-primary)] bg-[var(--rc-surface-subtle)] border border-[var(--rc-border)] cursor-pointer"
            @click="togglePasswordReveal(field.props?.id)"
          >
            {{ revealedPasswords[field.props?.id] ? '隐藏' : '显示' }}
          </button>
        </div>

        <!-- 2. Form.TextArea 多行输入 -->
        <div v-else-if="field.type === 'Form.TextArea'">
          <textarea
            :id="field.props?.id"
            rows="5"
            data-form-text-field
            :data-autofocus="field.props?.autoFocus ? '' : null"
            :value="formValues[field.props.id] ?? field.props?.defaultValue ?? ''"
            :placeholder="field.props?.placeholder"
            class="w-full bg-[var(--rc-surface-hover)] border rounded-xl px-3.5 py-2.5 text-[var(--rc-text-primary)] placeholder:text-[var(--rc-text-faint)] outline-none transition-all duration-150 resize-y font-mono text-xs leading-relaxed"
            :class="[
              field.props?.error
                ? 'border-[var(--rc-error)] focus:border-[var(--rc-error)] focus:ring-2 focus:ring-[var(--rc-error-subtle)]'
                : 'border-[var(--rc-border)] focus:border-[var(--rc-accent)] focus:ring-2 focus:ring-[var(--rc-accent-subtle)]'
            ]"
            @input="e => updateFieldValue(field, e.target.value)"
          />
        </div>

        <!-- 3. Form.Checkbox 复选框 -->
        <div v-else-if="field.type === 'Form.Checkbox'" class="flex items-center gap-2.5 pt-1">
          <input
            :id="field.props?.id"
            type="checkbox"
            :checked="formValues[field.props.id] ?? field.props?.defaultValue ?? false"
            class="w-4 h-4 rounded border-[var(--rc-border-highlight)] bg-[var(--rc-surface-hover)] text-[var(--rc-accent-text)] focus:ring-[var(--rc-accent-subtle)] focus:ring-offset-0 cursor-pointer"
            @change="e => updateFieldValue(field, e.target.checked)"
          />
          <label
            :for="field.props?.id"
            class="text-sm text-[var(--rc-text-secondary)] cursor-pointer select-none"
          >
            {{ field.props?.label }}
          </label>
        </div>

        <!-- 4. Form.Dropdown 下拉选择 -->
        <div v-else-if="field.type === 'Form.Dropdown'">
          <select
            :id="field.props?.id"
            :value="formValues[field.props.id] ?? field.props?.defaultValue"
            class="w-full bg-[var(--rc-surface)] border border-[var(--rc-border)] rounded-xl px-3.5 py-2.5 text-[var(--rc-text-primary)] outline-none focus:border-[var(--rc-accent)] cursor-pointer transition-all"
            @change="e => updateFieldValue(field, e.target.value)"
          >
            <template v-for="(group, gIdx) in getDropdownGroups(field)" :key="gIdx">
              <optgroup v-if="group.title" :label="group.title">
                <option
                  v-for="(item, iIdx) in group.items"
                  :key="iIdx"
                  :value="item.props?.value"
                  class="bg-[var(--rc-surface)] text-[var(--rc-text-primary)]"
                >
                  {{ item.props?.title }}
                </option>
              </optgroup>
              <template v-else>
                <option
                  v-for="(item, iIdx) in group.items"
                  :key="iIdx"
                  :value="item.props?.value"
                  class="bg-[var(--rc-surface)] text-[var(--rc-text-primary)]"
                >
                  {{ item.props?.title }}
                </option>
              </template>
            </template>
          </select>
        </div>

        <!-- 5. Form.Description 说明文字 -->
        <div
          v-else-if="field.type === 'Form.Description'"
          class="px-3.5 py-2.5 rounded-xl bg-[var(--rc-surface-subtle)] border border-[var(--rc-border)] text-xs text-[var(--rc-text-secondary)] leading-relaxed whitespace-pre-wrap break-words select-text"
        >
          {{ field.props?.text }}
        </div>

        <!-- 6. Form.Separator 分割线 -->
        <hr v-else-if="field.type === 'Form.Separator'" class="border-[var(--rc-border)] my-3" />

        <!-- 字段校验错误提示 -->
        <div v-if="field.props?.error" class="text-xs text-[var(--rc-error)] flex items-center gap-1 mt-1">
          <svg class="w-3.5 h-3.5 fill-current" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
          </svg>
          <span>{{ field.props.error }}</span>
        </div>
      </div>

      <!-- 表单内嵌可视化提交与取消按钮栏 (直观供鼠标点击) -->
      <div class="pt-4 border-t border-[var(--rc-border)] flex items-center justify-end gap-3">
        <button
          v-if="canCancel"
          type="button"
          class="px-4 py-2 rounded-xl text-xs font-medium text-[var(--rc-text-secondary)] hover:text-[var(--rc-text-primary)] bg-[var(--rc-surface-hover)] border border-[var(--rc-border)] transition-all cursor-pointer"
          @click="emit('cancel')"
        >
          取消 / 返回 (Esc)
        </button>
        <button
          v-for="(secAct, sIdx) in secondaryFormActions"
          :key="sIdx"
          type="button"
          class="px-4 py-2 rounded-xl text-xs font-medium text-[var(--rc-text-primary)] bg-[var(--rc-surface-hover)] hover:bg-[var(--rc-surface-active)] border border-[var(--rc-border)] transition-all cursor-pointer"
          @click="emit('trigger-action', secAct)"
        >
          {{ secAct.props?.title }}
        </button>
        <button
          type="button"
          class="px-5 py-2 rounded-xl text-xs font-semibold bg-[var(--rc-accent)] hover:bg-[var(--rc-accent-hover)] text-[var(--rc-accent-contrast)] shadow-sm transition-all cursor-pointer flex items-center gap-1.5"
          @click="submitForm"
        >
          <span>✓</span>
          <span>{{ submitActionTitle }} (Enter)</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from "vue";

const props = defineProps({
  descriptor: {
    type: Object,
    required: true
  },
  actions: {
    type: Array,
    default: () => []
  },
  canCancel: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(["submit", "cancel", "trigger-action"]);

const formRootRef = ref(null);
const formValues = ref({});
const revealedPasswords = ref({});

function togglePasswordReveal(id) {
  if (!id) return;
  revealedPasswords.value[id] = !revealedPasswords.value[id];
}

const formFields = computed(() => {
  return (props.descriptor.children || []).filter(
    (c) =>
      c.type === "Form.TextField" ||
      c.type === "Form.PasswordField" ||
      c.type === "Form.TextArea" ||
      c.type === "Form.Checkbox" ||
      c.type === "Form.Dropdown" ||
      c.type === "Form.Description" ||
      c.type === "Form.Separator"
  );
});

const submitActionTitle = computed(() => {
  const first = (props.actions || [])[0];
  return first?.props?.title || "提交保存";
});

const secondaryFormActions = computed(() => {
  return (props.actions || []).slice(1, 3);
});

/** 下拉选项按分组展开：直接子项归入无标题分组，Form.Dropdown.Section 内的选项归入该分组（optgroup） */
function getDropdownGroups(field) {
  const groups = [];
  for (const child of field.children || []) {
    if (child?.type === "Form.Dropdown.Item") {
      const last = groups[groups.length - 1];
      if (last && !last.title) last.items.push(child);
      else groups.push({ title: "", items: [child] });
    } else if (child?.type === "Form.Dropdown.Section") {
      const items = (child.children || []).filter((c) => c?.type === "Form.Dropdown.Item");
      if (items.length > 0) groups.push({ title: String(child.props?.title || ""), items });
    }
  }
  return groups;
}

function updateFieldValue(field, value) {
  formValues.value[field.props.id] = value;
  if (field.props?.onChange) {
    field.props.onChange(value);
  }
}

// 初始化默认值
watch(
  formFields,
  (fields) => {
    for (const f of fields) {
      const id = f.props?.id;
      if (id && formValues.value[id] === undefined) {
        if (f.props?.value !== undefined) {
          formValues.value[id] = f.props.value;
        } else if (f.props?.defaultValue !== undefined) {
          formValues.value[id] = f.props.defaultValue;
        }
      }
    }
  },
  { immediate: true }
);

// 监听外界 props.value 传入同步
watch(
  () => props.descriptor,
  (desc) => {
    const fields = (desc.children || []);
    for (const f of fields) {
      const id = f.props?.id;
      if (id && f.props?.value !== undefined) {
        formValues.value[id] = f.props.value;
      }
    }
  },
  { deep: true }
);

/**
 * 聚焦带 autoFocus 的字段，否则聚焦首个文本输入框（单行 / 密码 / 多行），光标放到已有内容末尾。
 * 返回是否成功聚焦，供宿主在关闭动作面板 / 确认框后回焦复用。
 */
function focusFirstField() {
  const root = formRootRef.value;
  if (!root || typeof root.querySelector !== "function") return false;
  const el = root.querySelector("[data-form-text-field][data-autofocus]") || root.querySelector("[data-form-text-field]");
  if (!el || typeof el.focus !== "function") return false;
  el.focus({ preventScroll: false });
  try {
    const len = typeof el.value === "string" ? el.value.length : 0;
    el.setSelectionRange?.(len, len);
  } catch (err) {
    console.warn('[FormRenderer] 设置输入框光标位置失败:', err)
  }
  return typeof document === "undefined" || document.activeElement === el;
}

function focusFirstFieldIfIdle() {
  const root = formRootRef.value;
  if (!root || typeof document === "undefined") return;
  // 用户已经在表单里操作（例如正在填第 2 个字段），不抢焦点
  if (root.contains(document.activeElement)) return;
  focusFirstField();
}

onMounted(() => {
  nextTick(() => focusFirstFieldIfIdle());
});

// 同一个表单组件换成另一张表单（字段集合变化）时重新聚焦；普通的值更新不触发
watch(
  () => formFields.value.map((f) => `${f.type}:${f.props?.id ?? ""}`).join("|"),
  (next, prev) => {
    if (next !== prev) nextTick(() => focusFirstFieldIfIdle());
  }
);

function submitForm() {
  emit("submit", { ...formValues.value });
  return { ...formValues.value };
}

defineExpose({
  getValues: () => ({ ...formValues.value }),
  submitForm,
  focusFirstField
});
</script>
