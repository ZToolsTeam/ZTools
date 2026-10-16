<template>
  <div class="flex flex-col h-full overflow-hidden select-none">
    <!-- 顶栏系统监控看板 (MetricGrid) -->
    <div
      v-if="metricGridData?.items && metricGridData.items.length > 0"
      class="px-4 py-2.5 border-b border-white/10 bg-white/[0.015] grid gap-2.5"
      :style="{ gridTemplateColumns: `repeat(auto-fit, minmax(168px, 1fr))` }"
    >
      <div
        v-for="(m, mIdx) in metricGridData.items"
        :key="m.id || mIdx"
        class="bg-white/[0.03] hover:bg-white/[0.05] border border-white/10 rounded-xl px-3 py-2.5 flex flex-col justify-between transition-all min-w-0"
      >
        <div class="flex items-center justify-between gap-1.5 text-xs text-slate-300 mb-1 min-w-0">
          <span class="font-medium whitespace-nowrap overflow-hidden text-ellipsis" :title="m.label">{{ m.label }}</span>
          <span
            v-if="m.status"
            class="text-[10px] px-1.5 py-0.2 rounded font-medium flex-shrink-0"
            :class="{
              'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20': m.status === 'success' || m.status === 'normal',
              'bg-amber-500/15 text-amber-400 border border-amber-500/20': m.status === 'warning',
              'bg-rose-500/15 text-rose-400 border border-rose-500/20': m.status === 'danger'
            }"
          >
            {{ m.status === 'danger' ? '高负荷' : m.status === 'warning' ? '关注' : '正常' }}
          </span>
        </div>
        <div class="flex items-baseline justify-between gap-2 min-w-0">
          <span class="text-base font-bold text-slate-100 font-mono tracking-tight whitespace-nowrap">{{ m.value }}</span>
          <span
            v-if="m.subValue"
            class="text-[11px] text-slate-400 font-mono truncate"
            :title="m.subValue"
          >
            {{ m.subValue }}
          </span>
        </div>
        <div v-if="typeof m.progress === 'number'" class="w-full bg-white/10 h-1.5 rounded-full overflow-hidden mt-2">
          <div
            class="h-full transition-all duration-300 rounded-full"
            :class="{
              'bg-rose-500': m.progress > 85,
              'bg-amber-500': m.progress > 60 && m.progress <= 85,
              'bg-sky-400': m.progress <= 60
            }"
            :style="{ width: `${Math.min(100, Math.max(0, m.progress))}%` }"
          />
        </div>
      </div>
    </div>

    <!-- 多色比例分布条与图例胶囊 (DistributionBar) -->
    <div
      v-if="distributionBarData?.segments && distributionBarData.segments.length > 0"
      class="px-4 py-2 border-b border-white/10 bg-white/[0.012] space-y-2"
    >
      <div class="flex items-center justify-between text-[11px] text-slate-300">
        <span class="font-medium">{{ distributionBarData.title || '类型体积分布占比' }}</span>
        <span v-if="distributionBarData.totalText || distributionBarData.totalLabel" class="font-mono text-slate-400">
          {{ distributionBarData.totalText || distributionBarData.totalLabel }}
        </span>
      </div>
      <!-- 多色堆叠比例条 -->
      <div class="w-full h-2.5 bg-white/10 rounded-full overflow-hidden flex gap-0.5 p-0.5">
        <div
          v-for="seg in distributionBarData.segments"
          :key="seg.id"
          class="h-full transition-all duration-300 cursor-pointer first:rounded-l-full last:rounded-r-full hover:brightness-125"
          :style="{
            width: `${Math.max(1.2, seg.percent)}%`,
            backgroundColor: seg.color || '#38bdf8',
            opacity:
              !(distributionBarData.activeId || distributionBarData.activeSegmentId) ||
              (distributionBarData.activeId || distributionBarData.activeSegmentId) === 'ALL' ||
              (distributionBarData.activeId || distributionBarData.activeSegmentId) === 'all' ||
              (distributionBarData.activeId || distributionBarData.activeSegmentId) === seg.id
                ? 1
                : 0.35
          }"
          :title="`${seg.label}: ${seg.valueText || seg.formattedSize || ''} (${Number(seg.percent || 0).toFixed(1)}%)`"
          @click="handleDistributionSelect(seg.id)"
        />
      </div>
      <!-- 可点击图例胶囊 -->
      <div class="flex items-center gap-1.5 flex-wrap">
        <button
          v-for="seg in distributionBarData.segments"
          :key="`leg-${seg.id}`"
          class="px-2 py-0.5 rounded-md text-[11px] flex items-center gap-1.5 flex-shrink-0 transition-all border"
          :class="[
            (distributionBarData.activeId || distributionBarData.activeSegmentId) === seg.id
              ? 'bg-white/15 text-white border-white/30 font-semibold shadow-sm'
              : 'bg-white/[0.03] text-slate-300 border-white/5 hover:bg-white/10'
          ]"
          @click="handleDistributionSelect(seg.id)"
        >
          <span class="w-2 h-2 rounded-full flex-shrink-0" :style="{ backgroundColor: seg.color || '#38bdf8' }" />
          <span>{{ seg.label }}</span>
          <span class="font-mono text-[10px] text-slate-400">{{ seg.valueText || seg.formattedSize }}</span>
          <span class="font-mono text-[10px] text-slate-500">{{ Number(seg.percent || 0).toFixed(0) }}%</span>
        </button>
      </div>
    </div>

    <!-- 顶部搜索栏与筛选器 -->
    <div class="px-4 py-2 border-b border-white/10 flex items-center gap-3 bg-white/[0.02]">
      <DeclarativeIcon icon="magnifying-glass" :size="18" class="text-slate-400 flex-shrink-0" />
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
      <div v-if="descriptor.props?.isLoading" class="animate-spin text-sky-400 flex-shrink-0">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      </div>
    </div>

    <!-- 顶栏分段控制器 (SegmentedControl) -->
    <div
      v-if="segmentedControlData?.options && segmentedControlData.options.length > 0"
      class="px-4 py-1.5 border-b border-white/10 bg-white/[0.01] flex items-center gap-1.5 overflow-x-auto"
    >
      <button
        v-for="opt in segmentedControlData.options"
        :key="opt.value"
        class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all duration-150 flex items-center gap-1.5 flex-shrink-0"
        :class="[
          segmentedControlData.value === opt.value
            ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 shadow-sm'
            : 'text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent'
        ]"
        @click="handleSegmentedChange(opt.value)"
      >
        <DeclarativeIcon v-if="opt.icon" :icon="opt.icon" :size="12" />
        <span>{{ opt.label }}</span>
        <span
          v-if="opt.badge !== undefined"
          class="px-1.5 py-0.2 rounded-full text-[10px] font-mono"
          :class="segmentedControlData.value === opt.value ? 'bg-sky-400/20 text-sky-200' : 'bg-white/10 text-slate-400'"
        >
          {{ opt.badge }}
        </span>
      </button>
    </div>

    <!-- 向导步骤条与多维二级筛选/批量工具栏 (FilterBar) -->
    <div
      v-if="filterBarData && ((filterBarData.wizardSteps && filterBarData.wizardSteps.length > 0) || (filterBarData.groups && filterBarData.groups.length > 0) || (filterBarData.actions && filterBarData.actions.length > 0) || filterBarData.summaryText)"
      class="px-4 py-1.5 border-b border-white/10 bg-white/[0.018] flex flex-col gap-1.5"
    >
      <!-- 第一行：向导步骤状态条 / 实时汇总文字 + 右侧快捷批量操作按钮 -->
      <div
        v-if="(filterBarData.wizardSteps && filterBarData.wizardSteps.length > 0) || filterBarData.summaryText || (filterBarData.actions && filterBarData.actions.length > 0)"
        class="flex items-center justify-between gap-2 flex-wrap text-[11px]"
      >
        <div class="flex items-center gap-2.5 flex-wrap min-w-0">
          <div v-if="filterBarData.wizardSteps && filterBarData.wizardSteps.length > 0" class="flex items-center gap-1 flex-wrap">
            <template v-for="(step, stIdx) in filterBarData.wizardSteps" :key="step.id || stIdx">
              <button
                type="button"
                class="px-2 py-0.5 rounded-md font-medium flex items-center gap-1 flex-shrink-0 transition-all"
                :class="{
                  'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25 hover:bg-emerald-500/25': step.status === 'done',
                  'bg-sky-500/20 text-sky-300 border border-sky-500/35 font-semibold': step.status === 'active',
                  'bg-white/5 text-slate-500 border border-white/5 hover:text-slate-300': step.status === 'pending'
                }"
                @click="step.onSelect && step.onSelect()"
              >
                <span>{{ step.status === 'done' ? '✓' : '●' }}</span>
                <span>{{ step.label }}</span>
              </button>
              <span v-if="stIdx < filterBarData.wizardSteps.length - 1" class="text-slate-600">➔</span>
            </template>
          </div>
          <span v-if="filterBarData.summaryText" class="text-[11px] font-mono text-sky-300 truncate">
            {{ filterBarData.summaryText }}
          </span>
        </div>

        <!-- 右侧快捷批量操作按钮 -->
        <div
          v-if="filterBarData.actions && filterBarData.actions.length > 0"
          class="flex items-center gap-1.5 flex-shrink-0 ml-auto"
        >
          <button
            v-for="act in filterBarData.actions"
            :key="act.id"
            :disabled="act.disabled"
            class="px-2.5 py-0.5 rounded-lg text-[11px] font-medium transition-all flex items-center gap-1 border"
            :class="{
              'bg-sky-500/25 hover:bg-sky-500/35 text-sky-200 border-sky-400/40 shadow-sm': act.style === 'primary',
              'bg-rose-500/25 hover:bg-rose-500/35 text-rose-200 border-rose-400/40 shadow-sm': act.style === 'destructive' || act.style === 'danger',
              'bg-white/5 hover:bg-white/10 text-slate-300 border-white/10': !act.style || act.style === 'secondary',
              'opacity-40 cursor-not-allowed': act.disabled
            }"
            @click="act.onAction && act.onAction()"
          >
            <span>{{ act.label }}</span>
            <span v-if="act.badge !== undefined" class="font-mono text-[10px] px-1 rounded bg-black/20">{{ act.badge }}</span>
          </button>
        </div>
      </div>

      <!-- 第二行：多维筛选胶囊组 (支持自动折行展示全部筛选维度，无遮挡截断) -->
      <div
        v-if="filterBarData.groups && filterBarData.groups.length > 0"
        class="flex flex-wrap items-center gap-x-3 gap-y-1"
      >
        <div
          v-for="grp in filterBarData.groups"
          :key="grp.id"
          class="flex items-center gap-1 flex-wrap"
        >
          <span v-if="grp.label" class="text-[11px] text-slate-400 mr-0.5 font-medium">{{ grp.label }}:</span>
          <button
            v-for="opt in grp.options.slice(0, 7)"
            :key="opt.value"
            class="px-2 py-0.5 rounded-md text-[11px] transition-all flex items-center gap-1 flex-shrink-0 border"
            :class="[
              grp.value === opt.value
                ? 'bg-indigo-500/25 text-indigo-200 border-indigo-400/40 font-medium'
                : 'bg-white/[0.03] text-slate-400 border-white/5 hover:text-slate-200 hover:bg-white/10'
            ]"
            @click="grp.onChange && grp.onChange(opt.value)"
          >
            <span>{{ opt.label }}</span>
            <span v-if="opt.badge !== undefined" class="font-mono text-[10px] opacity-80">{{ opt.badge }}</span>
          </button>
        </div>
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
            ? 'w-[52%] flex-shrink-0'
            : 'flex-1'
        ]"
      >
        <!-- 分组遍历 -->
        <div v-for="(sec, sIdx) in sections" :key="sIdx" class="space-y-1">
          <div
            v-if="sec.title"
            class="px-3 py-1 text-xs font-semibold text-slate-300 flex items-center justify-between gap-2 bg-white/[0.02] rounded-lg border border-white/5"
          >
            <div class="flex items-center gap-2 min-w-0">
              <button
                v-if="sec.checkable"
                type="button"
                class="w-4 h-4 rounded flex items-center justify-center border transition-all flex-shrink-0"
                :class="[
                  sec.checked === true
                    ? 'bg-sky-500 border-sky-400 text-white'
                    : sec.checked === 'indeterminate'
                    ? 'bg-sky-500/40 border-sky-400 text-sky-200'
                    : 'bg-white/5 border-white/25 text-transparent hover:border-sky-400/60'
                ]"
                @click.stop="sec.onCheckChange && sec.onCheckChange(sec.checked !== true)"
              >
                <span class="text-[10px] leading-none font-bold">{{ sec.checked === 'indeterminate' ? '−' : '✓' }}</span>
              </button>
              <span class="truncate">{{ sec.title }}</span>
            </div>
            <span v-if="sec.subtitle" class="text-[11px] font-mono text-slate-400 flex-shrink-0">{{ sec.subtitle }}</span>
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
            @contextmenu.prevent="handleContextMenu(item)"
          >
            <!-- 左侧复选框、图标与文本 -->
            <div class="flex items-center gap-2.5 min-w-0 flex-1 overflow-hidden pr-2">
              <button
                v-if="item.props?.checkable"
                type="button"
                class="w-4 h-4 rounded flex items-center justify-center border transition-all flex-shrink-0"
                :class="[
                  item.props?.checked === true
                    ? 'bg-sky-500 border-sky-400 text-white'
                    : item.props?.checked === 'indeterminate'
                    ? 'bg-sky-500/40 border-sky-400 text-sky-200'
                    : 'bg-white/5 border-white/25 text-transparent hover:border-sky-400/60'
                ]"
                @click.stop="toggleItemCheck(item)"
              >
                <span class="text-[10px] leading-none font-bold">{{ item.props?.checked === 'indeterminate' ? '−' : '✓' }}</span>
              </button>
              <DeclarativeIcon
                v-if="item.props?.icon"
                :icon="item.props.icon"
                :size="18"
                :class="selectedItem === item ? 'text-sky-400' : 'text-slate-400'"
              />
              <div class="flex flex-col justify-center min-w-0 flex-1 overflow-hidden">
                <span class="truncate font-medium text-slate-100 leading-snug">{{ item.props?.title }}</span>
                <span
                  v-if="item.props?.subtitle"
                  class="text-[11px] text-slate-400 truncate leading-tight"
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
              <template v-for="(acc, aIdx) in item.props.accessories" :key="aIdx">
                <!-- Tag 徽章 -->
                <span
                  v-if="acc.tag"
                  class="px-2 py-0.5 text-xs rounded-md font-medium border"
                  :style="getTagStyle(acc.tag)"
                >
                  {{ typeof acc.tag === 'object' ? acc.tag.value : acc.tag }}
                </span>
                <!-- Text 文本标签 -->
                <span
                  v-else-if="acc.text"
                  class="px-2 py-0.5 text-xs font-mono text-slate-300 bg-white/5 border border-white/5 rounded-md"
                >
                  {{ typeof acc.text === 'object' ? acc.text.value : acc.text }}
                </span>
              </template>
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
  },
  initialSnapshot: {
    type: Object,
    default: null
  }
});

const emit = defineEmits(["select", "trigger-primary", "action-panel-change", "open-action-panel"]);

const searchInputRef = ref(null);
const listScrollRef = ref(null);
const localSearchText = ref("");
const selectedItem = ref(null);
const itemElements = new Map();
let filtersRestored = false;
let selectionRestored = false;

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
        subtitle: child.props?.subtitle,
        checkable: Boolean(child.props?.checkable),
        checked: child.props?.checked ?? false,
        onCheckChange: child.props?.onCheckChange,
        items: (child.children || []).filter(c => c.type === "List.Item")
      });
    } else if (child.type === "List.Item") {
      list.push({
        title: null,
        subtitle: null,
        checkable: false,
        checked: false,
        items: [child]
      });
    }
  }

  return list;
});

function toggleItemCheck(item) {
  const curr = item?.props?.checked === true;
  if (typeof item?.props?.onCheckChange === "function") {
    item.props.onCheckChange(!curr);
  }
}

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

// 顶栏指标看板数据
const metricGridData = computed(() => {
  const mg = props.descriptor.props?.metricGrid;
  if (!mg) return null;
  return mg.props || mg;
});

// 顶栏比例分布条数据
const distributionBarData = computed(() => {
  const db = props.descriptor.props?.distributionBar;
  if (!db) return null;
  return db.props || db;
});

function handleDistributionSelect(id) {
  const db = distributionBarData.value;
  if (!db) return;
  const currActive = db.activeId ?? db.activeSegmentId;
  const nextId = currActive === id ? undefined : id;
  if (typeof db.onSelectSegment === "function") {
    db.onSelectSegment(nextId);
  } else if (typeof db.onSelect === "function") {
    db.onSelect(nextId || "all");
  }
}

// 顶栏分段控制器数据
const segmentedControlData = computed(() => {
  const sc = props.descriptor.props?.segmentedControl;
  if (!sc) return null;
  return sc.props || sc;
});

function handleSegmentedChange(value) {
  segmentedControlData.value?.onChange?.(value);
}

// 二级筛选与向导工具栏数据
const filterBarData = computed(() => {
  const fb = props.descriptor.props?.filterBar;
  if (!fb) return null;
  return fb.props || fb;
});

function getTagStyle(tag) {
  const color = typeof tag === "object" ? tag.color : null;
  if (!color) {
    return {
      backgroundColor: "rgba(255, 255, 255, 0.05)",
      borderColor: "rgba(255, 255, 255, 0.1)",
      color: "#cbd5e1"
    };
  }
  return {
    backgroundColor: `${color}18`,
    borderColor: `${color}40`,
    color: color
  };
}

function handleSearchInput(e) {
  const val = e.target.value;
  localSearchText.value = val;
  if (props.descriptor.props?.onSearchTextChange) {
    props.descriptor.props.onSearchTextChange(val);
  }
}

function currentSearchValue() {
  return String(props.descriptor.props?.searchText ?? localSearchText.value ?? "");
}

function hasSearchText() {
  return currentSearchValue().trim().length > 0;
}

function clearSearch() {
  localSearchText.value = "";
  if (props.descriptor.props?.onSearchTextChange) {
    props.descriptor.props.onSearchTextChange("");
  }
  searchInputRef.value?.focus();
}

function getViewStateSnapshot() {
  const sel = selectedItem.value;
  const selectedId = sel?.id || sel?.props?.id || sel?.props?.title || "";
  return {
    searchText: currentSearchValue(),
    segmentedValue: String(segmentedControlData.value?.value ?? ""),
    dropdownValue: String(
      searchBarAccessory.value?.props?.value ??
      searchBarAccessory.value?.props?.defaultValue ??
      ""
    ),
    selectedId: String(selectedId)
  };
}

function tryRestoreInitialSnapshot() {
  const snap = props.initialSnapshot;
  if (!snap || typeof snap !== "object") return;

  if (!filtersRestored) {
    filtersRestored = true;
    if (snap.searchText) {
      localSearchText.value = String(snap.searchText);
      props.descriptor.props?.onSearchTextChange?.(String(snap.searchText));
    }
    if (snap.segmentedValue && segmentedControlData.value?.onChange) {
      segmentedControlData.value.onChange(String(snap.segmentedValue));
    }
    if (snap.dropdownValue && searchBarAccessory.value?.props?.onChange) {
      searchBarAccessory.value.props.onChange(String(snap.dropdownValue));
    }
  }
}

function selectItem(item) {
  selectedItem.value = item;
  emit("select", item);
  emit("action-panel-change", item.props?.actions || props.descriptor.props?.actions);
}

function handleContextMenu(item) {
  selectItem(item);
  emit("open-action-panel", item);
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

watch(
  () => props.initialSnapshot,
  () => {
    filtersRestored = false;
    selectionRestored = false;
    tryRestoreInitialSnapshot();
  },
  { immediate: true }
);

watch(flatItems, (items) => {
  if (items.length === 0) return;

  const snap = props.initialSnapshot;
  if (!selectionRestored && snap?.selectedId) {
    const matched = items.find(
      (it) =>
        String(it.id ?? "") === String(snap.selectedId) ||
        String(it.props?.id ?? "") === String(snap.selectedId) ||
        String(it.props?.title ?? "") === String(snap.selectedId)
    );
    if (matched) {
      selectionRestored = true;
      selectItem(matched);
      scrollToSelected();
      return;
    }
  }

  if (!selectedItem.value || !items.includes(selectedItem.value)) {
    selectItem(items[0]);
  }
}, { immediate: true });

onMounted(() => {
  tryRestoreInitialSnapshot();
  searchInputRef.value?.focus();
});

defineExpose({
  focusNextItem,
  focusPrevItem,
  getSelectedItem: () => selectedItem.value,
  focusSearch: () => searchInputRef.value?.focus(),
  hasSearchText,
  clearSearch,
  getViewStateSnapshot
});
</script>
