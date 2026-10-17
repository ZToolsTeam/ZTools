<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Modal } from 'ant-design-vue'
import { useUserStore } from '@/stores/user'
import { getFeedbackList } from '@/api/feedback'
import { uploadAvatar, updateUser } from '@/api/apiserver'
import { useToast } from '@/composables/useToast'
import { ROUTES } from '@/router/routes'

const router = useRouter()
const userStore = useUserStore()
const { toastSuccess, toastError } = useToast()

const fileInput = ref(null)
const uploadingAvatar = ref(false)

// 修改昵称相关
const nicknameModalVisible = ref(false)
const nicknameInput = ref('')
const savingNickname = ref(false)

// 打开修改昵称弹窗
const openNicknameModal = () => {
  nicknameInput.value = userInfo.value?.nickname || ''
  nicknameModalVisible.value = true
}

// 保存昵称
const saveNickname = async () => {
  const name = nicknameInput.value.trim()
  if (!name) {
    toastError('昵称不能为空')
    return
  }
  if (name.length > 100) {
    toastError('昵称不能超过 100 个字符')
    return
  }
  // 没有变化则直接关闭
  if (name === userInfo.value?.nickname) {
    nicknameModalVisible.value = false
    return
  }
  savingNickname.value = true
  try {
    const updatedUser = await updateUser({ nickname: name })
    userStore.setLoginStatus(true, updatedUser)
    toastSuccess('昵称修改成功')
    nicknameModalVisible.value = false
  } catch (e) {
    console.error('修改昵称失败:', e)
    toastError(e.message || '修改昵称失败')
  } finally {
    savingNickname.value = false
  }
}

const userInfo = computed(() => userStore.userInfo)
const displayName = computed(() => userStore.displayName)
const avatar = computed(() => userStore.avatar)

const myDemands = ref([])
const loadingDemands = ref(false)

// 触发文件选择
const triggerSelectFile = () => {
  if (uploadingAvatar.value) return
  fileInput.value?.click()
}

// 处理头像上传
const handleAvatarChange = async (event) => {
  const file = event.target.files?.[0]
  if (!file) return

  // 校验文件类型和大小
  if (!file.type.startsWith('image/')) {
    toastError('请选择图片文件')
    return
  }
  if (file.size > 2 * 1024 * 1024) {
    toastError('图片大小不能超过 2MB')
    return
  }

  uploadingAvatar.value = true
  try {
    const res = await uploadAvatar(file)
    // 更新 Store 中的用户信息
    userStore.setLoginStatus(true, res.user)
    toastSuccess('头像更新成功')
  } catch (e) {
    console.error('上传头像失败:', e)
    toastError(e.message || '头像上传失败')
  } finally {
    uploadingAvatar.value = false
    // 清空 input，允许重复选择同一文件
    if (event.target) event.target.value = ''
  }
}

// 模拟勋章数据
const badges = ref([
  {
    id: 1,
    name: '内测达人',
    icon: 'fa-rocket',
    color: 'text-blue-500',
    bg: 'bg-[var(--rc-accent-subtle)] dark:bg-blue-900/20'
  },
  {
    id: 2,
    name: '极客',
    icon: 'fa-code',
    color: 'text-purple-500',
    bg: 'bg-purple-50 dark:bg-purple-900/20'
  }
])

// 获取用户注册时间（兼容 created_at 为 null 的旧数据）
const userCreatedAt = computed(() => {
  return userInfo.value?.created_at || userInfo.value?.last_login_at || null
})

// 计算注册天数
const registrationDays = computed(() => {
  if (!userCreatedAt.value) return 1
  const created = new Date(userCreatedAt.value)
  const now = new Date()
  const diff = now - created
  return Math.max(1, Math.floor(diff / (1000 * 60 * 60 * 24)))
})

// 格式化日期
const formatDate = (dateStr) => {
  if (!dateStr) return '未知'
  const date = new Date(dateStr)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// 获取我的反馈列表（新接口：content 替代 title+description，likesCount/repliesCount 替代 votes/comments）
const loadMyDemands = async () => {
  if (!userInfo.value?.id) return
  loadingDemands.value = true
  try {
    // 通过 user_id 参数让后端只返回当前用户的反馈
    const res = await getFeedbackList({ per_page: 100, user_id: userInfo.value.id })
    myDemands.value = res.data || []
  } catch (e) {
    console.error('加载我的反馈失败:', e)
  } finally {
    loadingDemands.value = false
  }
}

const getStatusColor = (status) => {
  const colors = {
    pending: 'bg-yellow-50 text-[var(--rc-warning)] dark:bg-yellow-900/20 dark:text-[var(--rc-warning)]',
    approved: 'bg-[var(--rc-accent-subtle)] text-[var(--rc-accent-text)] dark:bg-blue-900/20 dark:text-blue-400',
    developing: 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400',
    completed: 'bg-[var(--rc-success-subtle)] text-[var(--rc-success)] dark:bg-green-900/30 dark:text-[var(--rc-success)]',
    rejected: 'bg-[var(--rc-error-subtle)] text-[var(--rc-error)] dark:bg-red-900/30 dark:text-[var(--rc-error)]'
  }
  return colors[status] || colors.pending
}

const getStatusText = (status) => {
  const texts = {
    pending: '待审核',
    approved: '已通过',
    developing: '开发中',
    completed: '已完成',
    rejected: '已拒绝'
  }
  return texts[status] || status
}

// 退出登录
const handleLogout = () => {
  Modal.confirm({
    title: '确认退出登录？',
    content: '退出后将无法使用云端同步功能',
    okText: '退出',
    cancelText: '取消',
    onOk: async () => {
      try {
        await userStore.logout()
        toastSuccess('已退出登录')
        router.push(ROUTES.HOME)
      } catch (err) {
        console.error('退出登录失败:', err)
        toastError('退出登录失败，请重试')
      }
    }
  })
}

onMounted(() => {
  loadMyDemands()
})
</script>

<template>
  <div class="max-w-4xl mx-auto space-y-6 pb-10">
    <!-- 1. 账号核心 (Account Identity) -->
    <section
      class="rounded-2xl border p-8 shadow-sm relative overflow-hidden"
      style="
        background-color: var(--zt-bg-elevated);
        border-color: var(--zt-border);
      "
    >
      <!-- 背景装饰 -->
      <div
        class="absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 bg-blue-500/5 rounded-full blur-3xl"
      ></div>

      <div
        class="flex flex-col md:flex-row items-center md:items-start gap-8 relative z-10"
      >
        <!-- 大头像 -->
        <div class="relative group cursor-pointer" @click="triggerSelectFile">
          <div
            class="relative w-32 h-32 overflow-hidden rounded-3xl border-4 shadow-xl transition-transform duration-500 group-hover:scale-105"
            style="border-color: var(--zt-bg-elevated)"
          >
            <img
              :src="avatar"
              class="w-full h-full object-cover"
              :class="{ 'opacity-50': uploadingAvatar }"
              alt="avatar"
            />
            <!-- 上传中遮罩 -->
            <div
              v-if="uploadingAvatar"
              class="absolute inset-0 flex items-center justify-center bg-[var(--rc-surface-subtle)]"
            >
              <div
                class="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin"
              ></div>
            </div>
            <!-- 悬浮提示 -->
            <div
              class="absolute inset-0 bg-[var(--rc-surface-subtle)] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <i class="fa fa-camera text-[var(--rc-text-primary)] text-xl"></i>
            </div>
          </div>
          <div
            class="absolute -bottom-2 -right-2 bg-[var(--rc-accent)] text-[var(--rc-accent-contrast)] w-10 h-10 rounded-2xl flex items-center justify-center border-4 shadow-lg group-hover:bg-[var(--rc-accent)] transition-colors"
            style="border-color: var(--zt-bg-elevated)"
          >
            <i class="fa fa-camera text-sm"></i>
          </div>
          <!-- 隐藏的文件选择器 -->
          <input
            type="file"
            ref="fileInput"
            class="hidden"
            accept="image/*"
            @change="handleAvatarChange"
          />
        </div>

        <!-- 身份信息 -->
        <div class="flex-1 text-center md:text-left space-y-4">
          <div>
            <div class="flex items-center gap-2">
              <h1 class="text-3xl font-bold max-w-[300px] truncate" style="color: var(--zt-text)" :title="displayName">
                {{ displayName }}
              </h1>
              <button
                class="w-7 h-7 rounded-lg flex items-center justify-center bg-transparent border-0 cursor-pointer opacity-40 hover:opacity-100 hover:bg-black/5 dark:hover:bg-[var(--rc-surface-hover)] transition-all"
                title="修改昵称"
                @click="openNicknameModal"
              >
                <i class="fa fa-pencil text-sm" style="color: var(--zt-text)"></i>
              </button>
            </div>
            <p
              class="text-sm opacity-60"
              style="color: var(--zt-text-secondary)"
            >
              ZTools 陪伴你走过了 {{ registrationDays }} 天
            </p>
          </div>

          <!-- 勋章展示 -->
          <div class="flex flex-wrap justify-center md:justify-start gap-3">
            <div
              v-for="badge in badges"
              :key="badge.id"
              class="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium"
              :class="[badge.color, badge.bg]"
            >
              <i class="fa" :class="badge.icon"></i>
              {{ badge.name }}
            </div>
          </div>
        </div>
      </div>
    </section>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <!-- 2. 账号安全 (Account Security) -->
      <section
        class="md:col-span-1 rounded-2xl border p-6 shadow-sm"
        style="
          background-color: var(--zt-bg-elevated);
          border-color: var(--zt-border);
        "
      >
        <h3
          class="text-sm font-bold uppercase tracking-wider mb-5 flex items-center gap-2"
          style="color: var(--zt-text-secondary)"
        >
          <i class="fa fa-shield text-blue-500"></i>
          账号安全
        </h3>

        <div class="space-y-4">
          <div
            class="p-4 rounded-xl border"
            style="
              background-color: var(--zt-bg-hover);
              border-color: var(--zt-border);
            "
          >
            <p class="text-[11px] mb-1" style="color: var(--zt-text-secondary)">
              绑定微信
            </p>
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium" style="color: var(--zt-text)">
                {{
                  userInfo?.openid
                    ? `wx_***${userInfo.openid.slice(-6)}`
                    : '未绑定'
                }}
              </span>
              <i class="fa fa-wechat text-[var(--rc-success)]"></i>
            </div>
          </div>

          <div
            class="p-4 rounded-xl border"
            style="
              background-color: var(--zt-bg-hover);
              border-color: var(--zt-border);
            "
          >
            <p class="text-[11px] mb-1" style="color: var(--zt-text-secondary)">
              绑定时间
            </p>
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium" style="color: var(--zt-text)">
                {{ formatDate(userCreatedAt) }}
              </span>
              <i
                class="fa fa-calendar-check-o opacity-40"
                style="color: var(--zt-text-secondary)"
              ></i>
            </div>
          </div>

          <button
            class="w-full py-3 text-xs font-medium text-[var(--rc-error)] hover:bg-[var(--rc-error-subtle)] dark:hover:bg-red-900/10 rounded-xl border border-[var(--rc-border)] dark:border-red-900/30 transition-colors mt-2 cursor-pointer bg-transparent"
            @click="handleLogout"
          >
            退出登录
          </button>
        </div>
      </section>

      <!-- 3. 我的需求 (My Demands) -->
      <section
        class="md:col-span-2 rounded-2xl border p-6 shadow-sm"
        style="
          background-color: var(--zt-bg-elevated);
          border-color: var(--zt-border);
        "
      >
        <div class="flex items-center justify-between mb-5">
          <h3
            class="text-sm font-bold uppercase tracking-wider flex items-center gap-2"
            style="color: var(--zt-text-secondary)"
          >
            <i class="fa fa-lightbulb-o text-[var(--rc-warning)]"></i>
            我的反馈
          </h3>
          <span
            class="text-[11px] px-2 py-0.5 rounded-full"
            style="
              background-color: var(--zt-bg-hover);
              color: var(--zt-text-secondary);
            "
          >
            {{ myDemands.length }} 个建议
          </span>
        </div>

        <div v-if="loadingDemands" class="flex flex-col items-center py-10">
          <div
            class="w-8 h-8 border-2 border-t-blue-500 rounded-full animate-spin mb-3"
            style="
              border-color: var(--zt-bg-hover);
              border-top-color: var(--zt-primary);
            "
          ></div>
          <p class="text-xs" style="color: var(--zt-text-secondary)">
            正在同步需求记录...
          </p>
        </div>

        <div v-else-if="myDemands.length > 0" class="space-y-3">
          <div
            v-for="item in myDemands"
            :key="item.id"
            class="group p-4 rounded-xl border transition-all cursor-pointer"
            style="
              background-color: var(--zt-bg-hover);
              border-color: var(--zt-border);
            "
            onmouseover="this.style.borderColor='var(--zt-primary)'"
            onmouseout="this.style.borderColor='var(--zt-border)'"
          >
            <div class="flex items-start justify-between gap-4">
              <div class="flex-1">
                <p
                  class="text-sm mb-1 line-clamp-2"
                  style="color: var(--zt-text)"
                >
                  {{ item.content || item.description || item.title || '' }}
                </p>
              </div>
              <span
                class="shrink-0 text-[10px] px-2 py-0.5 rounded-full font-medium"
                :class="getStatusColor(item.status)"
              >
                {{ getStatusText(item.status) }}
              </span>
            </div>
            <div
              class="mt-3 flex items-center justify-between text-[10px]"
              style="color: var(--zt-text-secondary)"
            >
              <div class="flex items-center gap-3">
                <span class="flex items-center gap-1">
                  <i class="fa fa-thumbs-o-up"></i> {{ item.likesCount || item.likes_count || item.votesCount || item.votes_count || 0 }}
                </span>
                <span class="flex items-center gap-1">
                  <i class="fa fa-comment-o"></i> {{ item.repliesCount || item.replies_count || item.commentsCount || item.comments_count || 0 }}
                </span>
              </div>
              <span>{{ formatDate(item.createdAt || item.created_at) }}</span>
            </div>
          </div>
        </div>

        <div v-else class="flex flex-col items-center py-16 text-center">
          <div
            class="w-16 h-16 rounded-full flex items-center justify-center mb-4 text-gray-200 dark:text-[var(--rc-text-secondary)]"
            style="background-color: var(--zt-bg-hover)"
          >
            <i class="fa fa-sticky-note-o text-3xl"></i>
          </div>
          <p class="text-sm mb-1" style="color: var(--zt-text)">
            还没有提交过反馈
          </p>
          <p class="text-xs" style="color: var(--zt-text-secondary)">
            去反馈建议页说说你的想法吧
          </p>
        </div>
      </section>
    </div>

    <!-- 修改昵称弹窗 -->
    <a-modal
      v-model:open="nicknameModalVisible"
      title="修改昵称"
      :confirm-loading="savingNickname"
      ok-text="保存"
      cancel-text="取消"
      :width="400"
      @ok="saveNickname"
    >
      <div class="py-4">
        <a-input
          v-model:value="nicknameInput"
          placeholder="请输入新昵称"
          :maxlength="100"
          show-count
          allow-clear
          @press-enter="saveNickname"
        />
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.line-clamp-1 {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
  line-clamp: 1;
  overflow: hidden;
}
</style>
