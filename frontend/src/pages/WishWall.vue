<script setup>
import { ref, computed, onMounted, reactive, watch } from 'vue'
import { useUserStore } from '@/stores/user'
import { useUIStore } from '@/stores/ui'
import { useFeedbackUnreadStore } from '@/stores/feedbackUnread'
import { buildFeedbackLogPackage } from '@/utils/feedbackLogPackage'
import {
  getFeedbackList,
  getFeedbackReplies,
  createFeedback,
  uploadFeedbackAttachment,
  likeFeedback,
  unlikeFeedback,
  likeFeedbackReply,
  unlikeFeedbackReply,
  addFeedbackReply
} from '@/api/feedback'
import { useToast } from '@/composables/useToast'

const userStore = useUserStore()
const uiStore = useUIStore()
const feedbackUnreadStore = useFeedbackUnreadStore()
const { toastSuccess, toastError } = useToast()

// Data
const requests = ref([])
const total = ref(0)
const loading = ref(false)
const submitting = ref(false)
const uploadingAttachment = ref(false)
const attachmentInput = ref(null)
const expandedIds = ref(new Set())
const commentsByRequest = reactive({})
const commentsLoadingByRequest = reactive({})
const speechLikeState = reactive({})

const filters = reactive({
  page: 1,
  pageSize: 20,
  status: 'all',
  sort: 'created_at',
  onlyMine: false
})

const form = reactive({
  content: '',
  attachments: []
})

const FEEDBACK_TYPE_FEATURE = 'feature'
const FEEDBACK_TYPE_BUG = 'bug'

const feedbackType = ref(FEEDBACK_TYPE_FEATURE)
const packagingLogs = ref(false)

// Computed
const isLoggedIn = computed(() => userStore.isLoggedIn)
const totalPages = computed(() => Math.ceil(total.value / filters.pageSize))
const statusOptions = computed(() => {
  const options = [
    { value: 'all', label: '全部' },
    { value: 'pending', label: '待审核' },
    { value: 'approved', label: '已通过' },
    { value: 'developing', label: '开发中' },
    { value: 'completed', label: '已完成' }
  ]

  if (isLoggedIn.value) {
    options.push({ value: 'mine', label: '我的反馈' })
  }

  return options
})

const statusFilterValue = computed({
  get() {
    return filters.onlyMine ? 'mine' : filters.status
  },
  set(value) {
    if (value === 'mine') {
      filters.onlyMine = true
      filters.status = 'all'
      return
    }

    filters.onlyMine = false
    filters.status = value
  }
})

const isBugFeedback = computed(() => feedbackType.value === FEEDBACK_TYPE_BUG)

const logAttachment = computed(() =>
  form.attachments.find((item) => item.type === 'log' || item.isAutoLog)
)

const userAttachmentCount = computed(() =>
  form.attachments.filter((item) => item.type !== 'log' && !item.isAutoLog).length
)

const buildAndUploadLogAttachment = async () => {
  if (logAttachment.value) {
    return logAttachment.value
  }

  const file = await buildFeedbackLogPackage(window.ztools)
  const attachment = await uploadFeedbackAttachment(file)
  const logItem = { ...attachment, type: 'log', isAutoLog: true }
  form.attachments.push(logItem)

  return logItem
}

// 新反馈接口返回 camelCase 字段：likesCount/hasLiked/createdAt/user:{nickname,avatar}
// 页面沿用旧命名：votes / is_voted / created_at / user_nickname / user_avatar
// 这里把后端字段统一映射到页面字段，避免改动模板
const normalizeRequestItem = (item) => {
  const isLiked = Boolean(item?.hasLiked ?? item?.has_liked ?? item?.is_voted ?? false)
  const likes = Number(item?.likesCount ?? item?.likes_count ?? item?.votes ?? 0)
  const replies = Number(item?.repliesCount ?? item?.replies_count ?? 0)
  const createdAt = item?.createdAt ?? item?.created_at ?? ''
  const latestUnreadReplyAt =
    item?.latestUnreadReplyAt ?? item?.latest_unread_reply_at ?? null
  const userNickname = item?.user?.nickname ?? item?.user_nickname ?? item?.author ?? '匿名'
  const userAvatar = item?.user?.avatar ?? item?.user_avatar ?? ''

  return {
    ...item,
    attachments: item?.attachments || [],
    votes: likes,
    is_voted: isLiked,
    replies_count: replies,
    hasUnreadReplies: Boolean(item?.hasUnreadReplies ?? item?.has_unread_replies ?? false),
    has_unread_replies: Boolean(item?.hasUnreadReplies ?? item?.has_unread_replies ?? false),
    latestUnreadReplyAt,
    latest_unread_reply_at: latestUnreadReplyAt,
    created_at: createdAt,
    user_nickname: userNickname,
    user_avatar: userAvatar
  }
}

const getFeedbackHasUnread = (req) => Boolean(
  !feedbackUnreadStore.isLocallyRead(
    req?.id,
    req?.latestUnreadReplyAt || req?.latest_unread_reply_at
  ) &&
  (
    req?.hasUnreadReplies ||
    req?.has_unread_replies ||
    feedbackUnreadStore.hasUnreadFor(req?.id)
  )
)

const markRequestRepliesReadLocal = (id) => {
  const feedbackId = Number(id)
  if (!Number.isInteger(feedbackId) || feedbackId <= 0) {
    return
  }

  let latestUnreadReplyAt = null
  for (const item of requests.value) {
    if (Number(item.id) === feedbackId) {
      latestUnreadReplyAt =
        item.latestUnreadReplyAt || item.latest_unread_reply_at || null
      item.hasUnreadReplies = false
      item.has_unread_replies = false
    }
  }

  feedbackUnreadStore.markLocalRead(
    feedbackId,
    latestUnreadReplyAt
  )
}

const getAttachmentFileName = (attachment) => {
  return attachment?.fileName || attachment?.file_name || '附件'
}

const formatAttachmentSize = (size) => {
  const value = Number(size || 0)
  if (!value) return ''
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`
  }
  return `${Math.max(1, Math.round(value / 1024))} KB`
}

const triggerAttachmentSelect = () => {
  if (!isLoggedIn.value) {
    uiStore.openLoginModal()
    return
  }
  attachmentInput.value?.click()
}

const removeAttachment = (attachmentId) => {
  form.attachments = form.attachments.filter((item) => {
    if (item.id !== attachmentId) return true
    return item.type === 'log' || item.isAutoLog
  })
}

const handleAttachmentChange = async (event) => {
  const files = Array.from(event.target.files || [])
  event.target.value = ''
  if (files.length === 0) return

  if (!isLoggedIn.value) {
    uiStore.openLoginModal()
    return
  }

  const currentVideoCount = form.attachments.filter((item) => item.type === 'video').length
  const selectedVideoCount = files.filter((file) => file.type.startsWith('video/')).length
  if (currentVideoCount + selectedVideoCount > 1) {
    toastError('视频附件最多只能上传 1 个')
    return
  }
  if (userAttachmentCount.value + files.length > 6) {
    toastError('附件最多只能上传 6 个')
    return
  }

  uploadingAttachment.value = true
  try {
    for (const file of files) {
      if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
        throw new Error('附件只支持图片和视频')
      }
      if (file.type.startsWith('image/') && file.size > 10 * 1024 * 1024) {
        throw new Error('图片大小不能超过 10MB')
      }
      if (file.type.startsWith('video/') && file.size > 100 * 1024 * 1024) {
        throw new Error('视频大小不能超过 100MB')
      }

      const attachment = await uploadFeedbackAttachment(file)
      form.attachments.push(attachment)
    }
    toastSuccess('附件上传成功')
  } catch (err) {
    toastError(err.message || '附件上传失败')
  } finally {
    uploadingAttachment.value = false
  }
}

// Methods
const loadRequests = async () => {
  loading.value = true
  try {
    const params = {
      page: filters.page,
      per_page: filters.pageSize,
      sort: filters.sort,
      direction: 'desc'
    }

    if (filters.status !== 'all') {
      params.status = filters.status
    }

    if (filters.onlyMine && userStore.userInfo?.id) {
      params.user_id = userStore.userInfo.id
    }

    const res = await getFeedbackList(params)
    requests.value = (res.data || []).map(normalizeRequestItem)
    total.value = res.total || 0
  } catch (err) {
    console.error('加载反馈列表失败:', err)
    toastError('加载失败: ' + (err.message || '未知错误'))
  } finally {
    loading.value = false
  }
}

const handleVote = async (id) => {
  if (!isLoggedIn.value) {
    uiStore.openLoginModal()
    return
  }

  try {
    const item = requests.value.find((r) => r.id === id)
    const isCancel = Boolean(item?.is_voted)
    const res = isCancel ? await unlikeFeedback(id) : await likeFeedback(id)

    if (item) {
      Object.assign(item, normalizeRequestItem(res))
    }

    toastSuccess(isCancel ? '已取消点赞' : '点赞成功')
    // 埋点：反馈点赞
    window.ztools?.analytics?.report('feedback_vote', '', { wish_id: id, action: isCancel ? 'cancel' : 'vote' })
  } catch (err) {
    if (err.status === 401 || err.message?.includes('登录')) {
      uiStore.openLoginModal()
    } else {
      toastError(err.message || '点赞失败')
    }
  }
}

// 打开群聊二维码（在外部浏览器中打开）
function handleOpenQrcode() {
  if (window.ztools && window.ztools.shell) {
    window.ztools.shell.openExternal('https://www.ztools.cn/assets/ztools_qrcode.png')
  }
}

// 新接口回复节点字段：content/likesCount/hasLiked/createdAt/user/replies[]
// 若回复者是管理员，后端返回 adminId/admin/isAdminReply，用于前端特别显示
// 递归展开整棵子树，保留旧的 children 字段名给模板用
const normalizeCommentItem = (item) => {
  const likes = Number(item?.likesCount ?? item?.likes_count ?? 0)
  const isLiked = Boolean(item?.hasLiked ?? item?.has_liked ?? false)
  const createdAt = item?.createdAt ?? item?.created_at ?? ''
  // 管理员回复优先用 admin.name 展示身份
  const isAdminReply = Boolean(item?.isAdminReply ?? item?.is_admin_reply ?? item?.adminId ?? item?.admin_id)
  const adminName = item?.admin?.name ?? item?.admin_name ?? ''
  const userNickname = isAdminReply
    ? (adminName || '管理员')
    : (item?.user?.nickname ?? item?.user_nickname ?? item?.author ?? '用户')
  // admins 表没有 avatar 字段，且后端 admin 回复时 user_id 复用了根反馈提交者，
  // 直接取 user.avatar 会拿到发起人的头像，这里强制置空，让模板走管理员图标
  const userAvatar = isAdminReply ? '' : (item?.user?.avatar ?? item?.user_avatar ?? '')
  const children = (item?.replies || item?.children || []).map(normalizeCommentItem)

  return {
    ...item,
    likes,
    is_liked: isLiked,
    created_at: createdAt,
    user_nickname: userNickname,
    user_avatar: userAvatar,
    is_admin_reply: isAdminReply,
    children
  }
}

const submitForm = async () => {
  const content = form.content.trim()

  if (!content) {
    toastError('请输入反馈内容')
    return
  }

  if (!isLoggedIn.value) {
    uiStore.openLoginModal()
    return
  }

  submitting.value = true
  try {
    if (isBugFeedback.value) {
      packagingLogs.value = true
      await buildAndUploadLogAttachment()
    }

    await createFeedback({
      content,
      author: userStore.displayName,
      attachmentIds: form.attachments.map((item) => item.id)
    })
    toastSuccess(isBugFeedback.value ? '提交成功，日志已随反馈上传！' : '提交成功，感谢您的建议！')
    // 埋点：提交反馈
    window.ztools?.analytics?.report('feedback_create', '', {
      length: content.length,
      type: feedbackType.value,
      hasLogAttachment: Boolean(logAttachment.value)
    })
    const shouldReloadManually =
    filters.page === 1 &&
    filters.status === 'all' &&
    filters.onlyMine &&
    filters.sort === 'created_at'
    form.content = ''
    form.attachments = []
    feedbackType.value = FEEDBACK_TYPE_FEATURE
    filters.page = 1
    filters.status = 'all'
    filters.onlyMine = true
    filters.sort = 'created_at'
    if (shouldReloadManually) {
      loadRequests()
    }
  } catch (err) {
    toastError(err.message || '提交失败')
  } finally {
    packagingLogs.value = false
    submitting.value = false
  }
}

const changePage = (p) => {
  if (p < 1 || p > totalPages.value) return
  filters.page = p
  loadRequests()
  const container = document.querySelector('main')
  if (container) container.scrollTo({ top: 0, behavior: 'smooth' })
}

const getFeedbackContent = (req) => {
  return req.content || req.description || req.title || ''
}

// 将树形回复展平成单层数组；给每条补上 replyTo 字段（回复的目标用户名）
// 目标：根反馈提交者（parent_id === rootId 或顶层节点）视为回复楼主
// 其他节点的 replyTo 为其父节点的 user_nickname
const flattenReplies = (nodes, rootAuthor, parentMap = new Map()) => {
  const list = []
  for (const node of nodes) {
    const parentUser = parentMap.get(Number(node.parent_id ?? node.parentId))
    // 如果父节点不在 map 里说明是直接回复根反馈，目标是楼主
    node.reply_to = parentUser || rootAuthor
    list.push(node)
    // 登记自己供后代引用
    parentMap.set(Number(node.id), node.user_nickname)
    if (node.children && node.children.length) {
      list.push(...flattenReplies(node.children, rootAuthor, parentMap))
    }
    // 展平后不需要再通过 children 渲染，清空避免模板误用
    node.children = []
  }
  return list
}

const loadComments = async (id) => {
  if (commentsByRequest[id] || commentsLoadingByRequest[id]) {
    return
  }

  commentsLoadingByRequest[id] = true
  try {
    // 新接口返回树形回复（根节点的直接子节点数组，每个子节点带 replies[]）
    const replies = await getFeedbackReplies(id)
    const normalized = replies.map(normalizeCommentItem)
    // 根反馈楼主作为首层回复的默认目标
    const req = requests.value.find((r) => r.id === id)
    const rootAuthor = req?.user_nickname || req?.author || '楼主'
    commentsByRequest[id] = flattenReplies(normalized, rootAuthor)
  } catch (err) {
    commentsByRequest[id] = []
    toastError(err.message || '加载回复失败')
  } finally {
    commentsLoadingByRequest[id] = false
  }
}

const toggleExpanded = (req) => {
  const id = req.id
  const next = new Set(expandedIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
    loadComments(id)
    if (getFeedbackHasUnread(req)) {
      markRequestRepliesReadLocal(id)
      feedbackUnreadStore.markRead(id)
    }
  }
  expandedIds.value = next
}

const isExpanded = (id) => expandedIds.value.has(id)

const getComments = (id) => commentsByRequest[id] || []

const getSpeechLikeKey = (comment) => `comment-${comment.id}`

// 递归查找树中指定回复节点并就地更新
const updateCommentInTree = (nodes, id, patch) => {
  if (!Array.isArray(nodes)) return false
  for (const node of nodes) {
    if (Number(node.id) === Number(id)) {
      Object.assign(node, patch)
      return true
    }
    if (node.children && node.children.length && updateCommentInTree(node.children, id, patch)) {
      return true
    }
  }
  return false
}

const getCommentLiked = (comment) => {
  return speechLikeState[getSpeechLikeKey(comment)]?.liked ?? Boolean(comment.is_liked)
}

const getCommentLikes = (comment) => {
  return speechLikeState[getSpeechLikeKey(comment)]?.count ?? Number(comment.likes || 0)
}

// 点赞/取消点赞回复：调用后端接口，失败回滚；rootId 为主反馈 ID
const handleCommentLike = async (comment, rootId) => {
  if (!isLoggedIn.value) {
    uiStore.openLoginModal()
    return
  }

  const key = getSpeechLikeKey(comment)
  const wasLiked = getCommentLiked(comment)
  const baseCount = getCommentLikes(comment)
  // 乐观更新本地状态
  const nextLiked = !wasLiked
  const nextCount = Math.max(0, baseCount + (nextLiked ? 1 : -1))
  speechLikeState[key] = { liked: nextLiked, count: nextCount }

  try {
    const res = nextLiked
      ? await likeFeedbackReply(rootId, comment.id)
      : await unlikeFeedbackReply(rootId, comment.id)
    // 后端返回最新节点，用其 likesCount/hasLiked 覆盖本地状态
    const likes = Number(res?.likesCount ?? res?.likes_count ?? nextCount)
    const liked = Boolean(res?.hasLiked ?? res?.has_liked ?? nextLiked)
    speechLikeState[key] = { liked, count: likes }
    // 同步更新树中节点，避免重新加载丢状态
    const tree = commentsByRequest[rootId]
    if (tree) {
      updateCommentInTree(tree, comment.id, { likes, is_liked: liked })
    }
  } catch (err) {
    // 回滚
    speechLikeState[key] = { liked: wasLiked, count: baseCount }
    if (err.status === 401 || err.message?.includes('登录')) {
      uiStore.openLoginModal()
    } else {
      toastError(err.message || '操作失败')
    }
  }
}

// 互斥的回复输入框：同一时刻只能有一个打开
// replyTarget = null 表示没有打开；{ rootId, parentId } 表示正在回复某个节点
// 对根反馈回复时 parentId 等于 rootId
const replyTarget = ref(null)
const replyContent = ref('')
const replySubmitting = ref(false)

const isReplyOpen = (rootId, parentId) => {
  return (
    replyTarget.value &&
    replyTarget.value.rootId === rootId &&
    replyTarget.value.parentId === parentId
  )
}

const openReply = (rootId, parentId) => {
  if (!isLoggedIn.value) {
    uiStore.openLoginModal()
    return
  }
  replyTarget.value = { rootId, parentId }
  replyContent.value = ''
}

const cancelReply = () => {
  replyTarget.value = null
  replyContent.value = ''
}

const submitReply = async () => {
  const target = replyTarget.value
  const content = replyContent.value.trim()
  if (!target) return
  if (!content) {
    toastError('请输入回复内容')
    return
  }
  if (!isLoggedIn.value) {
    uiStore.openLoginModal()
    return
  }

  replySubmitting.value = true
  try {
    await addFeedbackReply(target.rootId, {
      content,
      parentId: target.parentId === target.rootId ? undefined : target.parentId
    })
    toastSuccess('回复成功')
    cancelReply()
    // 重新拉取该反馈的回复树
    delete commentsByRequest[target.rootId]
    await loadComments(target.rootId)
    // 根反馈 replies_count 本地 +1
    const req = requests.value.find((r) => r.id === target.rootId)
    if (req) {
      req.replies_count = Number(req.replies_count || 0) + 1
    }
  } catch (err) {
    if (err.status === 401 || err.message?.includes('登录')) {
      uiStore.openLoginModal()
    } else {
      toastError(err.message || '回复失败')
    }
  } finally {
    replySubmitting.value = false
  }
}

/** 用户名截断，超过 8 个字符显示省略号 */
const truncateName = (name) => {
  if (!name) return '匿名'
  return name.length > 8 ? name.slice(0, 8) + '…' : name
}

const formatDate = (dateStr) => {
  if (!dateStr) return ''
  // 兼容 ISO 格式，精确到分钟：2026-03-25 03:27
  return dateStr.substring(0, 16).replace('T', ' ')
}

const getStatusText = (status) => {
  const map = {
    pending: '待审核',
    approved: '已通过',
    developing: '开发中',
    completed: '已完成',
    rejected: '已拒绝'
  }
  return map[status] || status
}

// Watchers
watch(
  () => [filters.status, filters.sort, filters.onlyMine],
  () => {
    filters.page = 1
    loadRequests()
  }
)
watch(
  isLoggedIn,
  (loggedIn) => {
    if (loggedIn) {
      feedbackUnreadStore.refresh()
    } else {
      feedbackUnreadStore.clear()
    }

    if (!loggedIn && filters.onlyMine) {
      filters.onlyMine = false
    }
  }
)

onMounted(() => {
  loadRequests()
  if (isLoggedIn.value) {
    feedbackUnreadStore.refresh()
  }
})
</script>

<template>
  <div class="wish-wall-page">
    <div class="wish-container">
      <!-- 页面标题 -->
      <div class="page-header">
        <div class="header-content">
          <div class="header-icon">
            <i class="fa fa-comments"></i>
          </div>
          <div class="header-text">
            <h1 class="page-title">反馈建议</h1>
            <p class="page-subtitle">分享您的想法和建议，帮助 ZTools 变得更好</p>
          </div>
        </div>
        <a href="javascript:void(0)" class="qrcode-btn" @click="handleOpenQrcode">
          <i class="fa fa-qrcode"></i>
          <span>扫码加入用户群</span>
        </a>
      </div>

      <!-- 提交反馈 -->
      <div class="inline-submit-panel">
        <div class="submit-input-stack">
          <div class="feedback-type-row">
            <button
              type="button"
              class="feedback-type-btn"
              :class="{ active: feedbackType === FEEDBACK_TYPE_FEATURE }"
              @click="feedbackType = FEEDBACK_TYPE_FEATURE"
            >
              功能建议
            </button>
            <button
              type="button"
              class="feedback-type-btn"
              :class="{ active: feedbackType === FEEDBACK_TYPE_BUG }"
              @click="feedbackType = FEEDBACK_TYPE_BUG"
            >
              Bug反馈
            </button>
          </div>
          <div v-if="isBugFeedback" class="bug-log-tip">
            <i class="fa fa-info-circle"></i>
            <span>选择 Bug反馈 后，将自动打包反馈当天的相关日志作为附件上传，帮助我们更快定位问题。</span>
          </div>
          <textarea
            v-model="form.content"
            class="feedback-editor"
            rows="3"
            maxlength="5000"
            placeholder="请输入反馈内容..."
          ></textarea>
          <div class="attachment-toolbar">
            <button
              type="button"
              class="attachment-upload-btn"
              :disabled="uploadingAttachment || userAttachmentCount >= 6"
              @click="triggerAttachmentSelect"
            >
              <i v-if="uploadingAttachment" class="fa fa-spinner fa-spin"></i>
              <i v-else class="fa fa-paperclip"></i>
              <span>{{ uploadingAttachment ? '上传中' : '添加附件' }}</span>
            </button>
            <span class="attachment-hint">支持图片和视频</span>
            <span v-if="isBugFeedback" class="log-attachment-chip">
              <i
                :class="packagingLogs ? 'fa fa-spinner fa-spin' : (logAttachment ? 'fa fa-check-circle' : 'fa fa-file-archive-o')"
              ></i>
              <span class="log-attachment-title">日志附件</span>
              <span class="log-attachment-desc">
                {{ packagingLogs ? '正在打包本机运行日志' : (logAttachment ? '已自动打包本机运行日志' : '提交时自动打包') }}
              </span>
            </span>
            <button
              class="inline-submit-btn"
              @click="submitForm"
              :disabled="submitting || uploadingAttachment || packagingLogs || !form.content.trim()"
            >
              <i v-if="submitting || packagingLogs" class="fa fa-spinner fa-spin"></i>
              <i v-else class="fa fa-paper-plane-o"></i>
              <span>提交</span>
            </button>
            <input
              ref="attachmentInput"
              class="attachment-input"
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
              @change="handleAttachmentChange"
            />
          </div>
          <div v-if="form.attachments.length > 0" class="attachment-list">
            <div
              v-for="attachment in form.attachments"
              :key="attachment.id"
              class="attachment-chip"
              :class="{ 'attachment-chip-log': attachment.type === 'log' || attachment.isAutoLog }"
              :title="getAttachmentFileName(attachment)"
            >
              <i :class="attachment.type === 'log' || attachment.isAutoLog ? 'fa fa-file-archive-o' : (attachment.type === 'video' ? 'fa fa-file-video-o' : 'fa fa-file-image-o')"></i>
              <span class="attachment-name">{{ getAttachmentFileName(attachment) }}</span>
              <span class="attachment-size">{{ formatAttachmentSize(attachment.fileSize || attachment.file_size) }}</span>
              <button
                v-if="attachment.type !== 'log' && !attachment.isAutoLog"
                type="button"
                class="attachment-remove"
                @click="removeAttachment(attachment.id)"
              >
                <i class="fa fa-times"></i>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 筛选栏 -->
      <div class="filter-bar">
        <div class="status-control">
          <span class="filter-label">状态</span>
          <span class="status-select-wrap">
            <a-select
              v-model:value="statusFilterValue"
              size="small"
              class="status-select"
            >
              <a-select-option
                v-for="option in statusOptions"
                :key="option.value"
                :value="option.value"
              >
                <span class="status-option-label">
                  {{ option.label }}
                  <span
                    v-if="option.value === 'mine' && feedbackUnreadStore.hasUnreadReplies"
                    class="feedback-new-badge"
                  >新</span>
                </span>
              </a-select-option>
            </a-select>
            <span
              v-if="feedbackUnreadStore.hasUnreadReplies"
              class="status-select-new-badge"
            >新</span>
          </span>
        </div>

        <div class="sort-control">
          <span class="filter-label">排序</span>
          <a-select
            v-model:value="filters.sort"
            size="small"
            style="min-width: 110px"
          >
            <a-select-option value="likes">
              <i class="fa fa-thumbs-up"></i> 按点赞数
            </a-select-option>
            <a-select-option value="created_at">
              <i class="fa fa-clock-o"></i> 最新发布
            </a-select-option>
            <a-select-option value="replies">
              <i class="fa fa-comments-o"></i> 回复最多
            </a-select-option>
          </a-select>
        </div>
      </div>

      <!-- 反馈列表 -->
      <div class="wish-list">
        <!-- 加载状态 -->
        <div v-if="loading" class="loading-state">
          <div class="loading-spinner">
            <i class="fa fa-spinner fa-spin"></i>
          </div>
          <p>加载中...</p>
        </div>

        <!-- 空状态 -->
        <div v-else-if="requests.length === 0" class="empty-state">
          <div class="empty-icon">
            <i class="fa fa-inbox"></i>
          </div>
          <h3>暂无相关反馈</h3>
          <p>换个分类看看，或者提交一个新的反馈</p>
        </div>

        <!-- 反馈行 -->
        <div v-else class="feedback-table">
          <div
            v-for="req in requests"
            :key="req.id"
            class="feedback-item"
            :class="{ expanded: isExpanded(req.id) }"
          >
            <div class="feedback-row">
              <a-tooltip :title="getFeedbackContent(req)" placement="topLeft">
                <span class="feedback-content-cell">{{ getFeedbackContent(req) }}</span>
              </a-tooltip>
              <a-tooltip :title="req.user_nickname || req.author || '匿名'" placement="top">
                <span class="feedback-user">{{ truncateName(req.user_nickname || req.author || '匿名') }}</span>
              </a-tooltip>
              <span class="feedback-date">{{ formatDate(req.created_at || req.createTime) }}</span>
              <span class="feedback-status-cell">
                <span class="status-badge" :class="`status-${req.status}`">
                  {{ getStatusText(req.status) }}
                </span>
              </span>
              <span
                class="reply-count-cell"
                :class="{ unread: getFeedbackHasUnread(req) }"
                title="回复数"
              >
                <span v-if="getFeedbackHasUnread(req)" class="feedback-row-new-badge">新</span>
                <i class="fa fa-comments-o"></i>
                <span>{{ req.replies_count || 0 }}</span>
              </span>
              <button
                @click="handleVote(req.id)"
                class="vote-btn"
                :class="{ voted: req.is_voted }"
                :title="req.is_voted ? '已点赞' : '点赞'"
              >
                <i :class="req.is_voted ? 'fa fa-heart' : 'fa fa-heart-o'"></i>
                <span class="vote-count">{{ req.votes || 0 }}</span>
              </button>
              <button
                class="expand-btn"
                :class="{ expanded: isExpanded(req.id) }"
                @click="toggleExpanded(req)"
                :title="isExpanded(req.id) ? '收起' : '展开'"
              >
                <i class="fa fa-chevron-down"></i>
              </button>
            </div>
            <div v-if="isExpanded(req.id)" class="feedback-detail">
              <div class="speech-thread">
                <div class="speech-item main-speech">
                  <div class="speech-avatar">
                    <img
                      v-if="req.user_avatar || req.avatar"
                      :src="req.user_avatar || req.avatar"
                      :alt="req.user_nickname || req.author || '用户'"
                      @error="(e) => e.target.style.display = 'none'"
                    />
                    <i v-else class="fa fa-user"></i>
                  </div>
                  <div class="speech-body">
                    <div class="speech-head">
                      <span class="speech-user">{{ truncateName(req.user_nickname || req.author || '匿名') }}</span>
                      <span class="speech-time">{{ formatDate(req.created_at || req.createTime) }}</span>
                    </div>
                    <p class="speech-content">{{ getFeedbackContent(req) }}</p>
                    <div v-if="req.attachments && req.attachments.length" class="speech-attachments">
                      <span
                        v-for="attachment in req.attachments"
                        :key="attachment.id"
                        class="speech-attachment-name"
                        :title="getAttachmentFileName(attachment)"
                      >
                        <i :class="attachment.type === 'log' ? 'fa fa-file-archive-o' : (attachment.type === 'video' ? 'fa fa-file-video-o' : 'fa fa-file-image-o')"></i>
                        {{ getAttachmentFileName(attachment) }}
                      </span>
                    </div>
                    <div class="speech-actions">
                      <button
                        class="speech-like-btn"
                        :class="{ liked: req.is_voted }"
                        @click="handleVote(req.id)"
                        :title="req.is_voted ? '已点赞' : '点赞'"
                      >
                        <i :class="req.is_voted ? 'fa fa-heart' : 'fa fa-heart-o'"></i>
                        <span>{{ req.votes || 0 }}</span>
                      </button>
                      <button
                        class="speech-reply-btn"
                        :class="{ active: isReplyOpen(req.id, req.id) }"
                        @click="isReplyOpen(req.id, req.id) ? cancelReply() : openReply(req.id, req.id)"
                      >
                        <i class="fa fa-reply"></i>
                        <span>回复</span>
                      </button>
                    </div>
                    <div v-if="isReplyOpen(req.id, req.id)" class="reply-editor">
                      <textarea
                        v-model="replyContent"
                        class="reply-input"
                        rows="2"
                        maxlength="1000"
                        :placeholder="`回复 @${truncateName(req.user_nickname || req.author || '匿名')}`"
                      ></textarea>
                      <div class="reply-editor-actions">
                        <button class="reply-cancel-btn" type="button" @click="cancelReply">取消</button>
                        <button
                          class="reply-submit-btn"
                          type="button"
                          :disabled="replySubmitting || !replyContent.trim()"
                          @click="submitReply"
                        >
                          <i v-if="replySubmitting" class="fa fa-spinner fa-spin"></i>
                          <span>发送</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div v-if="commentsLoadingByRequest[req.id]" class="reply-loading">
                  <i class="fa fa-spinner fa-spin"></i>
                  <span>加载回复中...</span>
                </div>

                <div v-else-if="getComments(req.id).length === 0" class="reply-empty">
                  暂无回复
                </div>

                <div v-else class="reply-list">
                  <div
                    v-for="comment in getComments(req.id)"
                    :key="comment.id"
                    class="speech-item reply-speech"
                    :class="{ 'admin-reply': comment.is_admin_reply }"
                  >
                    <div class="speech-avatar">
                      <img
                        v-if="comment.user_avatar"
                        :src="comment.user_avatar"
                        :alt="comment.user_nickname || '用户'"
                        @error="(e) => e.target.style.display = 'none'"
                      />
                      <i v-else :class="comment.is_admin_reply ? 'fa fa-shield' : 'fa fa-user'"></i>
                    </div>
                    <div class="speech-body">
                      <div class="speech-head">
                        <span class="speech-user" :class="{ 'admin-name': comment.is_admin_reply }">
                          {{ truncateName(comment.user_nickname || '用户') }}
                        </span>
                        <span v-if="comment.is_admin_reply" class="admin-badge">
                          <i class="fa fa-shield"></i> 官方
                        </span>
                        <template v-if="comment.reply_to">
                          <span class="reply-to-hint">回复</span>
                          <span class="reply-to-user">@{{ truncateName(comment.reply_to) }}</span>
                        </template>
                        <span class="speech-time">{{ formatDate(comment.created_at) }}</span>
                      </div>
                      <p class="speech-content">{{ comment.content }}</p>
                      <div class="speech-actions">
                        <button
                          class="speech-like-btn"
                          :class="{ liked: getCommentLiked(comment) }"
                          @click="handleCommentLike(comment, req.id)"
                          :title="getCommentLiked(comment) ? '已点赞' : '点赞'"
                        >
                          <i :class="getCommentLiked(comment) ? 'fa fa-heart' : 'fa fa-heart-o'"></i>
                          <span>{{ getCommentLikes(comment) }}</span>
                        </button>
                        <button
                          class="speech-reply-btn"
                          :class="{ active: isReplyOpen(req.id, comment.id) }"
                          @click="isReplyOpen(req.id, comment.id) ? cancelReply() : openReply(req.id, comment.id)"
                        >
                          <i class="fa fa-reply"></i>
                          <span>回复</span>
                        </button>
                      </div>
                      <div v-if="isReplyOpen(req.id, comment.id)" class="reply-editor">
                        <textarea
                          v-model="replyContent"
                          class="reply-input"
                          rows="2"
                          maxlength="1000"
                          :placeholder="`回复 @${truncateName(comment.user_nickname || '用户')}`"
                        ></textarea>
                        <div class="reply-editor-actions">
                          <button class="reply-cancel-btn" type="button" @click="cancelReply">取消</button>
                          <button
                            class="reply-submit-btn"
                            type="button"
                            :disabled="replySubmitting || !replyContent.trim()"
                            @click="submitReply"
                          >
                            <i v-if="replySubmitting" class="fa fa-spinner fa-spin"></i>
                            <span>发送</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 分页 -->
      <div v-if="total > 0" class="pagination">
        <button
          @click="changePage(filters.page - 1)"
          :disabled="filters.page <= 1"
          class="page-btn"
        >
          <i class="fa fa-chevron-left"></i>
        </button>
        <span class="page-info">
          <span class="current">{{ filters.page }}</span>
          <span class="divider">/</span>
          <span class="total">{{ totalPages }}</span>
          <span class="total-count">共 {{ total }} 条</span>
        </span>
        <button
          @click="changePage(filters.page + 1)"
          :disabled="filters.page >= totalPages"
          class="page-btn"
        >
          <i class="fa fa-chevron-right"></i>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wish-wall-page {
  min-height: calc(100vh - 12rem);
  padding: 16px;
}

.wish-container {
  max-width: 960px;
  margin: 0 auto;
}

/* 页面标题 */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.header-content {
  display: flex;
  align-items: center;
  gap: 16px;
}

.header-icon {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: var(--rc-h-olive-bg);
  box-shadow: inset 0 0 0 1px var(--rc-h-line);
  display: flex;
  align-items: center;
  justify-content: center;
}

.header-icon i {
  font-size: 24px;
  color: var(--rc-h-olive-fg);
}

.page-title {
  font-size: 24px;
  font-weight: 700;
  color: var(--zt-text);
  margin: 0;
}

.page-subtitle {
  font-size: 14px;
  color: var(--zt-text-secondary);
  margin: 4px 0 0;
}

.qrcode-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 10px;
  border: 1px solid #07c160;
  background: rgba(7, 193, 96, 0.08);
  color: #07c160;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  text-decoration: none;
  transition: all 0.2s ease;
}

.qrcode-btn:hover {
  border-color: #07c160;
  color: #fff;
  background: #07c160;
  transform: translateY(-1px);
}

/* 筛选栏 */
.filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--color-surface);
  border-radius: 8px;
  border: 1px solid var(--color-border);
  margin-bottom: 12px;
  gap: 16px;
  flex-wrap: wrap;
}

.sort-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sort-label {
  font-size: 12px;
  color: var(--zt-text-secondary);
}

/* 反馈列表 */
.wish-list {
  min-height: 400px;
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 16px;
  text-align: center;
}

.loading-spinner {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  background: var(--color-background-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}

.loading-spinner i {
  font-size: 24px;
  color: var(--zt-primary);
}

.loading-state p {
  font-size: 14px;
  color: var(--zt-text-secondary);
}

.empty-icon {
  width: 80px;
  height: 80px;
  border-radius: 20px;
  background: linear-gradient(
    135deg,
    var(--rc-accent-subtle) 0%,
    var(--rc-h-slate-bg) 100%
  );
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
}

.empty-icon i {
  font-size: 32px;
  color: var(--zt-text-secondary);
  opacity: 0.5;
}

.empty-state h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--zt-text);
  margin: 0 0 8px;
}

.empty-state p {
  font-size: 13px;
  color: var(--zt-text-secondary);
}

.status-badge {
  padding: 4px 10px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.status-pending {
  background: var(--rc-kbd-bg);
  color: var(--rc-text-muted);
}

.status-approved {
  background: var(--rc-h-slate-bg);
  color: var(--rc-h-slate-fg);
}

.status-developing {
  background: var(--rc-warning-subtle);
  color: var(--rc-warning);
}

.status-completed {
  background: var(--rc-success-subtle);
  color: var(--rc-success);
}

.status-rejected {
  background: var(--rc-h-clay-bg);
  color: var(--rc-h-clay-fg);
}

.tag {
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  background: var(--color-background-secondary);
  color: var(--zt-text-secondary);
  border: 1px solid var(--color-border);
}

.vote-count {
  font-weight: 700;
}

.inline-submit-panel {
  margin-bottom: 12px;
}

.submit-input-stack {
  min-width: 0;
}

.feedback-type-row {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px;
  margin-bottom: 8px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
}

.feedback-type-btn {
  height: 28px;
  min-width: 86px;
  padding: 0 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--zt-text-secondary);
  font-size: 13px;
  cursor: pointer;
}

.feedback-type-btn.active {
  background: var(--rc-surface);
  color: var(--rc-text-primary);
  font-weight: 600;
  box-shadow: var(--rc-shadow-sm);
}

.bug-log-tip {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  padding: 6px 10px;
  margin-bottom: 8px;
  border-radius: 8px;
  border: 1px solid var(--rc-border-highlight);
  background: var(--rc-accent-subtle);
  color: var(--rc-accent-text);
  font-size: 12px;
  line-height: 1.4;
}

.feedback-editor {
  width: 100%;
  min-height: 70px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--zt-text);
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
  box-sizing: border-box;
}

.feedback-editor:focus {
  border-color: var(--zt-primary);
  box-shadow: var(--rc-shadow-md);
}

.inline-submit-btn {
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 88px;
  padding: 0 16px;
  border-radius: 8px;
  border: none;
  background: var(--zt-primary);
  color: var(--rc-accent-contrast);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.inline-submit-btn:hover:not(:disabled) {
  background: var(--rc-accent);
  transform: translateY(-1px);
}

.inline-submit-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.attachment-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-height: 30px;
  margin-top: 6px;
}

.attachment-toolbar .inline-submit-btn {
  margin-left: auto;
}

.attachment-input {
  display: none;
}

.attachment-upload-btn {
  height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--zt-text);
  font-size: 12px;
  cursor: pointer;
}

.attachment-upload-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.attachment-hint {
  color: var(--zt-text-secondary);
  font-size: 12px;
}

.log-attachment-chip {
  max-width: 320px;
  min-width: 0;
  height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--rc-border-highlight);
  background: var(--rc-success-subtle);
  color: var(--rc-success);
  font-size: 12px;
}

.log-attachment-title {
  font-weight: 600;
  white-space: nowrap;
}

.log-attachment-desc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rc-success);
}

.attachment-list,
.speech-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.attachment-chip,
.speech-attachment-name {
  max-width: 260px;
  min-width: 0;
  height: 26px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border-radius: 6px;
  background: var(--color-background-secondary);
  color: var(--zt-text-secondary);
  border: 1px solid var(--color-border);
  font-size: 12px;
}

.attachment-chip-log {
  border-color: var(--rc-border-highlight);
  background: var(--rc-success-subtle);
  color: var(--rc-success);
}

.attachment-name,
.speech-attachment-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-size {
  flex-shrink: 0;
  color: var(--zt-text-tertiary, var(--rc-text-muted));
}

.attachment-remove {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  color: var(--zt-text-secondary);
  background: transparent;
  cursor: pointer;
}

.attachment-remove:hover {
  color: var(--rc-error);
  background: var(--rc-error-subtle);
}

.status-control,
.sort-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-label {
  font-size: 12px;
  color: var(--zt-text-secondary);
  white-space: nowrap;
}

.status-select {
  min-width: 120px;
}

.status-select-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.status-select-new-badge {
  position: absolute;
  top: -8px;
  right: -14px;
  min-width: 18px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--rc-error);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  pointer-events: none;
}

.feedback-table {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--color-surface);
}

.feedback-item + .feedback-item {
  border-top: 1px solid var(--color-border);
}

.feedback-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(72px, 108px) 116px 68px 64px 72px 30px;
  gap: 8px;
  align-items: center;
  min-height: 44px;
  padding: 0 10px;
}

.feedback-item.expanded .feedback-row,
.feedback-row:hover {
  background: var(--color-hover);
}

.feedback-content-cell,
.feedback-user,
.feedback-date {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feedback-content-cell {
  display: block;
  width: min(100%, 560px);
  max-width: 560px;
  color: var(--zt-text);
  font-size: 13px;
  font-weight: 500;
}

.feedback-user {
  display: block;
  max-width: 108px;
  color: var(--zt-text-secondary);
  font-size: 12px;
}

.feedback-date {
  color: var(--zt-text-secondary);
  font-size: 12px;
}

.feedback-status-cell {
  min-width: 0;
}

.feedback-status-cell .status-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  max-width: 72px;
  padding: 2px 8px;
  border-radius: 999px;
  letter-spacing: 0;
  text-transform: none;
  white-space: nowrap;
}

.vote-btn {
  width: 72px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-background-secondary);
  color: var(--zt-text-secondary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.reply-count-cell {
  position: relative;
  width: 64px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-background-secondary);
  color: var(--zt-text-secondary);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.reply-count-cell.unread {
  border-color: var(--rc-border-highlight);
  background: var(--rc-error-subtle);
  color: var(--rc-error);
}

.status-option-label {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.feedback-new-badge,
.feedback-row-new-badge {
  min-width: 18px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--rc-error);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  flex-shrink: 0;
}

.feedback-row-new-badge {
  position: absolute;
  top: -7px;
  right: -8px;
}

.reply-count-cell i {
  font-size: 13px;
}

.vote-btn:hover {
  border-color: var(--rc-h-clay-fg);
  background: var(--rc-h-clay-bg);
  color: var(--rc-h-clay-fg);
  transform: none;
}

.vote-btn.voted {
  border-color: var(--rc-h-clay-fg);
  background: var(--rc-h-clay-bg);
  color: var(--rc-h-clay-fg);
  box-shadow: none;
}

.vote-btn.voted:hover {
  transform: none;
}

.expand-btn {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--zt-text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.expand-btn:hover {
  border-color: var(--color-border);
  background: var(--color-background-secondary);
  color: var(--zt-text);
}

.expand-btn i {
  transition: transform 0.2s ease;
}

.expand-btn.expanded i {
  transform: rotate(180deg);
}

.feedback-detail {
  padding: 14px;
  border-top: 1px dashed var(--color-border);
  background: var(--color-background-secondary);
}

.speech-thread,
.reply-list,
.speech-children {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.speech-item {
  display: flex;
  gap: 10px;
  min-width: 0;
}

.reply-list {
  margin-left: 18px;
  padding-left: 18px;
  border-left: 1px solid var(--color-border);
}

.speech-children {
  margin-top: 12px;
  padding: 12px;
  border-radius: 8px;
  background: var(--color-surface);
}

/* 官方（管理员）回复的差异化样式 */
.speech-item.admin-reply {
  position: relative;
  padding: 10px 12px;
  border-radius: 10px;
  background: linear-gradient(
    135deg,
    var(--rc-accent-subtle) 0%,
    var(--rc-h-slate-bg) 100%
  );
  border: 1px solid var(--rc-border-highlight);
}

.speech-item.admin-reply .speech-avatar {
  background: var(--rc-accent);
  color: var(--rc-accent-contrast);
}

.speech-user.admin-name {
  color: var(--rc-accent-text);
  font-weight: 600;
}

.admin-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 600;
  color: var(--rc-accent-contrast);
  background: var(--rc-accent);
  white-space: nowrap;
}

.admin-badge i {
  font-size: 9px;
}

.speech-avatar {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 50%;
  background: var(--color-surface);
  color: var(--zt-text-secondary);
}

.speech-avatar.small {
  width: 26px;
  height: 26px;
  flex-basis: 26px;
}

.speech-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.speech-body {
  position: relative;
  flex: 1;
  min-width: 0;
  padding-right: 64px;
}

.speech-head {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  margin-bottom: 4px;
}

.speech-user {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 用户名高亮，和 reply-to-user 视觉一致 */
  color: var(--zt-primary);
  font-size: 13px;
  font-weight: 600;
  max-width: 180px;
}

.speech-time {
  flex-shrink: 0;
  color: var(--zt-text-secondary);
  font-size: 12px;
}

/* "回复 @xxx" 关系文案 */
.reply-to-hint {
  flex-shrink: 0;
  color: var(--zt-text-secondary);
  font-size: 12px;
}

.reply-to-user {
  flex-shrink: 0;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--zt-primary);
  font-size: 12px;
  font-weight: 500;
}

.speech-content {
  margin: 0;
  color: var(--zt-text);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.speech-actions {
  position: absolute;
  top: -2px;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  margin-top: 0;
}

.speech-like-btn {
  height: 26px;
  min-width: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--zt-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.speech-like-btn:hover {
  border-color: var(--rc-h-clay-fg);
  background: var(--rc-h-clay-bg);
  color: var(--rc-h-clay-fg);
}

.speech-like-btn.liked {
  color: var(--rc-h-clay-fg);
}

/* 回复按钮 */
.speech-reply-btn {
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--zt-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.speech-reply-btn:hover,
.speech-reply-btn.active {
  border-color: var(--zt-primary);
  background: var(--rc-accent-subtle);
  color: var(--zt-primary);
}

/* 内联回复编辑器 */
.reply-editor {
  margin-top: 8px;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
}

.reply-input {
  width: 100%;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-background-secondary);
  color: var(--zt-text);
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
  box-sizing: border-box;
}

.reply-input:focus {
  border-color: var(--zt-primary);
}

.reply-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}

.reply-cancel-btn,
.reply-submit-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.reply-cancel-btn {
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--zt-text-secondary);
}

.reply-cancel-btn:hover {
  border-color: var(--zt-text-secondary);
  color: var(--zt-text);
}

.reply-submit-btn {
  border: none;
  background: var(--zt-primary);
  color: var(--rc-accent-contrast);
}

.reply-submit-btn:hover:not(:disabled) {
  background: var(--rc-accent);
}

.reply-submit-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.reply-loading,
.reply-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: 42px;
  color: var(--zt-text-secondary);
  font-size: 12px;
}

/* 分页 */
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding-top: 16px;
}

.page-btn {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--zt-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.page-btn:hover:not(:disabled) {
  background: var(--zt-primary);
  color: white;
  border-color: var(--zt-primary);
  transform: translateY(-2px);
}

.page-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.page-info {
  font-size: 14px;
  color: var(--zt-text-secondary);
}

.page-info .current {
  font-weight: 700;
  color: var(--zt-text);
}

.page-info .divider {
  margin: 0 4px;
}

.page-info .total-count {
  margin-left: 8px;
  font-size: 12px;
  color: var(--zt-text-secondary);
  opacity: 0.7;
}

/* 响应式 */
@media (max-width: 768px) {
  .page-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 20px;
  }

  .filter-bar {
    flex-direction: column;
    align-items: flex-start;
  }
}

@media (max-width: 768px) {
  .inline-submit-panel {
    grid-template-columns: minmax(0, 1fr) 76px;
  }

  .inline-submit-btn {
    min-width: 76px;
  }

  .status-control,
  .sort-control {
    width: 100%;
    justify-content: space-between;
  }

  .status-select {
    min-width: 140px;
  }

  .feedback-row {
    grid-template-columns: minmax(130px, 1fr) minmax(60px, 78px) 86px 56px 54px 58px 28px;
    gap: 6px;
    padding: 0 8px;
  }

  .feedback-content-cell {
    max-width: none;
  }

  .vote-btn {
    width: 58px;
    padding: 0 6px;
  }

  .reply-count-cell {
    width: 54px;
  }

  .feedback-user {
    max-width: 78px;
  }

  .feedback-status-cell .status-badge {
    max-width: 58px;
    padding: 2px 6px;
  }

  .speech-body {
    padding-right: 58px;
  }

  .speech-user {
    max-width: 140px;
  }

  .reply-list {
    margin-left: 8px;
    padding-left: 12px;
  }
}
</style>
