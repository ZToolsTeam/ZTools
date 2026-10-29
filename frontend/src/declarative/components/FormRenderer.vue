<template>
  <div ref="formRootRef" class="flex flex-col h-full overflow-hidden select-none">
    <!-- 表单滚动容器 -->
    <div class="flex-1 overflow-y-auto declarative-scrollbar p-6 space-y-5 max-w-2xl mx-auto w-full">
      <div
        v-for="(field, fIdx) in formFields"
        :key="field.props?.id || fIdx"
        class="space-y-1.5 text-[13px]"
      >
        <!-- 标签：插件没写 title 时不显示标签行，不拿字段 id 充当标签 -->
        <label
          v-if="fieldTitle(field) && field.type !== 'Form.Checkbox'"
          :for="field.props?.id"
          class="block font-medium text-[var(--rc-text-primary)]"
        >
          {{ fieldTitle(field) }}
        </label>

        <!-- 1. Form.TextField 单行输入 -->
        <DeclInput
          v-if="field.type === 'Form.TextField'"
          :id="field.props?.id"
          data-form-text-field
          :data-autofocus="field.props?.autoFocus ? '' : null"
          :model-value="fieldText(field)"
          :placeholder="field.props?.placeholder"
          :monospace="field.props?.monospace === true"
          :invalid="Boolean(field.props?.error)"
          :describedby="describedBy(field)"
          @update:model-value="value => updateFieldValue(field, value)"
        />

        <!-- 1b. Form.PasswordField 密码输入 -->
        <DeclInput
          v-else-if="field.type === 'Form.PasswordField'"
          :id="field.props?.id"
          :type="revealedPasswords[field.props?.id] ? 'text' : 'password'"
          data-form-text-field
          :data-autofocus="field.props?.autoFocus ? '' : null"
          :model-value="fieldText(field)"
          :placeholder="field.props?.placeholder || '请输入密码'"
          :invalid="Boolean(field.props?.error)"
          :describedby="describedBy(field)"
          @update:model-value="value => updateFieldValue(field, value)"
        >
          <template #trailing>
            <button
              type="button"
              class="decl-reveal-btn"
              :aria-pressed="revealedPasswords[field.props?.id] ? 'true' : 'false'"
              @click="togglePasswordReveal(field.props?.id)"
            >
              {{ revealedPasswords[field.props?.id] ? '隐藏' : '显示' }}
            </button>
          </template>
        </DeclInput>

        <!-- 2. Form.TextArea 多行输入：正文字体，插件声明 monospace 时才用等宽 -->
        <DeclInput
          v-else-if="field.type === 'Form.TextArea'"
          :id="field.props?.id"
          multiline
          :rows="5"
          data-form-text-field
          :data-autofocus="field.props?.autoFocus ? '' : null"
          :model-value="fieldText(field)"
          :placeholder="field.props?.placeholder"
          :monospace="field.props?.monospace === true"
          :invalid="Boolean(field.props?.error)"
          :describedby="describedBy(field)"
          @update:model-value="value => updateFieldValue(field, value)"
        />

        <!-- 3. Form.Checkbox 复选框（有 title 时作为分组标题显示在上方） -->
        <template v-else-if="field.type === 'Form.Checkbox'">
          <div v-if="fieldTitle(field)" class="font-medium text-[var(--rc-text-primary)]">{{ fieldTitle(field) }}</div>
          <div class="flex items-center gap-2.5">
            <DeclCheckbox
              :id="field.props?.id"
              :checked="formValues[field.props.id] ?? field.props?.defaultValue ?? false"
              :aria-label="field.props?.label || fieldTitle(field)"
              :aria-invalid="field.props?.error ? 'true' : undefined"
              :aria-describedby="describedBy(field) || undefined"
              @change="value => updateFieldValue(field, value)"
            />
            <label
              :for="field.props?.id"
              class="text-[13px] text-[var(--rc-text-secondary)] cursor-pointer select-none"
            >
              {{ field.props?.label }}
            </label>
          </div>
        </template>

        <!-- 4. Form.Dropdown 下拉选择 -->
        <div v-else-if="field.type === 'Form.Dropdown'">
          <RcSelect
            :id="field.props?.id"
            class="w-full"
            :value="dropdownDisplayValue(field)"
            :options="getDropdownOptions(field)"
            :aria-label="field.props?.title || undefined"
            @update:value="value => updateFieldValue(field, value)"
          />
        </div>

        <!-- 5. Form.Description 说明文字 -->
        <div
          v-else-if="field.type === 'Form.Description'"
          class="px-3 py-2.5 rounded-[var(--rc-radius-md)] bg-[var(--rc-surface-subtle)] border border-[var(--rc-border)] text-xs text-[var(--rc-text-secondary)] leading-relaxed whitespace-pre-wrap break-words select-text"
        >
          {{ field.props?.text }}
        </div>

        <!-- 6. Form.Separator 分割线 -->
        <hr v-else-if="field.type === 'Form.Separator'" class="border-[var(--rc-border)] my-3" />

        <!-- 字段说明（info）：输入框下方的辅助文字；有错误时让位给错误提示 -->
        <p
          v-if="field.props?.info && !field.props?.error"
          :id="infoId(field)"
          class="decl-field-info text-xs leading-relaxed text-[var(--rc-text-muted)]"
        >
          {{ field.props.info }}
        </p>

        <!-- 字段校验错误提示 -->
        <p
          v-if="field.props?.error"
          :id="errorId(field)"
          class="decl-field-error text-xs text-[var(--rc-error)] flex items-center gap-1"
        >
          <CircleAlertIcon class="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
          <span>{{ field.props.error }}</span>
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { CircleAlertIcon } from '@lucide/vue'
import { RcSelect } from '@/components/base'
import { ref, computed, watch, onMounted, nextTick } from "vue";
import DeclInput from "./DeclInput.vue";
import DeclCheckbox from "./DeclCheckbox.vue";

const props = defineProps({
  descriptor: {
    type: Object,
    required: true
  },
  actions: {
    type: Array,
    default: () => []
  }
});

// 提交、取消与其它动作统一由宿主底栏（主动作 ⌘↵ / 后退 Esc / 动作面板 ⌘K）承担，表单内不再重复渲染按钮
const emit = defineEmits(["submit", "trigger-action"]);

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

/** 文本类字段当前显示的值 */
function fieldText(field) {
  const value = formValues.value[field.props?.id] ?? field.props?.defaultValue ?? "";
  return value === null ? "" : value;
}

// 错误与说明文字的元素 id：供输入框 aria-describedby 关联，读屏时一并朗读
function errorId(field) {
  return field?.props?.id ? `${field.props.id}-error` : undefined;
}

function infoId(field) {
  return field?.props?.id ? `${field.props.id}-info` : undefined;
}

function describedBy(field) {
  if (!field?.props?.id) return "";
  if (field.props.error) return errorId(field);
  if (field.props.info) return infoId(field);
  return "";
}

function fieldTitle(field) {
  const title = field?.props?.title;
  if (title === undefined || title === null) return "";
  return String(title).trim();
}

/** 转成 RcSelect 选项：无标题分组的选项平铺，有标题的分组用 { label, options } */
function getDropdownOptions(field) {
  return getDropdownGroups(field).flatMap((group) => {
    const options = group.items.map((item) => ({ label: String(item.props?.title ?? ""), value: String(item.props?.value ?? "") }));
    return group.title ? [{ label: group.title, options }] : options;
  });
}

/** 下拉框显示的值：用户选的值 → defaultValue → 第一个选项（与原生 select 一致，不留空白） */
function dropdownDisplayValue(field) {
  const value = formValues.value[field.props.id] ?? field.props?.defaultValue;
  if (value !== undefined && value !== null && value !== "") return String(value);
  const first = getDropdownGroups(field)[0]?.items[0]?.props?.value;
  return first === undefined || first === null ? undefined : String(first);
}

/** 下拉选项按分组展开：直接子项归入无标题分组，Form.Dropdown.Section 内的选项归入该分组 */
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

<style scoped>
.decl-reveal-btn {
  height: 24px;
  padding: 0 8px;
  border-radius: var(--rc-radius-sm);
  border: 1px solid var(--rc-border);
  background: var(--rc-surface-subtle);
  color: var(--rc-text-muted);
  font-size: 12px;
  cursor: pointer;
}

.decl-reveal-btn:hover {
  color: var(--rc-text-primary);
}
</style>
