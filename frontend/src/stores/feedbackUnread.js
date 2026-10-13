import { defineStore } from 'pinia'

import {
  getUnreadFeedbackReplies,
  markFeedbackRepliesRead
} from '@/api/feedback'
import { isOnline } from '@/config/runtime-mode'

const READ_MARKERS_KEY = 'feedbackUnreadReadMarkers'

function toTime(value) {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

function loadReadMarkers() {
  try {
    const raw = localStorage.getItem(READ_MARKERS_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    console.warn('[FeedbackUnread] 读取本地已读标记失败:', err)
    return {}
  }
}

function saveReadMarkers(markers) {
  try {
    localStorage.setItem(READ_MARKERS_KEY, JSON.stringify(markers))
  } catch (err) {
    console.warn('[FeedbackUnread] 保存本地已读标记失败:', err)
  }
}

export const useFeedbackUnreadStore = defineStore('feedbackUnread', {
  state: () => ({
    unreadReplyIds: [],
    latestReplyAtById: {},
    readMarkers: loadReadMarkers(),
    loading: false
  }),

  getters: {
    hasUnreadReplies: (state) => state.unreadReplyIds.length > 0,
    hasUnreadFor: (state) => (id) =>
      state.unreadReplyIds.includes(Number(id)),
    isLocallyRead: (state) => (id, latestReplyAt) => {
      const feedbackId = Number(id)
      if (!Number.isInteger(feedbackId) || feedbackId <= 0) {
        return false
      }
      const readAt = toTime(state.readMarkers[feedbackId])
      if (readAt <= 0) {
        return false
      }
      const latestAt =
        toTime(latestReplyAt) ||
        toTime(state.latestReplyAtById[feedbackId])
      return latestAt > 0 && latestAt <= readAt
    }
  },

  actions: {
    applySummary(summary) {
      const items = Array.isArray(summary?.items)
        ? summary.items
        : (Array.isArray(summary?.ids) ? summary.ids : []).map((id) => ({
            id,
            latestReplyAt: null
          }))

      const latestMap = {}
      const ids = []
      for (const item of items) {
        const feedbackId = Number(item?.id)
        if (!Number.isInteger(feedbackId) || feedbackId <= 0) {
          continue
        }

        const latestReplyAt = item?.latestReplyAt || item?.latest_reply_at || null
        if (latestReplyAt) {
          latestMap[feedbackId] = latestReplyAt
        }
        if (!this.isLocallyRead(feedbackId, latestReplyAt)) {
          ids.push(feedbackId)
        }
      }

      this.latestReplyAtById = latestMap
      this.unreadReplyIds = ids
    },

    removeLocal(id) {
      const feedbackId = Number(id)
      if (!Number.isInteger(feedbackId) || feedbackId <= 0) {
        return
      }

      this.unreadReplyIds = this.unreadReplyIds.filter(
        (item) => item !== feedbackId
      )
    },

    markLocalRead(id, latestReplyAt) {
      const feedbackId = Number(id)
      if (!Number.isInteger(feedbackId) || feedbackId <= 0) {
        return
      }

      const latestAt =
        latestReplyAt ||
        this.latestReplyAtById[feedbackId] ||
        new Date().toISOString()
      this.readMarkers = {
        ...this.readMarkers,
        [feedbackId]: latestAt
      }
      saveReadMarkers(this.readMarkers)
      this.removeLocal(feedbackId)
    },

    async refresh() {
      if (!isOnline) return
      this.loading = true
      try {
        const summary = await getUnreadFeedbackReplies()
        this.applySummary(summary)
      } catch (err) {
        if (err?.status !== 401) {
          console.warn('[FeedbackUnread] 刷新未读回复失败:', err)
        }
      } finally {
        this.loading = false
      }
    },

    async markRead(id) {
      const feedbackId = Number(id)
      if (!Number.isInteger(feedbackId) || feedbackId <= 0) {
        return
      }

      this.markLocalRead(feedbackId)

      try {
        const summary = await markFeedbackRepliesRead(feedbackId)
        this.applySummary(summary)
        this.removeLocal(feedbackId)
      } catch (err) {
        if (err?.status !== 404 && err?.status !== 401) {
          console.warn('[FeedbackUnread] 标记反馈回复已读失败:', err)
        }
        await this.refresh()
      }
    },

    clear() {
      this.unreadReplyIds = []
    }
  }
})
