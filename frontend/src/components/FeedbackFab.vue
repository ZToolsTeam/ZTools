<script setup>
/**
 * 悬浮反馈按钮
 * - 非插件详情页：点击跳转到反馈建议页（wish-wall）
 * - 插件详情页：点击切换到留言 tab 并滚动到留言区域
 * - 反馈建议页：隐藏按钮
 */
import { computed, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNavStore } from '@/stores/nav'

const route = useRoute()
const router = useRouter()
const nav = useNavStore()

// 在反馈建议页面隐藏，避免功能重复
const isOnFeedbackPage = computed(() => route.name === 'wish-wall')
// 是否在插件详情页
const isOnDetailsPage = computed(() => route.name === 'details')

const handleClick = async () => {
  if (isOnDetailsPage.value) {
    // 在插件详情页：切换到留言 tab 并滚动到留言区域
    // 通过点击留言 tab 按钮触发切换
    const tabBtns = document.querySelectorAll('.tab-btn')
    const commentsTab = Array.from(tabBtns).find(
      (btn) => btn.textContent.trim() === '留言'
    )
    if (commentsTab) {
      commentsTab.click()
      // 等待 DOM 更新后滚动到 tab 区域
      await nextTick()
      const tabContainer = document.querySelector('.tab-container')
      if (tabContainer) {
        tabContainer.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }
  } else {
    // 非详情页：跳转到反馈建议页，同步侧边栏状态
    nav.setPage('wish-wall')
    router.push({ name: 'wish-wall' })
  }
}
</script>

<template>
  <div v-if="!isOnFeedbackPage" class="feedback-fab-wrapper">
    <button
      class="feedback-fab"
      @click="handleClick"
      :title="isOnDetailsPage ? '留言' : '反馈建议'"
    >
      <i class="fa fa-commenting-o"></i>
    </button>
  </div>
</template>

<style scoped>
.feedback-fab-wrapper {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 900;
}

.feedback-fab {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  background: linear-gradient(135deg, #4a8cff 0%, #2d71ff 100%);
  color: white;
  font-size: 20px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(74, 140, 255, 0.4);
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.feedback-fab:hover {
  transform: scale(1.1);
  box-shadow: 0 6px 24px rgba(74, 140, 255, 0.5);
}
</style>
