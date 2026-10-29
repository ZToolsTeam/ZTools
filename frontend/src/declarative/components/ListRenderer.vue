<template>
  <div class="flex flex-col h-full overflow-hidden select-none">
    <!-- 第一段 Row 1：置顶统一搜索栏 + 内嵌视图切换胶囊 + 作用域下拉选择器（固定 40px，有无下拉框高度一致） -->
    <div class="decl-search-bar h-10 flex-shrink-0 px-3.5 border-b border-[var(--rc-border)] flex items-center gap-2.5 bg-[var(--rc-surface-subtle)]">
      <DeclarativeIcon icon="magnifying-glass" :size="16" class="text-[var(--rc-text-muted)] flex-shrink-0" />
      <input
        ref="searchInputRef"
        :value="descriptor.props?.searchText ?? localSearchText"
        type="text"
        :placeholder="descriptor.props?.searchBarPlaceholder || '搜索...'"
        :aria-label="descriptor.props?.searchBarPlaceholder || '搜索'"
        class="flex-1 min-w-[140px] bg-transparent text-sm text-[var(--rc-text-primary)] placeholder:text-[var(--rc-text-faint)] outline-none"
        @input="handleSearchInput"
        @keydown.down="handleSearchVertical($event, 1)"
        @keydown.up="handleSearchVertical($event, -1)"
        @keydown.left="handleSearchArrow($event, 'nav')"
        @keydown.right="handleSearchArrow($event, 'sub')"
      />

      <!-- 内嵌紧凑型分段控制器 (SegmentedControl，仅在无右侧下拉框且非工作台双栏模式时展示，防顶栏重复) -->
      <div
        v-if="!searchBarAccessory && !workbenchPanelData && segmentedControlData?.options && segmentedControlData.options.length > 0"
        class="flex items-center gap-1 bg-[var(--rc-surface-hover)] p-0.5 rounded-lg border border-[var(--rc-border)] flex-shrink-0"
      >
        <button
          v-for="opt in segmentedControlData.options"
          :key="opt.value"
          type="button"
          class="px-2 py-0.5 rounded-md text-[11px] font-medium transition-all duration-150 flex items-center gap-1 flex-shrink-0"
          :class="[
            segmentedControlData.value === opt.value
              ? 'bg-[var(--rc-surface-active)] text-[var(--rc-text-primary)] border border-[var(--rc-border-highlight)] shadow-sm'
              : 'text-[var(--rc-text-muted)] hover:text-[var(--rc-text-primary)] border border-transparent'
          ]"
          :aria-pressed="segmentedControlData.value === opt.value ? 'true' : 'false'"
          @click="handleSegmentedChange(opt.value)"
        >
          <DeclarativeIcon v-if="opt.icon" :icon="opt.icon" :size="11" />
          <span>{{ cleanUiText(opt.label) }}</span>
          <span
            v-if="opt.badge !== undefined"
            class="px-1 rounded text-[10px] tabular-nums opacity-80"
          >
            {{ opt.badge }}
          </span>
        </button>
      </div>

      <!-- 搜索栏右侧下拉筛选器 (List.Dropdown) -->
      <div v-if="searchBarAccessory" class="flex-shrink-0">
        <RcSelect
          size="small"
          class="list-dropdown"
          :value="dropdownValue"
          :options="dropdownSelectOptions"
          :dropdown-match-select-width="false"
          placement="bottomRight"
          :aria-label="cleanUiText(searchBarAccessory.props?.tooltip || searchBarAccessory.props?.title || '筛选')"
          @update:value="handleDropdownChange"
        />
      </div>

      <!-- 加载微动效 -->
      <SpinnerIcon v-if="descriptor.props?.isLoading" class="w-4 h-4 text-[var(--rc-text-muted)] flex-shrink-0" aria-hidden="true" />
    </div>

    <!-- 第一段 Row 2：单行极简全局状态条 (28px，左摘要 + 右 1~2 个全局动作，遵循黄金法则 1/2/3) -->
    <div
      v-if="hasCompactSubHeader"
      class="px-3.5 py-1.5 border-b border-[var(--rc-border)] bg-[var(--rc-surface-subtle)] flex items-center justify-between gap-2 text-[11px] min-w-0 flex-shrink-0"
    >
      <div class="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
        <!-- 优先展示单行融合摘要 summaryText -->
        <span
          v-if="filterBarData?.summaryText"
          class="text-[11px] tabular-nums text-[var(--rc-text-secondary)] truncate decl-summary-text"
          :title="cleanUiText(filterBarData.summaryText)"
        >
          {{ cleanUiText(filterBarData.summaryText) }}
        </span>
        <!-- 若未传 summaryText 但传了 metricGrid，则内联为紧凑单行指标文本 -->
        <div
          v-else-if="metricGridData?.items && metricGridData.items.length > 0"
          class="flex items-center gap-2 overflow-x-auto no-scrollbar text-[11px] tabular-nums truncate decl-summary-metrics"
        >
          <span
            v-for="(m, mIdx) in metricGridData.items"
            :key="m.id || mIdx"
            class="text-[var(--rc-text-secondary)] whitespace-nowrap"
          >
            <span class="text-[var(--rc-text-muted)]">{{ cleanUiText(m.label) }}: </span>
            <strong class="text-[var(--rc-text-primary)]">{{ m.value }}</strong>
            <span v-if="mIdx < metricGridData.items.length - 1" class="mx-1.5 text-[var(--rc-text-faint)]">·</span>
          </span>
        </div>
      </div>

      <!-- 右侧全局级轻量按钮 (最多 2 个，统一中性灰阶风格，过滤与底部主动作重复的批量清理按钮) -->
      <div
        v-if="visibleGlobalActions.length > 0"
        class="flex items-center gap-1.5 flex-shrink-0 ml-auto"
      >
        <button
          v-for="act in visibleGlobalActions"
          :key="act.id || act.label || act.title"
          type="button"
          :disabled="act.disabled"
          class="px-2 py-0.5 rounded-md text-[11px] font-medium transition-all flex items-center gap-1 border bg-[var(--rc-surface-hover)] text-[var(--rc-text-secondary)] border-[var(--rc-border)] hover:text-[var(--rc-text-primary)] hover:bg-[var(--rc-surface-active)]"
          :class="{
            'opacity-40 cursor-not-allowed': act.disabled
          }"
          @click="runGlobalAction(act)"
        >
          <span>{{ cleanUiText(act.label || act.title) }}</span>
          <span v-if="act.badge !== undefined" class="tabular-nums text-[10px] px-1 rounded bg-[var(--rc-surface-subtle)]">{{ act.badge }}</span>
        </button>
      </div>
    </div>

    <!-- 列表主体容器；最近一次是键盘操作时不显示鼠标悬停高亮，避免与选中行混淆 -->
    <div
      class="flex-1 flex overflow-hidden min-h-0"
      :class="{ 'is-keyboard-nav': inputMode === 'keyboard' }"
      @mousemove="handlePointerMove"
    >
      <!-- 左侧区域：支持范式二 (32% 空间导航树)、范式三 (34% 参数与画布工作台) 或范式一 (单栏/48% 列表) -->
      <div
        ref="listScrollRef"
        class="overflow-y-auto declarative-scrollbar p-2 space-y-2.5 min-w-0"
        :class="[
          workbenchPanelData && subListData
            ? 'w-[34%] flex-shrink-0 border-r border-[var(--rc-border)] bg-[var(--rc-surface-subtle)]'
            : subListData
            ? 'w-[32%] flex-shrink-0 border-r border-[var(--rc-border)]'
            : descriptor.props?.isShowingDetail && selectedItem?.props?.detail
            ? 'w-[48%] flex-shrink-0'
            : 'flex-1'
        ]"
      >
        <!-- 范式三：左侧参数配置与画布工作台面板 (workbenchPanel) -->
        <div v-if="workbenchPanelData" class="space-y-2.5 p-1">
          <!-- 标题与副标题分行：副标题再长也不会把标题挤成省略号；插件没写标题时不显示 -->
          <div
            v-if="workbenchPanelData.title || workbenchPanelData.subtitle"
            class="px-2.5 py-1.5 rounded-lg bg-[var(--rc-surface-hover)] border border-[var(--rc-border)] flex flex-col gap-0.5 min-w-0 decl-workbench-head"
          >
            <span v-if="workbenchPanelData.title" class="text-xs font-semibold text-[var(--rc-text-primary)] break-words decl-workbench-title">
              {{ cleanUiText(workbenchPanelData.title) }}
            </span>
            <span v-if="workbenchPanelData.subtitle" class="text-[10px] tabular-nums text-[var(--rc-text-muted)] break-words decl-workbench-subtitle">
              {{ cleanUiText(workbenchPanelData.subtitle) }}
            </span>
          </div>

          <!-- 参数表单项列表 -->
          <div class="space-y-1.5 bg-[var(--rc-canvas)]/40 rounded-xl p-2.5 border border-[var(--rc-border)]">
            <div
              v-for="field in workbenchPanelData.fields || []"
              :key="field.id"
              class="flex items-start justify-between gap-2 py-1 border-b border-[var(--rc-border)]/50 last:border-b-0"
            >
              <span class="text-xs text-[var(--rc-text-secondary)] font-medium flex-shrink-0 pt-0.5">
                {{ cleanUiText(field.label) }}
              </span>

              <!-- 下拉选择型参数 -->
              <RcSelect
                v-if="field.type === 'select' && field.options"
                size="small"
                class="detail-param-select"
                :value="field.value"
                :options="field.options.map((opt) => ({ label: cleanUiText(opt.label), value: opt.value }))"
                :dropdown-match-select-width="false"
                placement="bottomRight"
                :aria-label="cleanUiText(field.label)"
                @update:value="value => field.onChange && field.onChange(value)"
              />

              <!-- 布尔开关型参数：与列表复选框同一套主题样式 -->
              <label
                v-else-if="field.type === 'toggle'"
                class="flex items-center gap-1.5 text-[11px] text-[var(--rc-text-secondary)] cursor-pointer decl-field-toggle"
              >
                <DeclCheckbox
                  :checked="Boolean(field.value)"
                  :aria-label="cleanUiText(field.label)"
                  @change="value => field.onChange && field.onChange(value)"
                />
                <span>{{ field.value ? '已开启' : '已关闭' }}</span>
              </label>

              <!-- 文本/只读展示型参数：短的代码型值（如 1920x1080、H.264）等宽单行；说明性文字用正文字体换行显示 -->
              <span
                v-else-if="isCodeLikeValue(field.value)"
                class="px-2 py-0.5 text-[11px] font-mono text-[var(--rc-text-secondary)] bg-[var(--rc-surface-hover)] border border-[var(--rc-border)] rounded-md truncate max-w-[175px] decl-field-code"
                :title="displayText(field.value)"
              >
                {{ displayText(field.value) }}
              </span>
              <span
                v-else
                class="px-2 py-0.5 text-[11px] leading-snug text-right text-[var(--rc-text-secondary)] bg-[var(--rc-surface-hover)] border border-[var(--rc-border)] rounded-md min-w-0 whitespace-normal break-words decl-field-text"
              >
                {{ displayText(field.value) }}
              </span>
            </div>
          </div>

          <!-- 底部输出预估 / 视觉预览摘要卡 (极简灰阶卡片，零彩色刺眼高亮) -->
          <div
            v-if="workbenchPanelData.previewCard"
            class="rounded-xl p-2.5 bg-[var(--rc-surface-hover)] border border-[var(--rc-border)] space-y-2"
          >
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold text-[var(--rc-text-primary)]">
                {{ cleanUiText(workbenchPanelData.previewCard.title) }}
              </span>
              <span
                v-if="workbenchPanelData.previewCard.badge"
                class="px-1.5 py-0.5 text-[10px] tabular-nums rounded bg-[var(--rc-surface-active)] text-[var(--rc-text-secondary)] border border-[var(--rc-border)]"
              >
                {{ cleanUiText(workbenchPanelData.previewCard.badge) }}
              </span>
            </div>
            <p v-if="workbenchPanelData.previewCard.subtitle" class="text-[11px] text-[var(--rc-text-muted)] leading-snug">
              {{ cleanUiText(workbenchPanelData.previewCard.subtitle) }}
            </p>
            <div
              v-if="workbenchPanelData.previewCard.metrics && workbenchPanelData.previewCard.metrics.length > 0"
              class="grid grid-cols-2 gap-1.5 pt-0.5"
            >
              <div
                v-for="(m, mIdx) in workbenchPanelData.previewCard.metrics"
                :key="mIdx"
                class="px-2 py-1.5 rounded-lg bg-[var(--rc-canvas)]/50 border border-[var(--rc-border)] flex flex-col"
              >
                <span class="text-[10px] text-[var(--rc-text-muted)]">{{ cleanUiText(m.label) }}</span>
                <span class="text-xs tabular-nums font-semibold text-[var(--rc-text-primary)]">
                  {{ m.value }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 分组遍历 (仅在未启用 workbenchPanelData 时展示左侧导航列表，避免参数面板下方重复堆砌) -->
        <div
          v-if="!workbenchPanelData"
          class="space-y-2.5"
          role="listbox"
          :aria-label="subListData ? '导航' : '结果'"
          data-decl-listbox
        >
          <div
            v-for="(sec, sIdx) in sections"
            :key="sIdx"
            class="space-y-0.5"
            :role="sec.title ? 'group' : undefined"
            :aria-label="sec.title ? cleanUiText(sec.title) : undefined"
          >
            <!-- 分组标题：11px 弱化纯文字，不加背景与边框 -->
            <div
              v-if="sec.title"
              class="decl-section-title px-2.5 pt-1 pb-0.5 text-[11px] font-medium text-[var(--rc-text-muted)] flex items-center justify-between gap-2"
            >
              <div class="flex items-center gap-2 min-w-0">
                <DeclCheckbox
                  v-if="sec.checkable"
                  :checked="sec.checked"
                  :aria-label="`全选 ${cleanUiText(sec.title)}`"
                  @change="value => sec.onCheckChange && sec.onCheckChange(value)"
                />
                <span class="truncate">{{ cleanUiText(sec.title) }}</span>
              </div>
              <span v-if="sec.subtitle" class="text-[11px] tabular-nums text-[var(--rc-text-faint)] flex-shrink-0">{{ cleanUiText(sec.subtitle) }}</span>
            </div>

            <!-- Items 遍历 -->
            <div
              v-for="(item, iIdx) in sec.items"
              :key="item.id || `${sIdx}-${iIdx}`"
              :ref="el => registerItemEl(item, el)"
              role="option"
              :aria-selected="selectedItem === item ? 'true' : 'false'"
              class="decl-row flex items-center justify-between pl-2 pr-2.5 py-2 rounded-[10px] text-sm cursor-pointer transition-colors duration-100"
              :class="{
                'is-selected': selectedItem === item,
                'is-dim': selectedItem === item && hasNavPane && !isNavPaneActive
              }"
              @mousedown="keepSearchFocus"
              @click="selectItem(item, true)"
              @dblclick="emit('trigger-primary', item)"
              @contextmenu.prevent="handleContextMenu(item)"
            >
              <!-- 左侧选中标记（与悬浮条一致的小方块）、复选框、图标与文本 -->
              <div class="flex items-center gap-2 min-w-0 flex-1 overflow-hidden pr-2">
                <span class="decl-row-marker mr-1" aria-hidden="true"></span>
                <DeclCheckbox
                  v-if="item.props?.checkable"
                  :checked="item.props?.checked ?? false"
                  :aria-label="`勾选 ${displayText(item.props?.title)}`"
                  @change="toggleItemCheck(item)"
                />
                <DeclarativeIcon
                  v-if="item.props?.icon"
                  :icon="item.props.icon"
                  :size="15"
                  :class="selectedItem === item ? 'text-[var(--rc-text-primary)]' : 'text-[var(--rc-text-muted)]'"
                />
                <div class="flex flex-col justify-center min-w-0 flex-1 overflow-hidden">
                  <span class="truncate font-medium text-[var(--rc-text-primary)] leading-snug text-[13px]">{{ displayText(item.props?.title) }}</span>
                  <span
                    v-if="item.props?.subtitle"
                    class="text-[11px] text-[var(--rc-text-muted)] truncate leading-tight"
                  >
                    {{ displayText(item.props.subtitle) }}
                  </span>
                </div>
              </div>

              <!-- 右侧 Accessories：与右栏明细共用同一组件 -->
              <div v-if="item.props?.accessories?.length" class="flex items-center gap-1.5 flex-shrink-0">
                <ListAccessory v-for="(acc, aIdx) in item.props.accessories" :key="aIdx" :accessory="acc" />
              </div>
            </div>
          </div>

          <DeclEmptyState
            v-if="flatItems.length === 0"
            class="decl-list-empty"
            compact
            :loading="Boolean(descriptor.props?.isLoading)"
            :icon="hasSearchText() ? 'magnifying-glass' : ''"
            :title="listEmptyText"
          />
        </div>
      </div>

      <!-- 方案二/三：右侧联动可操作文件/任务列表 (占 66%~68% 宽) -->
      <div
        v-if="subListData"
        :class="workbenchPanelData ? 'w-[66%]' : 'w-[68%]'"
        class="flex-1 flex flex-col overflow-hidden bg-[var(--rc-surface-subtle)]"
      >
        <!-- 右栏顶部状态与全选控制栏：插件没写标题、也不可全选时不显示 -->
        <div
          v-if="subListData.title || subListData.subtitle || subListData.checkable"
          class="px-3.5 py-1.5 border-b border-[var(--rc-border)] flex items-center justify-between gap-2 bg-[var(--rc-surface-subtle)] decl-sublist-head"
        >
          <div class="flex items-center gap-2 min-w-0">
            <DeclCheckbox
              v-if="subListData.checkable"
              :checked="subListData.checked ?? false"
              aria-label="全选"
              @change="value => subListData.onCheckChange && subListData.onCheckChange(value)"
            />
            <span v-if="subListData.title" class="text-xs font-semibold text-[var(--rc-text-primary)] truncate">{{ cleanUiText(subListData.title) }}</span>
          </div>
          <span v-if="subListData.subtitle" class="text-[11px] tabular-nums text-[var(--rc-text-muted)] flex-shrink-0">
            {{ cleanUiText(subListData.subtitle) }}
          </span>
        </div>

        <!-- 右栏可勾选、带单色体积进度条的明细列表 -->
        <div
          class="flex-1 overflow-y-auto declarative-scrollbar p-2 space-y-0.5"
          role="listbox"
          :aria-label="cleanUiText(subListData.title) || '明细'"
          aria-multiselectable="true"
          data-decl-sublistbox
        >
          <div
            v-for="(fItem, fIdx) in subListItems"
            :key="fItem.id || `sub-${fIdx}`"
            :ref="el => registerSubItemEl(fItem, el)"
            role="option"
            :aria-selected="selectedSubItem === fItem ? 'true' : 'false'"
            class="decl-row flex items-center justify-between pl-2 pr-3 py-2 rounded-[10px] text-sm cursor-pointer transition-colors duration-100"
            :class="{
              'is-selected': selectedSubItem === fItem,
              'is-dim': selectedSubItem === fItem && isNavPaneActive
            }"
            @mousedown="keepSearchFocus"
            @click="selectSubItem(fItem, true)"
            @dblclick="emit('trigger-primary', fItem)"
            @contextmenu.prevent="handleSubContextMenu(fItem)"
          >
            <!-- 左侧选中标记 + 复选框/线性锁图标 + 标题与副标题 -->
            <div class="flex items-center gap-2.5 min-w-0 flex-1 overflow-hidden pr-3">
              <span class="decl-row-marker mr-0.5" aria-hidden="true"></span>
              <DeclCheckbox
                v-if="fItem.props?.checkable"
                :checked="fItem.props?.checked ?? false"
                :aria-label="`勾选 ${displayText(fItem.props?.title)}`"
                @change="toggleItemCheck(fItem)"
              />
              <!-- 只有插件明确声明不可勾选（checkable: false）或给出锁定原因时才显示锁；未设置 checkable 的普通行不显示 -->
              <span
                v-else-if="isSubItemLocked(fItem)"
                class="w-3.5 h-3.5 flex items-center justify-center text-[var(--rc-text-muted)] flex-shrink-0 decl-sub-lock"
                :title="subItemLockedReason(fItem)"
              >
                <DeclarativeIcon icon="lock" :size="13" />
              </span>
              <DeclarativeIcon
                v-if="fItem.props?.icon"
                :icon="fItem.props.icon"
                :size="16"
                :class="selectedSubItem === fItem ? 'text-[var(--rc-text-primary)]' : 'text-[var(--rc-text-muted)]'"
              />
              <div class="flex flex-col justify-center min-w-0 flex-1 overflow-hidden">
                <span class="truncate font-medium text-[var(--rc-text-primary)] leading-snug text-[13px]">{{ displayText(fItem.props?.title) }}</span>
                <span
                  v-if="fItem.props?.subtitle"
                  class="text-[11px] text-[var(--rc-text-muted)] truncate leading-tight"
                >
                  {{ displayText(fItem.props.subtitle) }}
                </span>
              </div>
            </div>

            <!-- 右侧 Accessories：与左栏共用同一组件 -->
            <div v-if="fItem.props?.accessories?.length" class="flex items-center gap-2 flex-shrink-0">
              <ListAccessory v-for="(acc, aIdx) in fItem.props.accessories" :key="aIdx" :accessory="acc" />
            </div>
          </div>

          <DeclEmptyState
            v-if="subListItems.length === 0"
            class="decl-sublist-empty"
            compact
            :loading="Boolean(descriptor.props?.isLoading)"
            :title="subListData.emptyText ? cleanUiText(subListData.emptyText) : listEmptyText"
          />
        </div>
      </div>

      <!-- 右侧 Detail 分栏 (仅在无 subListData 且启用了 isShowingDetail 时展示) -->
      <div
        v-else-if="descriptor.props?.isShowingDetail && selectedItem?.props?.detail"
        class="w-[52%] min-h-0 border-l border-[var(--rc-border)] overflow-hidden flex flex-col bg-[var(--rc-surface-subtle)]"
      >
        <DetailRenderer
          :descriptor="selectedItem.props.detail"
          :is-list-detail="true"
          :actions="activeActions"
          @trigger-action="act => emit('trigger-action', act)"
          @open-action-panel="emit('open-action-panel')"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { SpinnerIcon } from '@/utils/appIcons'
import { RcSelect } from '@/components/base'
import { ref, computed, watch, onMounted, nextTick } from "vue";
import DeclarativeIcon from "./DeclarativeIcon.vue";
import DetailRenderer from "./DetailRenderer.vue";
import DeclCheckbox from "./DeclCheckbox.vue";
import DeclEmptyState from "./DeclEmptyState.vue";
import ListAccessory from "./ListAccessory.vue";
import { cleanUiText, displayText } from "../uiText.js";

const props = defineProps({
  descriptor: {
    type: Object,
    required: true
  },
  initialSnapshot: {
    type: Object,
    default: null
  },
  activeActions: {
    type: Array,
    default: () => []
  }
});

const emit = defineEmits(["select", "trigger-primary", "trigger-action", "action-panel-change", "open-action-panel", "action-error"]);

/** 状态栏按钮与动作面板一致：等待插件回调，失败交给视图如实提示，不能静默 */
async function runGlobalAction(act) {
  if (!act || act.disabled || typeof act.onAction !== "function") return;
  try {
    await act.onAction();
  } catch (err) {
    console.error("[ListRenderer] 状态栏动作执行失败:", err);
    emit("action-error", err);
  }
}

const searchInputRef = ref(null);
const listScrollRef = ref(null);
const localSearchText = ref("");
const selectedItem = ref(null);
const selectedSubItem = ref(null);
// 布局二（左导航 + 右可勾选明细）键盘焦点所在栏：'sub' 右栏明细（默认）/ 'nav' 左栏导航
const activePane = ref("sub");
const itemElements = new Map();
// 最近一次的操作方式：'keyboard' 时不显示鼠标悬停高亮，避免悬停行和选中行同时高亮分不清
const inputMode = ref("pointer");
let lastPointer = null;
let filtersRestored = false;
let selectionRestored = false;
let subSelectionRestored = false;

/** 鼠标真的移动了才切回鼠标模式（列表滚动时浏览器补发的同位置事件不算） */
function handlePointerMove(e) {
  const pos = `${e?.screenX ?? ""},${e?.screenY ?? ""}`;
  if (lastPointer === pos) return;
  lastPointer = pos;
  inputMode.value = "pointer";
}

function markKeyboardNav() {
  inputMode.value = "keyboard";
}

function registerItemEl(item, el) {
  if (el) {
    itemElements.set(item, el);
  }
}

// 右栏子列表行的 DOM，用于键盘选择后滚动到可视区（行卸载时删除，避免旧条目堆积）
const subItemElements = new Map();
function registerSubItemEl(item, el) {
  if (el) subItemElements.set(item, el);
  else subItemElements.delete(item);
}

// 搜索词变化后，下一批结果到来时把选中项重置到第一项（对齐 Raycast）；用户手动 ↑↓ / 点击后取消
let pendingResetToFirst = false;
// 最近一次已应用的受控 selectedItemId（只在插件改变它时生效，不和用户的方向键选择抢）
let lastAppliedSelectedItemId = null;

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
  } else if (typeof item?.props?.onToggleCheck === "function") {
    item.props.onToggleCheck(!curr);
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

// 范式三：左侧加工参数与画布工作台面板数据 (workbenchPanel)
const workbenchPanelData = computed(() => {
  const wp = props.descriptor.props?.workbenchPanel;
  return wp ? (wp.props || wp) : null;
});

// 范式二/三：右侧联动可操作文件/任务列表数据 (subList)
const subListData = computed(() => {
  const sl = props.descriptor.props?.subList;
  return sl ? (sl.props || sl) : null;
});

const subListItems = computed(() => {
  const sl = subListData.value;
  if (!sl) return [];
  if (Array.isArray(sl.items)) return sl.items;
  return [];
});

// 布局二才有可键盘切换的左栏导航；布局三左栏是参数面板（不渲染导航条目）
const hasNavPane = computed(() => Boolean(subListData.value) && !workbenchPanelData.value);
const isNavPaneActive = computed(() => hasNavPane.value && activePane.value === "nav");

/** 把当前栏的选中项告诉宿主，底栏黄金三键与 ⌘K 面板跟着它走 */
function emitActiveSelection() {
  const item = subListData.value && !isNavPaneActive.value ? selectedSubItem.value : selectedItem.value;
  emit("select", item || null);
  emit("action-panel-change", item?.props?.actions || props.descriptor.props?.actions);
}

/** 切换布局二的键盘焦点栏，返回是否真的切换了 */
function setActivePane(pane) {
  if (!hasNavPane.value) return false;
  const next = pane === "nav" ? "nav" : "sub";
  if (next === "nav" && flatItems.value.length === 0) return false;
  if (next === "sub" && subListItems.value.length === 0) return false;
  if (activePane.value === next) return false;
  activePane.value = next;
  if (next === "nav" && !selectedItem.value && flatItems.value.length > 0) {
    selectedItem.value = flatItems.value[0];
  }
  emitActiveSelection();
  if (next === "nav") scrollToSelected();
  return true;
}

/** 搜索框里按 ↑ / ↓ 移动选中项；输入法组字时方向键是给候选框用的，不处理 */
function handleSearchVertical(e, step) {
  if (e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  if (step > 0) focusNextItem();
  else focusPrevItem();
}

/** 搜索框里按 ← / →：光标已在最左（或最右）时切换左右栏，否则照常移动光标 */
function handleSearchArrow(e, pane) {
  if (!hasNavPane.value || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || e.isComposing || e.keyCode === 229) return;
  const el = e.target;
  const len = typeof el?.value === "string" ? el.value.length : 0;
  const start = el?.selectionStart ?? 0;
  const end = el?.selectionEnd ?? 0;
  const atEdge = pane === "nav" ? start === 0 && end === 0 : start === len && end === len;
  if (!atEdge) return;
  if (setActivePane(pane)) e.preventDefault();
}

/** 点列表行不夺走搜索框焦点，否则之后的打字与快捷键都落空 */
function keepSearchFocus(e) {
  const tag = e?.target?.tagName ? String(e.target.tagName).toUpperCase() : "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (typeof document !== "undefined" && document.activeElement === searchInputRef.value) {
    e.preventDefault();
  }
}

// 筛选 Accessory
const searchBarAccessory = computed(() => {
  return props.descriptor.props?.searchBarAccessory || null;
});

/**
 * 下拉选项按分组展开：直接子项归入无标题分组，List.Dropdown.Section 内的选项归入该分组。
 * 相邻的无标题选项合并为一组，保持插件声明的顺序。
 */
const dropdownGroups = computed(() => {
  if (!searchBarAccessory.value) return [];
  const groups = [];
  for (const child of searchBarAccessory.value.children || []) {
    if (child?.type === "List.Dropdown.Item") {
      const last = groups[groups.length - 1];
      if (last && !last.title) last.items.push(child);
      else groups.push({ title: "", items: [child] });
    } else if (child?.type === "List.Dropdown.Section") {
      const items = (child.children || []).filter((c) => c?.type === "List.Dropdown.Item");
      if (items.length > 0) groups.push({ title: String(child.props?.title || ""), items });
    }
  }
  return groups;
});

const dropdownOptions = computed(() => dropdownGroups.value.flatMap((g) => g.items));

// 非受控下拉框（插件只给 onChange）记住用户选的值，重渲染或从下一层页面返回时仍显示它
const localDropdownValue = ref(null);

/** 下拉框当前显示的值：受控 value → 用户刚选的值 → defaultValue → 第一个选项（不留空白） */
const dropdownValue = computed(() => {
  const p = searchBarAccessory.value?.props;
  if (p?.value !== undefined && p?.value !== null && p?.value !== "") return String(p.value);
  if (localDropdownValue.value !== null) return localDropdownValue.value;
  if (p?.defaultValue !== undefined && p?.defaultValue !== null && p?.defaultValue !== "") return String(p.defaultValue);
  const first = dropdownOptions.value[0]?.props?.value;
  return first === undefined || first === null ? "" : String(first);
});

/** 转成 RcSelect 选项：无标题分组的选项平铺，有标题的分组用 { label, options } */
const dropdownSelectOptions = computed(() =>
  dropdownGroups.value.flatMap((group) => {
    const options = group.items.map((opt) => ({ label: cleanUiText(opt.props?.title), value: String(opt.props?.value ?? "") }));
    return group.title ? [{ label: cleanUiText(group.title), options }] : options;
  })
);

function handleDropdownChange(val) {
  localDropdownValue.value = val;
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
  if (id === "ALL" || id === "all") {
    if (typeof db.onSelectSegment === "function") {
      db.onSelectSegment(undefined);
    } else if (typeof db.onSelect === "function") {
      db.onSelect("all");
    }
    return;
  }
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

// 二级筛选与向导工具栏数据（严格按插件显式声明的全局状态摘要与全局动作渲染，不自动克隆单条动作）
const filterBarData = computed(() => {
  const fb = props.descriptor.props?.filterBar;
  return fb ? (fb.props || fb) : null;
});

const visibleGlobalActions = computed(() => {
  const actions = filterBarData.value?.actions || [];
  if (!Array.isArray(actions) || actions.length === 0) return [];
  // 当存在右侧勾选列表 (subListData) 时，底部黄金三键已承担“批量清理/执行已选 (↵)”主动作，顶栏不再重复放置该按钮
  const filtered = (subListData.value || workbenchPanelData.value)
    ? actions.filter((a) => {
        const text = cleanUiText(a?.label || a?.title || "");
        return !/^(批量清理|立即清理|一键清理|批量执行|开始批量|清理已选)/.test(text);
      })
    : actions;
  return (filtered.length > 0 ? filtered : actions.slice(-1)).slice(0, 2);
});

const hasCompactSubHeader = computed(() => {
  const fb = filterBarData.value;
  const mg = metricGridData.value;
  return Boolean(
    fb?.summaryText ||
    (mg?.items && mg.items.length > 0) ||
    visibleGlobalActions.value.length > 0
  );
});

/** 代码型短值上限：超过这个长度的值按说明文字换行显示 */
const CODE_VALUE_MAX_LENGTH = 24;

/**
 * 字段值是否按“代码型短值”显示（等宽、单行）：不含中日韩文字、不含换行、长度不超过上限。
 * 其余（说明性文字）用正文字体并允许换行，避免被截成“JPEG / PNG / HEIC 可清…”。
 */
function isCodeLikeValue(value) {
  if (value === undefined || value === null) return true;
  const text = String(value);
  if (text.length > CODE_VALUE_MAX_LENGTH) return false;
  if (/[\r\n]/.test(text)) return false;
  return !/[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/.test(text);
}

function handleSearchInput(e) {
  const val = e.target.value;
  localSearchText.value = val;
  if (props.descriptor.props?.onSearchTextChange) {
    // 插件按搜索词重新生成结果：结果到来时选中第一项，而不是停在旧的示例 / 规则行上
    pendingResetToFirst = true;
    props.descriptor.props.onSearchTextChange(val);
  }
}

function currentSearchValue() {
  return String(props.descriptor.props?.searchText ?? localSearchText.value ?? "");
}

function hasSearchText() {
  return currentSearchValue().trim().length > 0;
}

// subList 行是否受保护：插件显式写 checkable: false，或给出 lockedReason
function isSubItemLocked(item) {
  const p = item?.props;
  if (!p || p.checkable) return false;
  return p.checkable === false || (typeof p.lockedReason === "string" && p.lockedReason.trim().length > 0);
}

function subItemLockedReason(item) {
  const reason = item?.props?.lockedReason;
  return typeof reason === "string" && reason.trim() ? cleanUiText(reason.trim()) : "受保护，不可选择";
}

// 列表为空时的提示：加载中不下结论；有搜索词才说"未找到匹配"；否则是中性的"暂无内容"
const listEmptyText = computed(() => {
  if (props.descriptor.props?.isLoading) return "正在加载…";
  if (hasSearchText()) return "未找到匹配条目";
  return "暂无内容";
});

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
    dropdownValue: searchBarAccessory.value ? dropdownValue.value : "",
    selectedId: String(selectedId),
    selectedSubId: getItemKey(selectedSubItem.value)
  };
}

function tryRestoreInitialSnapshot() {
  const snap = props.initialSnapshot;
  if (!snap || typeof snap !== "object") return;

  if (!filtersRestored) {
    filtersRestored = true;
    // 从推入的页面返回：插件状态没变，只恢复输入框文字，不回调插件（否则会重复请求或重置插件状态）
    if (snap.fromStack) {
      if (snap.searchText) localSearchText.value = String(snap.searchText);
      if (snap.dropdownValue) localDropdownValue.value = String(snap.dropdownValue);
      return;
    }
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

function getItemKey(it) {
  if (!it) return "";
  return String(it.id ?? it.props?.id ?? it.key ?? it.props?.title ?? "");
}

function selectItem(item, invokeOnSelect = false, { silent = false } = {}) {
  const prevKey = getItemKey(selectedItem.value);
  const nextKey = getItemKey(item);
  selectedItem.value = item;
  // 用户点击 / 左栏导航：进入手动选择状态，不再被搜索后的重置覆盖
  if (invokeOnSelect) pendingResetToFirst = false;
  if (invokeOnSelect && typeof item?.props?.onSelect === "function") {
    try {
      item.props.onSelect();
    } catch (err) {
      console.warn("[ListRenderer] item.onSelect error:", err);
    }
  }
  if (!subListData.value || isNavPaneActive.value) {
    emit("select", item);
    emit("action-panel-change", item?.props?.actions || props.descriptor.props?.actions);
  }
  if (!silent && nextKey && nextKey !== prevKey && typeof props.descriptor.props?.onSelectionChange === "function") {
    try {
      props.descriptor.props.onSelectionChange(item?.id ?? item?.props?.id ?? nextKey);
    } catch (err) {
      console.warn("[ListRenderer] onSelectionChange error:", err);
    }
  }
}

function selectSubItem(fItem, activate = false) {
  selectedSubItem.value = fItem;
  if (activate) pendingResetToFirst = false;
  // 鼠标点右栏条目时键盘焦点回到右栏；左栏有键盘焦点时，右栏随左栏刷新不改变底栏动作
  if (activate && hasNavPane.value) activePane.value = "sub";
  if (isNavPaneActive.value) return;
  emit("select", fItem);
  emit("action-panel-change", fItem?.props?.actions || props.descriptor.props?.actions);
}

function handleSubContextMenu(fItem) {
  selectSubItem(fItem, true);
  emit("open-action-panel", fItem);
}

function handleContextMenu(item) {
  selectItem(item, true);
  emit("open-action-panel", item);
}

function focusNextItem() {
  markKeyboardNav();
  if (isNavPaneActive.value) {
    moveNavSelection(1);
    return;
  }
  pendingResetToFirst = false;
  if (subListData.value && subListItems.value.length > 0) {
    const items = subListItems.value;
    const currIdx = items.indexOf(selectedSubItem.value);
    const nextIdx = (currIdx + 1) % items.length;
    selectSubItem(items[nextIdx]);
    scrollToSelectedSub();
    return;
  }
  const items = flatItems.value;
  if (items.length === 0) return;
  const currIdx = items.indexOf(selectedItem.value);
  const nextIdx = (currIdx + 1) % items.length;
  selectItem(items[nextIdx]);
  scrollToSelected();
}

function focusPrevItem() {
  markKeyboardNav();
  if (isNavPaneActive.value) {
    moveNavSelection(-1);
    return;
  }
  pendingResetToFirst = false;
  if (subListData.value && subListItems.value.length > 0) {
    const items = subListItems.value;
    const currIdx = items.indexOf(selectedSubItem.value);
    const prevIdx = (currIdx - 1 + items.length) % items.length;
    selectSubItem(items[prevIdx]);
    scrollToSelectedSub();
    return;
  }
  const items = flatItems.value;
  if (items.length === 0) return;
  const currIdx = items.indexOf(selectedItem.value);
  const prevIdx = (currIdx - 1 + items.length) % items.length;
  selectItem(items[prevIdx]);
  scrollToSelected();
}

/** 左栏导航键盘移动：与鼠标点击一致，调用条目的 onSelect 让右栏跟着切换 */
function moveNavSelection(step) {
  const items = flatItems.value;
  if (items.length === 0) return;
  const currIdx = items.indexOf(selectedItem.value);
  const nextIdx = currIdx === -1 ? 0 : (currIdx + step + items.length) % items.length;
  selectItem(items[nextIdx], true);
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

/** 右栏子列表选中行滚动到可视区（连续按键时不用平滑滚动，避免落后于选中项） */
function scrollToSelectedSub() {
  nextTick(() => {
    if (!selectedSubItem.value) return;
    const el = subItemElements.get(selectedSubItem.value);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  });
}

watch(
  () => props.initialSnapshot,
  () => {
    filtersRestored = false;
    selectionRestored = false;
    subSelectionRestored = false;
    tryRestoreInitialSnapshot();
  },
  { immediate: true }
);

/** 搜索后的重置在结果加载完成（isLoading 为 false）的那一帧之后结束，加载中的中间帧也选第一项 */
function settleResetToFirst() {
  if (!props.descriptor.props?.isLoading) pendingResetToFirst = false;
}

/**
 * 受控 selectedItemId：插件给出（或改变）它时选中对应条目；命中返回 true。
 * 只在值变化时应用一次，之后用户的方向键选择不会被拉回去。
 */
function applyControlledSelection(items, isSub) {
  const raw = props.descriptor.props?.selectedItemId;
  if (raw === undefined || raw === null || raw === "") {
    lastAppliedSelectedItemId = null;
    return false;
  }
  const wanted = String(raw);
  if (wanted === lastAppliedSelectedItemId) return false;
  const matched = items.find((it) => getItemKey(it) === wanted || String(it?.props?.id ?? "") === wanted);
  if (!matched) return false;
  lastAppliedSelectedItemId = wanted;
  pendingResetToFirst = false;
  if (isSub) {
    selectSubItem(matched);
    scrollToSelectedSub();
  } else {
    // 选中的就是插件指定的条目，不再回调 onSelectionChange，避免受控回环
    selectItem(matched, false, { silent: true });
    scrollToSelected();
  }
  return true;
}

watch(flatItems, (items) => {
  if (items.length === 0) {
    selectedItem.value = null;
    // 列表已空：通知宿主清掉旧选中项，底栏与快捷键不能再作用于看不见的旧条目（旧闭包）
    if (!subListData.value) {
      if (!props.descriptor.props?.isLoading) pendingResetToFirst = false;
      emit("select", null);
      emit("action-panel-change", props.descriptor.props?.actions || null);
    } else if (isNavPaneActive.value) {
      activePane.value = "sub";
      emitActiveSelection();
    }
    return;
  }

  if (!subListData.value && applyControlledSelection(items, false)) return;

  // 搜索词刚变化（布局一）：结果到来时选中第一项，忽略按 key 保留
  if (pendingResetToFirst && !subListData.value) {
    settleResetToFirst();
    selectItem(items[0]);
    scrollToSelected();
    return;
  }

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

  if (selectedItem.value) {
    if (items.includes(selectedItem.value)) {
      return;
    }
    const currentKey = getItemKey(selectedItem.value);
    if (currentKey) {
      const matchedByKey = items.find((it) => getItemKey(it) === currentKey);
      if (matchedByKey) {
        selectedItem.value = matchedByKey;
        if (!subListData.value || isNavPaneActive.value) {
          emit("select", matchedByKey);
          emit("action-panel-change", matchedByKey?.props?.actions || props.descriptor.props?.actions);
        }
        scrollToSelected();
        return;
      }
    }
  }

  selectItem(items[0]);
}, { immediate: true });

watch(hasNavPane, (has) => {
  if (!has) activePane.value = "sub";
});

watch(subListItems, (items) => {
  if (!subListData.value) return;
  if (items.length === 0) {
    selectedSubItem.value = null;
    if (!props.descriptor.props?.isLoading) pendingResetToFirst = false;
    // 右栏已空：通知宿主，底栏回落到 List 级动作，不能对看不见的旧文件执行动作
    if (!isNavPaneActive.value) {
      emit("select", null);
      emit("action-panel-change", props.descriptor.props?.actions || null);
    }
    return;
  }
  if (applyControlledSelection(items, true)) return;
  const snap = props.initialSnapshot;
  if (!subSelectionRestored && snap?.selectedSubId) {
    const restored = items.find((it) => getItemKey(it) === String(snap.selectedSubId));
    if (restored) {
      subSelectionRestored = true;
      selectSubItem(restored);
      scrollToSelectedSub();
      return;
    }
  }
  // 搜索词刚变化（布局二 / 三过滤右栏）：选中右栏第一项
  if (pendingResetToFirst) {
    settleResetToFirst();
    selectSubItem(items[0]);
    scrollToSelectedSub();
    return;
  }
  if (selectedSubItem.value) {
    const currKey = getItemKey(selectedSubItem.value);
    const matched = items.find((it) => getItemKey(it) === currKey);
    if (matched) {
      selectSubItem(matched);
      scrollToSelectedSub();
      return;
    }
  }
  selectSubItem(items[0]);
  scrollToSelectedSub();
}, { immediate: true });

onMounted(() => {
  tryRestoreInitialSnapshot();
  searchInputRef.value?.focus();
});

defineExpose({
  focusNextItem,
  focusPrevItem,
  getSelectedItem: () => (subListData.value && !isNavPaneActive.value ? selectedSubItem.value || selectedItem.value : selectedItem.value),
  getActivePane: () => (isNavPaneActive.value ? "nav" : "sub"),
  setActivePane,
  toggleItemCheck,
  focusSearch: () => searchInputRef.value?.focus(),
  hasSearchText,
  clearSearch,
  getViewStateSnapshot
});
</script>

<style scoped>
/* 搜索栏右侧筛选下拉与详情参数下拉：宽度随内容，设上下限 */
.list-dropdown {
  min-width: 112px;
  max-width: 220px;
}

.detail-param-select {
  min-width: 96px;
  max-width: 175px;
}

/*
 * 列表行：与悬浮条一致，选中行用 surface-active 底色 + 左侧 6px 余烬橙小方块，悬停只用更浅的底色；
 * 暗色主题下 surface-hover 叠加后比 surface-active 还亮，所以悬停底色减半，选中靠底色与小方块区分。
 * 键盘导航时（.is-keyboard-nav）不显示悬停高亮。
 */
.decl-row {
  color: var(--rc-text-secondary);
  box-shadow: inset 0 0 0 0 transparent;
}

.decl-row:not(.is-selected):hover {
  background: color-mix(in srgb, var(--rc-surface-hover) 60%, transparent);
}

.is-keyboard-nav .decl-row:not(.is-selected):hover {
  background: transparent;
}

.decl-row.is-selected {
  background: var(--rc-surface-active);
  color: var(--rc-text-primary);
  font-weight: 500;
}

/* 选中项所在栏没有键盘焦点（布局二另一栏）：保留位置但弱化，不和当前栏的选中项抢 */
.decl-row.is-selected.is-dim {
  background: var(--rc-surface-hover);
}

/* 选中标记：与悬浮条 .launcher-marker 相同的小方块与间距（距行左边 8px、到右侧内容 12px），未选中时透明占位 */
.decl-row-marker {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 1.7px;
  background: transparent;
}

.decl-row.is-selected .decl-row-marker {
  background: var(--rc-accent);
  box-shadow: var(--rc-marker-glow);
}

/* 另一栏有焦点时，本栏的选中标记转灰，不和当前栏抢 */
.decl-row.is-selected.is-dim .decl-row-marker {
  background: var(--rc-border-highlight);
  box-shadow: none;
}

.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}
</style>
