<script setup>
/**
 * 快捷方式设置弹窗
 * 管理超级面板快捷方式前缀与插件的映射关系
 * 数据持久化到 user_settings.json 的 super_panel.shortcuts
 */
import { ref, computed, watch } from 'vue'
import { usePluginsStore } from '@/stores/plugins'
import { storeToRefs } from 'pinia'

const props = defineProps({
  open: { type: Boolean, default: false }
})
const emit = defineEmits(['update:open'])

const pluginsStore = usePluginsStore()
const { installedPlugins } = storeToRefs(pluginsStore)

// 快捷方式映射列表
const shortcuts = ref([])
// 编辑状态
const editingIndex = ref(-1)
const editForm = ref({ prefix: '', pluginId: '' })
const editError = ref('')
// 新增状态
const adding = ref(false)
const addForm = ref({ prefix: '', pluginId: '' })
const addError = ref('')

// 弹窗打开时加载数据
watch(() => props.open, async (val) => {
  if (val) {
    await loadShortcuts()
    resetEditState()
  }
})

// 从配置文件加载快捷方式映射
async function loadShortcuts() {
  try {
    if (!window.ztools?.config) return
    const config = await window.ztools.config.get('super_panel')
    shortcuts.value = Array.isArray(config?.shortcuts) ? [...config.shortcuts] : []
  } catch (e) {
    console.error('加载快捷方式失败:', e)
    shortcuts.value = []
  }
}

// 保存快捷方式映射到配置文件
async function saveShortcuts() {
  try {
    if (!window.ztools?.config) return
    const config = await window.ztools.config.get('super_panel') || {}
    config.shortcuts = shortcuts.value
    await window.ztools.config.set('super_panel', config)
  } catch (e) {
    console.error('保存快捷方式失败:', e)
  }
}

// 前缀校验：仅允许字母、数字、连字符，长度 1~20
function validatePrefix(prefix, excludeIndex = -1) {
  const raw = prefix.startsWith('/') ? prefix.slice(1) : prefix
  if (!raw) return '请输入前缀'
  if (raw.length > 20) return '前缀长度不能超过 20 个字符'
  if (!/^[a-zA-Z0-9-]+$/.test(raw)) return '前缀仅允许字母、数字和连字符'
  // 重复检查（大小写不敏感）
  const lower = raw.toLowerCase()
  const dup = shortcuts.value.some((s, i) => i !== excludeIndex && s.prefix.replace(/^\//, '').toLowerCase() === lower)
  if (dup) return '该前缀已被使用'
  return ''
}

// 自动补全 / 前缀
function normalizePrefix(prefix) {
  const raw = prefix.startsWith('/') ? prefix.slice(1) : prefix
  return '/' + raw
}

// 获取插件显示名称
function getPluginName(pluginId) {
  const p = installedPlugins.value.find(item => String(item.pluginId) === String(pluginId))
  return p?.name || pluginId
}

// 插件选项列表（已安装的插件）
const pluginOptions = computed(() =>
  (installedPlugins.value || []).map(p => ({
    value: String(p.pluginId),
    label: p.name || p.pluginId
  }))
)

// 新增映射
function startAdd() {
  adding.value = true
  addForm.value = { prefix: '', pluginId: '' }
  addError.value = ''
}

async function confirmAdd() {
  if (!addForm.value.pluginId) { addError.value = '请选择插件'; return }
  const err = validatePrefix(addForm.value.prefix)
  if (err) { addError.value = err; return }
  shortcuts.value.push({
    prefix: normalizePrefix(addForm.value.prefix),
    pluginId: addForm.value.pluginId
  })
  await saveShortcuts()
  adding.value = false
  addError.value = ''
}

function cancelAdd() {
  adding.value = false
  addError.value = ''
}

// 编辑映射
function startEdit(index) {
  editingIndex.value = index
  const item = shortcuts.value[index]
  editForm.value = { prefix: item.prefix.replace(/^\//, ''), pluginId: item.pluginId }
  editError.value = ''
}

async function confirmEdit() {
  if (!editForm.value.pluginId) { editError.value = '请选择插件'; return }
  const err = validatePrefix(editForm.value.prefix, editingIndex.value)
  if (err) { editError.value = err; return }
  shortcuts.value[editingIndex.value] = {
    prefix: normalizePrefix(editForm.value.prefix),
    pluginId: editForm.value.pluginId
  }
  await saveShortcuts()
  editingIndex.value = -1
  editError.value = ''
}

function cancelEdit() {
  editingIndex.value = -1
  editError.value = ''
}

// 删除映射
async function removeShortcut(index) {
  shortcuts.value.splice(index, 1)
  await saveShortcuts()
}

function resetEditState() {
  editingIndex.value = -1
  adding.value = false
  editError.value = ''
  addError.value = ''
}

function handleClose() {
  emit('update:open', false)
}

// 暴露给外部调用（宿主端通过 window.__openShortcutSettings 触发）
defineExpose({ open: () => emit('update:open', true) })
</script>

<template>
  <a-modal
    :open="open"
    title="快捷方式设置"
    :footer="null"
    :width="520"
    centered
    @cancel="handleClose"
  >
    <div class="shortcut-content">
      <!-- 映射列表 -->
      <div v-if="shortcuts.length === 0 && !adding" class="empty-tip">
        暂无快捷方式，点击下方按钮添加
      </div>

      <div v-for="(item, index) in shortcuts" :key="index" class="shortcut-row">
        <!-- 查看模式 -->
        <template v-if="editingIndex !== index">
          <span class="shortcut-prefix">{{ item.prefix }}</span>
          <span class="shortcut-arrow">→</span>
          <span class="shortcut-plugin">{{ getPluginName(item.pluginId) }}</span>
          <div class="shortcut-actions">
            <a-button size="small" type="link" @click="startEdit(index)">编辑</a-button>
            <a-popconfirm title="确定删除？" @confirm="removeShortcut(index)">
              <a-button size="small" type="link" danger>删除</a-button>
            </a-popconfirm>
          </div>
        </template>
        <!-- 编辑模式 -->
        <template v-else>
          <div class="shortcut-edit-row">
            <a-input
              v-model:value="editForm.prefix"
              placeholder="前缀"
              size="small"
              style="width: 120px"
              addon-before="/"
            />
            <a-select
              v-model:value="editForm.pluginId"
              placeholder="选择插件"
              size="small"
              style="width: 200px"
              show-search
              :filter-option="(input, option) => option.label.toLowerCase().includes(input.toLowerCase())"
              :options="pluginOptions"
            />
            <a-button size="small" type="primary" @click="confirmEdit">确定</a-button>
            <a-button size="small" @click="cancelEdit">取消</a-button>
          </div>
          <div v-if="editError" class="error-tip">{{ editError }}</div>
        </template>
      </div>

      <!-- 新增行 -->
      <div v-if="adding" class="shortcut-row">
        <div class="shortcut-edit-row">
          <a-input
            v-model:value="addForm.prefix"
            placeholder="前缀"
            size="small"
            style="width: 120px"
            addon-before="/"
          />
          <a-select
            v-model:value="addForm.pluginId"
            placeholder="选择插件"
            size="small"
            style="width: 200px"
            show-search
            :filter-option="(input, option) => option.label.toLowerCase().includes(input.toLowerCase())"
            :options="pluginOptions"
          />
          <a-button size="small" type="primary" @click="confirmAdd">确定</a-button>
          <a-button size="small" @click="cancelAdd">取消</a-button>
        </div>
        <div v-if="addError" class="error-tip">{{ addError }}</div>
      </div>

      <!-- 新增按钮 -->
      <div class="add-btn-row">
        <a-button type="dashed" block @click="startAdd" :disabled="adding">
          <i class="fa fa-plus" style="margin-right: 6px"></i>新增快捷方式
        </a-button>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.shortcut-content {
  padding: 4px 0;
}
.empty-tip {
  text-align: center;
  color: var(--rc-text-secondary);
  padding: 24px 0;
  font-size: 13px;
}
.shortcut-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--rc-radius-md, 8px);
  background: var(--rc-surface-subtle);
  border: 1px solid var(--rc-border);
  margin-bottom: 8px;
  transition: border-color 0.15s ease;
}
.shortcut-row:hover {
  border-color: var(--rc-border-highlight);
}
.shortcut-prefix {
  font-weight: 600;
  font-family: var(--rc-font-mono, monospace);
  font-size: 13px;
  color: var(--rc-accent-text);
}
.shortcut-arrow {
  color: var(--rc-text-muted);
  font-size: 13px;
}
.shortcut-plugin {
  flex: 1;
  font-size: 13px;
  color: var(--rc-text-primary);
}
.shortcut-actions {
  display: flex;
  gap: 2px;
}
.shortcut-edit-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.error-tip {
  width: 100%;
  color: var(--rc-error);
  font-size: 12px;
  margin-top: 2px;
}
.add-btn-row {
  margin-top: 12px;
}
</style>
