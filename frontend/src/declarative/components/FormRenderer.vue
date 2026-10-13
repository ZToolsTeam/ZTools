<template>
  <div class="flex flex-col h-full overflow-hidden select-none">
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
            class="font-medium text-slate-200 flex items-center gap-1.5"
          >
            <span>{{ field.props?.title || field.props?.id }}</span>
          </label>
          <span v-if="field.props?.info" class="text-xs text-slate-400">
            {{ field.props.info }}
          </span>
        </div>

        <!-- 1. Form.TextField 单行输入 -->
        <div v-if="field.type === 'Form.TextField'">
          <input
            :id="field.props?.id"
            type="text"
            :value="formValues[field.props.id] ?? field.props?.defaultValue ?? ''"
            :placeholder="field.props?.placeholder"
            class="w-full bg-white/5 border rounded-xl px-3.5 py-2.5 text-slate-100 placeholder-slate-500 outline-none transition-all duration-150"
            :class="[
              field.props?.error
                ? 'border-rose-500/50 focus:border-rose-400 focus:ring-2 focus:ring-rose-500/20'
                : 'border-white/10 focus:border-sky-400 focus:ring-2 focus:ring-sky-500/20'
            ]"
            @input="e => updateFieldValue(field, e.target.value)"
          />
        </div>

        <!-- 2. Form.TextArea 多行输入 -->
        <div v-else-if="field.type === 'Form.TextArea'">
          <textarea
            :id="field.props?.id"
            rows="5"
            :value="formValues[field.props.id] ?? field.props?.defaultValue ?? ''"
            :placeholder="field.props?.placeholder"
            class="w-full bg-white/5 border rounded-xl px-3.5 py-2.5 text-slate-100 placeholder-slate-500 outline-none transition-all duration-150 resize-y font-mono text-xs leading-relaxed"
            :class="[
              field.props?.error
                ? 'border-rose-500/50 focus:border-rose-400 focus:ring-2 focus:ring-rose-500/20'
                : 'border-white/10 focus:border-sky-400 focus:ring-2 focus:ring-sky-500/20'
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
            class="w-4 h-4 rounded border-white/20 bg-white/5 text-sky-500 focus:ring-sky-500 focus:ring-offset-0 cursor-pointer"
            @change="e => updateFieldValue(field, e.target.checked)"
          />
          <label
            :for="field.props?.id"
            class="text-sm text-slate-300 cursor-pointer select-none"
          >
            {{ field.props?.label }}
          </label>
        </div>

        <!-- 4. Form.Dropdown 下拉选择 -->
        <div v-else-if="field.type === 'Form.Dropdown'">
          <select
            :id="field.props?.id"
            :value="formValues[field.props.id] ?? field.props?.defaultValue"
            class="w-full bg-slate-800/80 border border-white/10 rounded-xl px-3.5 py-2.5 text-slate-100 outline-none focus:border-sky-400 cursor-pointer transition-all"
            @change="e => updateFieldValue(field, e.target.value)"
          >
            <option
              v-for="(item, iIdx) in getDropdownItems(field)"
              :key="iIdx"
              :value="item.props?.value"
              class="bg-slate-800 text-slate-200"
            >
              {{ item.props?.title }}
            </option>
          </select>
        </div>

        <!-- 字段校验错误提示 -->
        <div v-if="field.props?.error" class="text-xs text-rose-400 flex items-center gap-1 mt-1">
          <svg class="w-3.5 h-3.5 fill-current" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
          </svg>
          <span>{{ field.props.error }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from "vue";

const props = defineProps({
  descriptor: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(["submit"]);

const formValues = ref({});

const formFields = computed(() => {
  return (props.descriptor.children || []).filter(
    (c) =>
      c.type === "Form.TextField" ||
      c.type === "Form.TextArea" ||
      c.type === "Form.Checkbox" ||
      c.type === "Form.Dropdown"
  );
});

function getDropdownItems(field) {
  return (field.children || []).filter((c) => c.type === "Form.Dropdown.Item");
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

function submitForm() {
  emit("submit", { ...formValues.value });
  return { ...formValues.value };
}

defineExpose({
  getValues: () => ({ ...formValues.value }),
  submitForm
});
</script>
