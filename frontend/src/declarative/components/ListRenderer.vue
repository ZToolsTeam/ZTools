<template>
  <div class="flex flex-col h-full overflow-hidden select-none">
    <!-- 顶部搜索栏与筛选器 -->
    <div class="px-4 py-3 border-b border-white/10 flex items-center gap-3 bg-white/[0.02]">
      <DeclarativeIcon icon="magnifying-glass" :size="18" class="text-slate-400" />
      <input
        ref="searchInputRef"
        :value="descriptor.props?.searchText ?? localSearchText"
        type="text"
        :placeholder="descriptor.props?.searchBarPlaceholder || '搜索...'"
        class="flex-1 bg-transparent text-sm text-slate-100 placeholder-slate-400 outline-none"
        @input="handleSearchInput"
        @keydown.down.prevent="focusNextItem"
        @keydown.up.prevent="focusPrevItem"
      />

      <!-- 搜索栏右侧下拉筛选器 (List.Dropdown) -->
      <div v-if="searchBarAccessory" class="flex-shrink-0">
        <select
          :value="searchBarAccessory.props?.value || searchBarAccessory.props?.defaultValue"
          class="bg-white/10 text-xs text-slate-200 border border-white/10 rounded-md px-2 py-1 outline-none cursor-pointer hover:bg-white/15"
          @change="handleDropdownChange"
        >
          <option
            v-for="(opt, oIdx) in dropdownOptions"
            :key="oIdx"
            :value="opt.props?.value"
            class="bg-slate-800 text-slate-200"
          >
            {{ opt.props?.title }}
          </option>
        </select>
      </div>

      <!-- 加载微动效 -->
      <div v-if="descriptor.props?.isLoading" class="animate-spin text-sky-400">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      </div>
    </div>

    <!-- 列表主体容器 -->
    <div class="flex-1 flex overflow-hidden">
      <!-- 左侧列表条目 (开启详情时分配 45% 宽，未开启时 100% flex-1) -->
      <div
        ref="listScrollRef"
        class="overflow-y-auto declarative-scrollbar p-2 space-y-3 min-w-0"
        :class="[
          descriptor.props?.isShowingDetail && selectedItem?.props?.detail
            ? 'w-[45%] flex-shrink-0'
            : 'flex-1'
        ]"
      >
        <!-- 分组遍历 -->
        <div v-for="(sec, sIdx) in sections" :key="sIdx" class="space-y-1">
          <div
            v-if="sec.title"
            class="px-3 py-1 text-xs font-semibold text-slate-400 uppercase tracking-wider"
          >
            {{ sec.title }}
          </div>

          <!-- Items 遍历 -->
          <div
            v-for="(item, iIdx) in sec.items"
            :key="item.id || `${sIdx}-${iIdx}`"
            :ref="el => registerItemEl(item, el)"
            class="flex items-center justify-between px-3 py-2.5 rounded-xl text-sm cursor-pointer transition-all duration-100"
            :class="[
              selectedItem === item
                ? 'bg-sky-500/15 text-white font-medium shadow-sm border border-sky-500/30'
                : 'text-slate-300 hover:bg-white/5 border border-transparent'
            ]"
            @click="selectItem(item)"
            @dblclick="emit('trigger-primary', item)"
          >
            <!-- 左侧图标与文本 -->
            <div class="flex items-center gap-3 min-w-0 flex-1">
              <DeclarativeIcon
                v-if="item.props?.icon"
                :icon="item.props.icon"
                :size="18"
                :class="selectedItem === item ? 'text-sky-400' : 'text-slate-400'"
              />
              <div class="flex items-baseline gap-2 min-w-0">
                <span class="truncate font-normal">{{ item.props?.title }}</span>
                <span
                  v-if="item.props?.subtitle"
                  class="text-xs text-slate-400 truncate"
                >
                  {{ item.props.subtitle }}
                </span>
              </div>
            </div>

            <!-- 右侧 Accessories 标签 -->
            <div
              v-if="item.props?.accessories && item.props.accessories.length > 0"
              class="flex items-center gap-2 flex-shrink-0"
            >
              <span
                v-for="(acc, aIdx) in item.props.accessories"
                :key="aIdx"
                class="px-2 py-0.5 text-xs text-slate-400 bg-white/5 border border-white/5 rounded-md"
              >
                {{ typeof acc.text === 'object' ? acc.text.value : acc.text }}
              </span>
            </div>
          </div>
        </div>

        <div
          v-if="flatItems.length === 0"
          class="p-12 text-center text-sm text-slate-400"
        >
          未找到匹配条目
        </div>
      </div>

      <!-- 右侧 Detail 分栏 (如果启用了 isShowingDetail，分配 55% 宽并纵向堆叠展示，对齐 Raycast Master-Detail 规范) -->
      <div
        v-if="descriptor.props?.isShowingDetail && selectedItem?.props?.detail"
        class="w-[55%] border-l border-white/10 overflow-hidden flex flex-col bg-white/[0.01]"
      >
        <DetailRenderer :descriptor="selectedItem.props.detail" :is-list-detail="true" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from "vue";
import DeclarativeIcon from "./DeclarativeIcon.vue";
import DetailRenderer from "./DetailRenderer.vue";

const props = defineProps({
  descriptor: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(["select", "trigger-primary", "action-panel-change"]);

const searchInputRef = ref(null);
const listScrollRef = ref(null);
const localSearchText = ref("");
const selectedItem = ref(null);
const itemElements = new Map();

function registerItemEl(item, el) {
  if (el) {
    itemElements.set(item, el);
  }
}

// 解析 children 中的 Section 或 Item
const sections = computed(() => {
  const children = props.descriptor.children || [];
  const list = [];

  for (const child of children) {
    if (child.type === "List.Section") {
      list.push({
        title: child.props?.title,
        items: (child.children || []).filter(c => c.type === "List.Item")
      });
    } else if (child.type === "List.Item") {
      list.push({
        title: null,
        items: [child]
      });
    }
  }

  return list;
});

const flatItems = computed(() => {
  const result = [];
  for (const sec of sections.value) {
    for (const item of sec.items) {
      result.push(item);
    }
  }
  return result;
});

// 筛选 Accessory
const searchBarAccessory = computed(() => {
  return props.descriptor.props?.searchBarAccessory || null;
});

const dropdownOptions = computed(() => {
  if (!searchBarAccessory.value) return [];
  return (searchBarAccessory.value.children || []).filter(c => c.type === "List.Dropdown.Item");
});

function handleDropdownChange(e) {
  const val = e.target.value;
  searchBarAccessory.value?.props?.onChange?.(val);
}

function handleSearchInput(e) {
  const val = e.target.value;
  localSearchText.value = val;
  if (props.descriptor.props?.onSearchTextChange) {
    props.descriptor.props.onSearchTextChange(val);
  }
}

function selectItem(item) {
  selectedItem.value = item;
  emit("select", item);
  emit("action-panel-change", item.props?.actions || props.descriptor.props?.actions);
}

function focusNextItem() {
  const items = flatItems.value;
  if (items.length === 0) return;
  const currIdx = items.indexOf(selectedItem.value);
  const nextIdx = (currIdx + 1) % items.length;
  selectItem(items[nextIdx]);
  scrollToSelected();
}

function focusPrevItem() {
  const items = flatItems.value;
  if (items.length === 0) return;
  const currIdx = items.indexOf(selectedItem.value);
  const prevIdx = (currIdx - 1 + items.length) % items.length;
  selectItem(items[prevIdx]);
  scrollToSelected();
}

function scrollToSelected() {
  nextTick(() => {
    if (!selectedItem.value) return;
    const el = itemElements.get(selectedItem.value);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });
}

watch(flatItems, (items) => {
  if (items.length > 0 && (!selectedItem.value || !items.includes(selectedItem.value))) {
    selectItem(items[0]);
  }
}, { immediate: true });

onMounted(() => {
  searchInputRef.value?.focus();
});

defineExpose({
  focusNextItem,
  focusPrevItem,
  getSelectedItem: () => selectedItem.value,
  focusSearch: () => searchInputRef.value?.focus()
});
</script>
