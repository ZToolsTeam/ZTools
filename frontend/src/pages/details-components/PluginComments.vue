<script setup>
import { useUserStore } from '@/stores/user'

const userStore = useUserStore()

const props = defineProps({
  comments: {
    type: Array,
    default: () => []
  },
  loading: Boolean,
  isInstalled: Boolean,
  submitting: Boolean,
  modelValue: String,
  replyTo: Object
})

const emit = defineEmits(['update:modelValue', 'update:replyTo', 'submit'])

const MAX_LENGTH = 300

/** 拦截输入，超出限制截断 */
const handleInput = (val) => {
  if (val.length > MAX_LENGTH) {
    emit('update:modelValue', val.slice(0, MAX_LENGTH))
  } else {
    emit('update:modelValue', val)
  }
}

/** 用户名截断，超过20字符显示省略号 */
const truncateName = (name) => {
  if (!name) return '用户'
  return name.length > 20 ? name.slice(0, 20) + '…' : name
}

/** 格式化时间，精确到分钟 */
const formatDate = (dateStr) => {
  if (!dateStr) return ''
  return dateStr.substring(0, 16).replace('T', ' ')
}

/**
 * 获取用户名颜色
 * 管理员: 强调色, 当前用户: 成功色, 其他用户: 默认文本色
 */
const getNameColor = (comment) => {
  const adminId = comment.adminId ?? comment.admin_id
  const userId = comment.userId ?? comment.user_id
  if (adminId) return 'var(--rc-accent-text)'
  if (userId && userStore.userInfo?.id && userId === userStore.userInfo.id) return 'var(--rc-success)'
  return 'var(--zt-text)'
}
</script>

<template>
  <div>
    <!-- 留言输入框 -->
    <div
      class="mb-8 p-4 rounded-lg"
      style="background-color: var(--zt-bg-hover)"
    >
      <div
        v-if="!isInstalled"
        class="text-center py-4"
        style="color: var(--zt-text-secondary)"
      >
        <i class="fa fa-lock mr-2"></i>
        安装该插件后即可参与留言
      </div>
      <div v-else>
        <div
          v-if="replyTo"
          class="mb-2 flex items-center justify-between px-3 py-1 rounded text-sm"
          style="
            background-color: var(--zt-primary-bg);
            color: var(--zt-primary);
          "
        >
          <span
            >回复 @{{ replyTo.user?.name || replyTo.admin?.name || '未知' }}:
            {{ replyTo.content.substring(0, 20)
            }}{{ replyTo.content.length > 20 ? '...' : '' }}</span
          >
          <button
            @click="$emit('update:replyTo', null)"
            class="hover:opacity-80"
          >
            <i class="fa fa-times"></i>
          </button>
        </div>
        <textarea
          :value="modelValue"
          @input="handleInput($event.target.value)"
          placeholder="说点什么吧..."
          rows="3"
          maxlength="300"
          class="w-full px-3 py-2 rounded-md text-sm resize-none outline-none border transition-colors"
          style="border-color: var(--zt-border); background: var(--zt-bg); color: var(--zt-text);"
          @focus="(e) => e.target.style.borderColor = 'var(--zt-primary)'"
          @blur="(e) => e.target.style.borderColor = 'var(--zt-border)'"
        />
        <div class="flex justify-between items-center mt-1">
          <span class="text-xs" :style="{ color: (modelValue || '').length >= MAX_LENGTH ? 'var(--rc-error)' : 'var(--zt-text-secondary)' }">
            {{ (modelValue || '').length }} / {{ MAX_LENGTH }}
          </span>
          <a-button
            type="primary"
            :loading="submitting"
            @click="$emit('submit')"
          >
            提交留言
          </a-button>
        </div>
      </div>
    </div>

    <!-- 留言列表 -->
    <div v-if="loading" class="text-center py-8">
      <a-spin />
    </div>
    <div
      v-else-if="comments.length === 0"
      class="text-center py-12"
      style="color: var(--zt-text-secondary)"
    >
      <i class="fa fa-comments-o text-5xl mb-4 opacity-40"></i>
      <p>暂无留言</p>
    </div>
    <div v-else class="space-y-6">
      <div
        v-for="comment in comments"
        :key="comment.id"
        class="flex gap-4 border-b pb-6"
        style="border-color: var(--zt-border)"
      >
        <div
          class="w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center overflow-hidden"
          style="background-color: var(--zt-bg-hover)"
        >
          <img
            v-if="comment.user?.avatar"
            :src="comment.user.avatar"
            class="w-full h-full rounded-full object-cover"
            @error="(e) => e.target.style.display = 'none'"
          />
          <i
            v-else
            class="fa fa-user"
            style="color: var(--zt-text-secondary)"
          ></i>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between mb-1">
            <div class="flex items-center gap-2">
              <span class="font-bold" :style="{ color: getNameColor(comment) }">{{
                truncateName(comment.user?.nickname || comment.user?.name || '用户')
              }}</span>
              <span
                v-if="comment.isPinned"
                class="bg-[var(--rc-error-subtle)] text-[var(--rc-error)] border border-[var(--rc-border)] text-[10px] px-1.5 py-0.5 rounded"
                >置顶</span
              >
              <span
                v-if="!comment.isPublic"
                class="bg-[var(--rc-kbd-bg)] text-[var(--rc-text-muted)] border border-[var(--rc-border)] text-[10px] px-1.5 py-0.5 rounded"
                >审核中</span
              >
            </div>
            <span
              class="text-xs opacity-60 flex-shrink-0 ml-2"
              style="color: var(--zt-text-secondary)"
              >{{ formatDate(comment.createdAt || comment.created_at) }}</span
            >
          </div>
          <div class="mb-2 whitespace-pre-wrap" style="color: var(--zt-text)">
            {{ comment.content }}
          </div>
          <div class="flex items-center gap-4 text-xs">
            <button
              @click="$emit('update:replyTo', comment)"
              class="text-[var(--rc-accent-text)] hover:underline"
            >
              回复
            </button>
          </div>

          <!-- 回复列表 -->
          <div
            v-if="comment.children && comment.children.length > 0"
            class="mt-4 space-y-4 p-4 rounded-lg"
            style="background-color: var(--zt-bg-hover)"
          >
            <div
              v-for="reply in comment.children"
              :key="reply.id"
              class="flex gap-3"
            >
              <div
                class="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center"
                style="background-color: var(--zt-bg-hover)"
              >
                <img
                  v-if="(reply.adminId || reply.admin_id) && reply.admin?.avatar"
                  :src="reply.admin.avatar"
                  class="w-full h-full rounded-full object-cover"
                />
                <img
                  v-else-if="reply.user?.avatar"
                  :src="reply.user.avatar"
                  class="w-full h-full rounded-full object-cover"
                />
                <i
                  v-else
                  class="fa"
                  :class="(reply.adminId || reply.admin_id) ? 'fa-shield' : 'fa-user'"
                  style="color: var(--zt-text-secondary)"
                ></i>
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between mb-1">
                  <div class="flex items-center gap-2">
                    <span
                      class="font-bold"
                      :style="{ color: getNameColor(reply) }"
                    >
                      {{ truncateName(reply.admin?.name || reply.user?.nickname || reply.user?.name || '未知') }}
                      <span
                        v-if="reply.adminId || reply.admin_id"
                        class="ml-1 text-[10px] bg-[var(--rc-accent-subtle)] text-[var(--rc-accent-text)] border border-[var(--rc-border)] px-1 rounded"
                        >管理员</span
                      >
                    </span>
                  </div>
                  <span
                    class="text-xs opacity-60 flex-shrink-0 ml-2"
                    style="color: var(--zt-text-secondary)"
                    >{{ formatDate(reply.createdAt || reply.created_at) }}</span
                  >
                </div>
                <div class="text-sm opacity-90" style="color: var(--zt-text)">
                  {{ reply.content }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
