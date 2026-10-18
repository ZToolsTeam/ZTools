<template>
  <div class="flex flex-col h-full overflow-hidden select-none">
    <!-- 第一段 Row 1：置顶统一搜索栏 + 内嵌视图切换胶囊 + 作用域下拉选择器 (~40px) -->
    <div class="px-3.5 py-2 border-b border-[var(--rc-border)] flex items-center gap-2.5 bg-[var(--rc-surface-subtle)]">
      <DeclarativeIcon icon="magnifying-glass" :size="16" class="text-[var(--rc-text-muted)] flex-shrink-0" />
      <input
        ref="searchInputRef"
        :value="descriptor.props?.searchText ?? localSearchText"
        type="text"
        :placeholder="descriptor.props?.searchBarPlaceholder || '搜索...'"
        class="flex-1 min-w-[140px] bg-transparent text-sm text-[var(--rc-text-primary)] placeholder:text-[var(--rc-text-faint)] outline-none"
        @input="handleSearchInput"
        @keydown.down.prevent="focusNextItem"
        @keydown.up.prevent="focusPrevItem"
      />

      <!-- 内嵌紧凑型分段控制器 (SegmentedControl，仅在无右侧下拉框且非工作台双栏模式时展示，防顶栏重复) -->
      <div
        v-if="!searchBarAccessory && !workbenchPanelData && segmentedControlData?.options && segmentedControlData.options.length > 0"
        class="flex items-center gap-1 bg-[var(--rc-surface-hover)] p-0.5 rounded-lg border border-[var(--rc-border)] flex-shrink-0"
      >
        <button
          v-for="opt in segmentedControlData.options"
          :key="opt.value"
          class="px-2 py-0.5 rounded-md text-[11px] font-medium transition-all duration-150 flex items-center gap-1 flex-shrink-0"
          :class="[
            segmentedControlData.value === opt.value
              ? 'bg-[var(--rc-surface-active)] text-[var(--rc-text-primary)] border border-[var(--rc-border-highlight)] shadow-sm'
              : 'text-[var(--rc-text-muted)] hover:text-[var(--rc-text-primary)] border border-transparent'
          ]"
          @click="handleSegmentedChange(opt.value)"
        >
          <DeclarativeIcon v-if="opt.icon" :icon="opt.icon" :size="11" />
          <span>{{ cleanUiText(opt.label) }}</span>
          <span
            v-if="opt.badge !== undefined"
            class="px-1 rounded text-[10px] font-mono opacity-80"
          >
            {{ opt.badge }}
          </span>
        </button>
      </div>

      <!-- 搜索栏右侧下拉筛选器 (List.Dropdown) -->
      <div v-if="searchBarAccessory" class="flex-shrink-0">
        <select
          :value="searchBarAccessory.props?.value || searchBarAccessory.props?.defaultValue"
          class="bg-[var(--rc-surface-active)] text-xs text-[var(--rc-text-primary)] border border-[var(--rc-border)] rounded-md px-2 py-1 outline-none cursor-pointer hover:bg-[var(--rc-surface-hover)]"
          @change="handleDropdownChange"
        >
          <option
            v-for="(opt, oIdx) in dropdownOptions"
            :key="oIdx"
            :value="opt.props?.value"
            class="bg-[var(--rc-surface)] text-[var(--rc-text-primary)]"
          >
            {{ cleanUiText(opt.props?.title) }}
          </option>
        </select>
      </div>

      <!-- 加载微动效 -->
      <div v-if="descriptor.props?.isLoading" class="animate-spin text-[var(--rc-text-muted)] flex-shrink-0">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      </div>
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
          class="text-[11px] font-mono text-[var(--rc-text-secondary)] truncate"
          :title="cleanUiText(filterBarData.summaryText)"
        >
          {{ cleanUiText(filterBarData.summaryText) }}
        </span>
        <!-- 若未传 summaryText 但传了 metricGrid，则内联为紧凑单行指标文本 -->
        <div
          v-else-if="metricGridData?.items && metricGridData.items.length > 0"
          class="flex items-center gap-2 overflow-x-auto no-scrollbar text-[11px] font-mono truncate"
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
          :disabled="act.disabled"
          class="px-2 py-0.5 rounded-md text-[11px] font-medium transition-all flex items-center gap-1 border bg-[var(--rc-surface-hover)] text-[var(--rc-text-secondary)] border-[var(--rc-border)] hover:text-[var(--rc-text-primary)] hover:bg-[var(--rc-surface-active)]"
          :class="{
            'opacity-40 cursor-not-allowed': act.disabled
          }"
          @click="act.onAction && act.onAction()"
        >
          <span>{{ cleanUiText(act.label || act.title) }}</span>
          <span v-if="act.badge !== undefined" class="font-mono text-[10px] px-1 rounded bg-[var(--rc-surface-subtle)]">{{ act.badge }}</span>
        </button>
      </div>
    </div>

    <!-- 列表主体容器 -->
    <div class="flex-1 flex overflow-hidden">
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
          <div class="px-2.5 py-1.5 rounded-lg bg-[var(--rc-surface-hover)] border border-[var(--rc-border)] flex items-center justify-between">
            <span class="text-xs font-semibold text-[var(--rc-text-primary)] truncate">
              {{ cleanUiText(workbenchPanelData.title || '加工参数配置面板') }}
            </span>
            <span v-if="workbenchPanelData.subtitle" class="text-[10px] font-mono text-[var(--rc-text-muted)]">
              {{ cleanUiText(workbenchPanelData.subtitle) }}
            </span>
          </div>

          <!-- 参数表单项列表 -->
          <div class="space-y-1.5 bg-[var(--rc-canvas)]/40 rounded-xl p-2.5 border border-[var(--rc-border)]">
            <div
              v-for="field in workbenchPanelData.fields || []"
              :key="field.id"
              class="flex items-center justify-between gap-2 py-1 border-b border-[var(--rc-border)]/50 last:border-b-0"
            >
              <span class="text-xs text-[var(--rc-text-secondary)] font-medium flex-shrink-0">
                {{ cleanUiText(field.label) }}
              </span>

              <!-- 下拉选择型参数 -->
              <select
                v-if="field.type === 'select' && field.options"
                :value="field.value"
                class="bg-[var(--rc-surface-hover)] text-xs text-[var(--rc-text-primary)] rounded-lg px-2 py-1 border border-[var(--rc-border)] focus:outline-none focus:border-[var(--rc-border-highlight)] cursor-pointer max-w-[175px] truncate"
                @change="e => field.onChange && field.onChange(e.target.value)"
              >
                <option
                  v-for="opt in field.options"
                  :key="opt.value"
                  :value="opt.value"
                  class="bg-[#18181b] text-zinc-100"
                >
                  {{ cleanUiText(opt.label) }}
                </option>
              </select>

              <!-- 布尔开关型参数 -->
              <button
                v-else-if="field.type === 'toggle'"
                type="button"
                class="px-2.5 py-0.5 rounded-md text-[11px] font-medium border transition-all cursor-pointer"
                :class="[
                  field.value
                    ? 'bg-zinc-200 text-zinc-900 border-zinc-200 font-semibold'
                    : 'bg-[var(--rc-surface-hover)] text-[var(--rc-text-muted)] border-[var(--rc-border)]'
                ]"
                @click="field.onChange && field.onChange(!field.value)"
              >
                {{ field.value ? '已开启 ✓' : '已关闭' }}
              </button>

              <!-- 文本/只读展示型参数 -->
              <span
                v-else
                class="px-2 py-0.5 text-[11px] font-mono text-[var(--rc-text-secondary)] bg-[var(--rc-surface-hover)] border border-[var(--rc-border)] rounded-md truncate max-w-[175px]"
              >
                {{ cleanUiText(field.value) }}
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
                class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-[var(--rc-surface-active)] text-[var(--rc-text-secondary)] border border-[var(--rc-border)]"
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
                <span class="text-xs font-mono font-semibold text-[var(--rc-text-primary)]">
                  {{ m.value }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 分组遍历 (仅在未启用 workbenchPanelData 时展示左侧导航列表，避免参数面板下方重复堆砌) -->
        <template v-if="!workbenchPanelData">
        <div v-for="(sec, sIdx) in sections" :key="sIdx" class="space-y-1">
          <div
            v-if="sec.title"
            class="px-2.5 py-1 text-[11px] font-semibold text-[var(--rc-text-secondary)] flex items-center justify-between gap-2 bg-[var(--rc-surface-subtle)] rounded-lg border border-[var(--rc-border)]"
          >
            <div class="flex items-center gap-2 min-w-0">
              <button
                v-if="sec.checkable"
                type="button"
                class="w-3.5 h-3.5 rounded flex items-center justify-center border transition-all flex-shrink-0"
                :class="[
                  sec.checked === true
                    ? 'bg-zinc-200 border-zinc-200 text-zinc-900'
                    : sec.checked === 'indeterminate'
                    ? 'bg-zinc-700 border-zinc-500 text-zinc-200'
                    : 'bg-[var(--rc-surface-hover)] border-[var(--rc-border-highlight)] text-transparent'
                ]"
                @click.stop="sec.onCheckChange && sec.onCheckChange(sec.checked !== true)"
              >
                <span class="text-[10px] leading-none font-bold">{{ sec.checked === 'indeterminate' ? '−' : '✓' }}</span>
              </button>
              <span class="truncate">{{ cleanUiText(sec.title) }}</span>
            </div>
            <span v-if="sec.subtitle" class="text-[10px] font-mono text-[var(--rc-text-muted)] flex-shrink-0">{{ cleanUiText(sec.subtitle) }}</span>
          </div>

          <!-- Items 遍历 -->
          <div
            v-for="(item, iIdx) in sec.items"
            :key="item.id || `${sIdx}-${iIdx}`"
            :ref="el => registerItemEl(item, el)"
            class="flex items-center justify-between pl-2 pr-2.5 py-2 rounded-[10px] text-sm cursor-pointer transition-colors duration-100 border border-transparent"
            :class="[
              selectedItem === item
                ? 'bg-[var(--rc-surface-active)] text-[var(--rc-text-primary)] font-medium'
                : 'text-[var(--rc-text-secondary)] hover:bg-[var(--rc-surface-hover)]'
            ]"
            @click="selectItem(item, true)"
            @dblclick="emit('trigger-primary', item)"
            @contextmenu.prevent="handleContextMenu(item)"
          >
            <!-- 左侧复选框、图标与文本 -->
            <div class="flex items-center gap-2 min-w-0 flex-1 overflow-hidden pr-2">
              <span v-if="!item.props?.checkable" class="decl-marker" :class="{ 'is-on': selectedItem === item }" aria-hidden="true"></span>
              <button
                v-if="item.props?.checkable"
                type="button"
                class="w-3.5 h-3.5 rounded flex items-center justify-center border transition-all flex-shrink-0"
                :class="[
                  item.props?.checked === true
                    ? 'bg-zinc-200 border-zinc-200 text-zinc-900'
                    : item.props?.checked === 'indeterminate'
                    ? 'bg-zinc-700 border-zinc-500 text-zinc-200'
                    : 'bg-[var(--rc-surface-hover)] border-[var(--rc-border-highlight)] text-transparent'
                ]"
                @click.stop="toggleItemCheck(item)"
              >
                <span class="text-[10px] leading-none font-bold">{{ item.props?.checked === 'indeterminate' ? '−' : '✓' }}</span>
              </button>
              <DeclarativeIcon
                v-if="item.props?.icon"
                :icon="item.props.icon"
                :size="15"
                :class="selectedItem === item ? 'text-[var(--rc-text-primary)]' : 'text-[var(--rc-text-muted)]'"
              />
              <div class="flex flex-col justify-center min-w-0 flex-1 overflow-hidden">
                <span class="truncate font-medium text-[var(--rc-text-primary)] leading-snug text-[13px]">{{ cleanUiText(item.props?.title) }}</span>
                <span
                  v-if="item.props?.subtitle"
                  class="text-[11px] text-[var(--rc-text-muted)] truncate leading-tight"
                >
                  {{ cleanUiText(item.props.subtitle) }}
                </span>
              </div>
            </div>

            <!-- 右侧 Accessories 标签 (单色进度条 + 极简无彩色描边胶囊) -->
            <div class="flex items-center gap-1.5 flex-shrink-0">
              <template
                v-if="item.props?.accessories && item.props.accessories.length > 0"
              >
                <template v-for="(acc, aIdx) in item.props.accessories" :key="aIdx">
                  <div
                    v-if="acc.progress !== undefined"
                    class="w-14 h-1.5 rounded-full bg-white/[0.06] overflow-hidden flex-shrink-0"
                  >
                    <div
                      class="h-full rounded-full transition-all duration-300"
                      :style="{
                        width: `${Math.min(100, Math.max(6, typeof acc.progress === 'object' ? acc.progress.value : acc.progress))}%`,
                        backgroundColor: 'rgba(255, 255, 255, 0.26)'
                      }"
                    />
                  </div>
                  <span
                    v-else-if="acc.tag"
                    class="px-1.5 py-0.5 text-[11px] rounded-md font-medium border"
                    :style="getTagStyle(acc.tag)"
                  >
                    {{ cleanUiText(typeof acc.tag === 'object' ? acc.tag.value : acc.tag) }}
                  </span>
                  <span
                    v-else-if="acc.text"
                    class="px-1.5 py-0.5 text-[11px] font-mono text-[var(--rc-text-secondary)] bg-[var(--rc-surface-hover)] border border-[var(--rc-border)] rounded-md"
                  >
                    {{ cleanUiText(typeof acc.text === 'object' ? acc.text.value : acc.text) }}
                  </span>
                </template>
              </template>
            </div>
          </div>
        </div>

        <div
          v-if="flatItems.length === 0"
          class="p-12 text-center text-sm text-[var(--rc-text-muted)]"
        >
          未找到匹配条目
        </div>
        </template>
      </div>

      <!-- 方案二/三：右侧联动可操作文件/任务列表 (占 66%~68% 宽) -->
      <div
        v-if="subListData"
        :class="workbenchPanelData ? 'w-[66%]' : 'w-[68%]'"
        class="flex-1 flex flex-col overflow-hidden bg-[var(--rc-surface-subtle)]"
      >
        <!-- 右栏顶部状态与全选控制栏 -->
        <div class="px-3.5 py-1.5 border-b border-[var(--rc-border)] flex items-center justify-between gap-2 bg-[var(--rc-surface-subtle)]">
          <div class="flex items-center gap-2 min-w-0">
            <button
              v-if="subListData.checkable"
              type="button"
              class="w-3.5 h-3.5 rounded flex items-center justify-center border transition-all flex-shrink-0"
              :class="[
                subListData.checked === true
                  ? 'bg-zinc-200 border-zinc-200 text-zinc-900'
                  : subListData.checked === 'indeterminate'
                  ? 'bg-zinc-700 border-zinc-500 text-zinc-200'
                  : 'bg-[var(--rc-surface-hover)] border-[var(--rc-border-highlight)] text-transparent'
              ]"
              @click.stop="subListData.onCheckChange && subListData.onCheckChange(subListData.checked !== true)"
            >
              <span class="text-[10px] leading-none font-bold">{{ subListData.checked === 'indeterminate' ? '−' : '✓' }}</span>
            </button>
            <span class="text-xs font-semibold text-[var(--rc-text-primary)] truncate">{{ cleanUiText(subListData.title || '大文件明细列表') }}</span>
          </div>
          <span v-if="subListData.subtitle" class="text-[11px] font-mono text-[var(--rc-text-muted)] flex-shrink-0">
            {{ cleanUiText(subListData.subtitle) }}
          </span>
        </div>

        <!-- 右栏可勾选、带单色体积进度条的文件列表 -->
        <div class="flex-1 overflow-y-auto declarative-scrollbar p-2 space-y-1">
          <div
            v-for="(fItem, fIdx) in subListItems"
            :key="fItem.id || `sub-${fIdx}`"
            class="flex items-center justify-between pl-2.5 pr-3 py-2 rounded-[10px] text-sm cursor-pointer transition-colors duration-100 border border-transparent"
            :class="[
              selectedSubItem === fItem
                ? 'bg-[var(--rc-surface-active)] text-[var(--rc-text-primary)] font-medium'
                : 'text-[var(--rc-text-secondary)] hover:bg-[var(--rc-surface-hover)]'
            ]"
            @click="selectSubItem(fItem)"
            @dblclick="emit('trigger-primary', fItem)"
            @contextmenu.prevent="handleSubContextMenu(fItem)"
          >
            <!-- 左侧单色复选框/线性锁图标 + 文件名与完整父路径 -->
            <div class="flex items-center gap-2.5 min-w-0 flex-1 overflow-hidden pr-3">
              <button
                v-if="fItem.props?.checkable"
                type="button"
                class="w-3.5 h-3.5 rounded flex items-center justify-center border transition-all flex-shrink-0"
                :class="[
                  fItem.props?.checked === true
                    ? 'bg-zinc-200 border-zinc-200 text-zinc-900'
                    : 'bg-[var(--rc-surface-hover)] border-[var(--rc-border-highlight)] text-transparent'
                ]"
                @click.stop="toggleItemCheck(fItem)"
              >
                <span class="text-[10px] leading-none font-bold">✓</span>
              </button>
              <span
                v-else
                class="w-3.5 h-3.5 flex items-center justify-center text-[var(--rc-text-muted)] flex-shrink-0"
                title="系统保护文件，不可清理"
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
                <span class="truncate font-medium text-[var(--rc-text-primary)] leading-snug">{{ cleanUiText(fItem.props?.title) }}</span>
                <span
                  v-if="fItem.props?.subtitle"
                  class="text-[11px] text-[var(--rc-text-muted)] truncate leading-tight font-mono"
                >
                  {{ cleanUiText(fItem.props.subtitle) }}
                </span>
              </div>
            </div>

            <!-- 右侧：单色体积占比横条 + 极简中性标签 + 文件大小 -->
            <div class="flex items-center gap-2 flex-shrink-0">
              <template v-if="fItem.props?.accessories && fItem.props.accessories.length > 0">
                <template v-for="(acc, aIdx) in fItem.props.accessories" :key="aIdx">
                  <!-- 可视化体积条 (单色半透明灰白，拒绝五彩斑斓) -->
                  <div
                    v-if="acc.progress !== undefined"
                    class="w-16 h-1.5 rounded-full bg-white/[0.06] overflow-hidden flex-shrink-0"
                  >
                    <div
                      class="h-full rounded-full transition-all duration-300"
                      :style="{
                        width: `${Math.min(100, Math.max(6, typeof acc.progress === 'object' ? acc.progress.value : acc.progress))}%`,
                        backgroundColor: 'rgba(255, 255, 255, 0.26)'
                      }"
                    />
                  </div>
                  <!-- 分类徽章 -->
                  <span
                    v-else-if="acc.tag"
                    class="px-2 py-0.5 text-[11px] rounded-md font-medium border"
                    :style="getTagStyle(acc.tag)"
                  >
                    {{ cleanUiText(typeof acc.tag === 'object' ? acc.tag.value : acc.tag) }}
                  </span>
                  <!-- 文件大小 -->
                  <span
                    v-else-if="acc.text"
                    class="px-2 py-0.5 text-xs font-mono font-semibold text-[var(--rc-text-primary)] bg-[var(--rc-surface-hover)] border border-[var(--rc-border)] rounded-md min-w-[66px] text-right"
                  >
                    {{ cleanUiText(typeof acc.text === 'object' ? acc.text.value : acc.text) }}
                  </span>
                </template>
              </template>
            </div>
          </div>

          <div
            v-if="subListItems.length === 0"
            class="p-12 text-center text-sm text-[var(--rc-text-muted)]"
          >
            {{ subListData.emptyText || '当前范围内未找到可清理的大文件' }}
          </div>
        </div>
      </div>

      <!-- 右侧 Detail 分栏 (仅在无 subListData 且启用了 isShowingDetail 时展示) -->
      <div
        v-else-if="descriptor.props?.isShowingDetail && selectedItem?.props?.detail"
        class="w-[52%] border-l border-[var(--rc-border)] overflow-hidden flex flex-col bg-[var(--rc-surface-subtle)]"
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
  },
  activeActions: {
    type: Array,
    default: () => []
  }
});

const emit = defineEmits(["select", "trigger-primary", "trigger-action", "action-panel-change", "open-action-panel"]);

const searchInputRef = ref(null);
const listScrollRef = ref(null);
const localSearchText = ref("");
const selectedItem = ref(null);
const selectedSubItem = ref(null);
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

function cleanUiText(str) {
  if (str === undefined || str === null) return "";
  return String(str)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getTagStyle(tag) {
  const rawColor = typeof tag === "object" && tag?.color ? String(tag.color).toLowerCase() : "";
  const isDanger = rawColor === "#ef4444" || rawColor === "red" || rawColor.includes("ef4444");
  if (isDanger) {
    return {
      backgroundColor: "rgba(239, 68, 68, 0.12)",
      borderColor: "rgba(239, 68, 68, 0.25)",
      color: "#f87171"
    };
  }
  return {
    backgroundColor: "var(--rc-surface-hover)",
    borderColor: "var(--rc-border)",
    color: "var(--rc-text-secondary)"
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

function getItemKey(it) {
  if (!it) return "";
  return String(it.id ?? it.props?.id ?? it.key ?? it.props?.title ?? "");
}

function selectItem(item, invokeOnSelect = false) {
  const prevKey = getItemKey(selectedItem.value);
  const nextKey = getItemKey(item);
  selectedItem.value = item;
  if (invokeOnSelect && typeof item?.props?.onSelect === "function") {
    try {
      item.props.onSelect();
    } catch (err) {
      console.warn("[ListRenderer] item.onSelect error:", err);
    }
  }
  if (!subListData.value) {
    emit("select", item);
    emit("action-panel-change", item?.props?.actions || props.descriptor.props?.actions);
  }
  if (nextKey && nextKey !== prevKey && typeof props.descriptor.props?.onSelectionChange === "function") {
    try {
      props.descriptor.props.onSelectionChange(item?.id ?? item?.props?.id ?? nextKey);
    } catch (err) {
      console.warn("[ListRenderer] onSelectionChange error:", err);
    }
  }
}

function selectSubItem(fItem) {
  selectedSubItem.value = fItem;
  emit("select", fItem);
  emit("action-panel-change", fItem?.props?.actions || props.descriptor.props?.actions);
}

function handleSubContextMenu(fItem) {
  selectSubItem(fItem);
  emit("open-action-panel", fItem);
}

function handleContextMenu(item) {
  selectItem(item, true);
  emit("open-action-panel", item);
}

function focusNextItem() {
  if (subListData.value && subListItems.value.length > 0) {
    const items = subListItems.value;
    const currIdx = items.indexOf(selectedSubItem.value);
    const nextIdx = (currIdx + 1) % items.length;
    selectSubItem(items[nextIdx]);
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
  if (subListData.value && subListItems.value.length > 0) {
    const items = subListItems.value;
    const currIdx = items.indexOf(selectedSubItem.value);
    const prevIdx = (currIdx - 1 + items.length) % items.length;
    selectSubItem(items[prevIdx]);
    return;
  }
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
  if (items.length === 0) {
    selectedItem.value = null;
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
        if (!subListData.value) {
          emit("select", matchedByKey);
          emit("action-panel-change", matchedByKey?.props?.actions || props.descriptor.props?.actions);
        }
        return;
      }
    }
  }

  selectItem(items[0]);
}, { immediate: true });

watch(subListItems, (items) => {
  if (!subListData.value) return;
  if (items.length === 0) {
    selectedSubItem.value = null;
    return;
  }
  if (selectedSubItem.value) {
    const currKey = getItemKey(selectedSubItem.value);
    const matched = items.find((it) => getItemKey(it) === currKey);
    if (matched) {
      selectSubItem(matched);
      return;
    }
  }
  selectSubItem(items[0]);
}, { immediate: true });

onMounted(() => {
  tryRestoreInitialSnapshot();
  searchInputRef.value?.focus();
});

defineExpose({
  focusNextItem,
  focusPrevItem,
  getSelectedItem: () => (subListData.value ? selectedSubItem.value || selectedItem.value : selectedItem.value),
  focusSearch: () => searchInputRef.value?.focus(),
  hasSearchText,
  clearSearch,
  getViewStateSnapshot
});
</script>

<style scoped>
.decl-marker {
  width: 6px;
  height: 6px;
  border-radius: 1.7px;
  flex-shrink: 0;
  background: transparent;
}

.decl-marker.is-on {
  background: var(--rc-accent);
  box-shadow: var(--rc-marker-glow);
}

.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}
</style>
