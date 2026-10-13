<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  Modal,
  Dropdown,
  Menu,
  MenuItem,
  MenuDivider,
  Spin
} from 'ant-design-vue'

import { useUserStore } from '@/stores/user'
import { useUIStore } from '@/stores/ui'
import { useNavStore } from '@/stores/nav'
import { useToast } from '@/composables/useToast'
import { ROUTES } from '@/router/routes'

const router = useRouter()
const userStore = useUserStore()
const uiStore = useUIStore()
const nav = useNavStore()
const { toastSuccess, toastError } = useToast()

const isCheckingAuth = computed(() => userStore.isCheckingAuth)
const isLoggedIn = computed(() => userStore.isLoggedIn)
const userInfo = computed(() => userStore.userInfo)
const displayName = computed(() => userStore.displayName)
const avatar = computed(() => userStore.avatar)

// 打开登录弹窗
const goLogin = () => {
  uiStore.openLoginModal()
}

// 前往个人中心
const goProfile = () => {
  nav.setPage('profile') // 清除左侧菜单高亮
  router.push(ROUTES.PROFILE)
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
</script>

<template>
  <div class="flex items-center min-h-[32px]">
    <!-- 加载中状态 -->
    <div
      v-if="isCheckingAuth"
      class="flex items-center justify-center px-3 gap-2"
    >
      <i
        class="fa fa-spinner fa-spin text-lg"
        style="color: var(--zt-primary)"
      ></i>
      <span class="text-xs" style="color: var(--zt-text-secondary)"
        >加载中...</span
      >
    </div>

    <!-- 已登录状态 -->
    <div v-else-if="isLoggedIn && userInfo" class="flex items-center">
      <Dropdown placement="bottomRight" :trigger="['click']">
        <div
          class="flex items-center gap-2 px-2 py-1 rounded-lg cursor-pointer transition-all duration-200 group"
          onmouseover="this.style.backgroundColor='var(--zt-bg-hover)'"
          onmouseout="this.style.backgroundColor='transparent'"
        >
          <div class="relative">
            <img
              :src="avatar"
              class="w-7 h-7 rounded-full object-cover border shadow-sm"
              style="border-color: var(--zt-border)"
              alt="avatar"
            />
            <div
              class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2"
              style="
                background-color: var(--zt-success);
                border-color: var(--zt-bg-elevated);
              "
            ></div>
          </div>
          <span
            class="text-xs font-medium transition-colors group-hover:text-primary max-w-[120px] truncate"
            style="color: var(--zt-text)"
            :title="displayName"
          >
            {{ displayName }}
          </span>
          <i
            class="fa fa-angle-down transition-colors group-hover:text-primary text-[10px]"
            style="color: var(--zt-text-secondary)"
          ></i>
        </div>

        <template #overlay>
          <Menu
            class="min-w-[140px]"
            style="background-color: var(--zt-bg-elevated)"
          >
            <MenuItem
              key="profile"
              @click="goProfile"
              style="color: var(--zt-text)"
            >
              <template #icon
                ><i
                  class="fa fa-user-circle-o mr-2"
                  style="color: var(--zt-text-secondary)"
                ></i
              ></template>
              个人中心
            </MenuItem>
            <MenuDivider
              style="background-color: var(--zt-border); margin: 4px 8px"
            />
            <MenuItem
              key="logout"
              @click="handleLogout"
              class="!text-red-500 hover:!bg-red-50 dark:hover:!bg-red-900/20"
            >
              <template #icon><i class="fa fa-sign-out mr-2"></i></template>
              退出登录
            </MenuItem>
          </Menu>
        </template>
      </Dropdown>
    </div>

    <!-- 未登录状态 -->
    <button
      v-else
      class="login-btn-3d"
      @click="goLogin"
      title="登录后可无限制下载插件并启用云端同步"
    >
      <span class="login-btn-icon">
        <i class="fa fa-user"></i>
      </span>
      <span class="login-btn-text">登录</span>
    </button>
  </div>
</template>

<style scoped>
/* 登录按钮 - 3D 风格 */
.login-btn-3d {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px 6px 6px;
  border-radius: 20px;
  border: none;
  background: var(--color-gray-100);
  color: var(--zt-text);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.login-btn-3d:hover {
  background: var(--color-gray-200);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}

.login-btn-3d:active {
  transform: translateY(0);
}

.login-btn-icon {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: linear-gradient(135deg, #4a8cff 0%, #2d71ff 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 12px;
  box-shadow: 0 2px 8px rgba(45, 113, 255, 0.3);
  transition: all 0.3s ease;
}

.login-btn-3d:hover .login-btn-icon {
  transform: scale(1.1);
}

.login-btn-text {
  color: var(--zt-text);
}
:deep(.ant-dropdown-menu) {
  padding: 4px !important;
  background: transparent !important;
  border: none !important;
  box-shadow: none !important;
}

:deep(.ant-dropdown-menu-item) {
  border-radius: 8px;
  padding-top: 8px;
  padding-bottom: 8px;
}
</style>
