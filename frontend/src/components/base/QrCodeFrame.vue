<script setup>
/**
 * 二维码展示：白色卡片（--rc-qr-surface，深色主题下也保持白底，保证可扫）+ 四角品牌色取景框，一眼看出「扫这里」。
 * 默认插槽放二维码图片；overlay 插槽盖在二维码上方，用于加载中、失败、已扫码等状态。
 */
defineProps({
  size: { type: Number, default: 208 },
  // 状态覆盖层出现时取景框转灰，表示当前不可扫
  dimmed: { type: Boolean, default: false }
})
</script>

<template>
  <div class="qr-scan" :class="{ 'is-dimmed': dimmed }">
    <span class="qr-corner is-tl" aria-hidden="true"></span>
    <span class="qr-corner is-tr" aria-hidden="true"></span>
    <span class="qr-corner is-bl" aria-hidden="true"></span>
    <span class="qr-corner is-br" aria-hidden="true"></span>
    <div class="qr-card" :style="{ width: `${size}px`, height: `${size}px` }">
      <div class="qr-card-content">
        <slot />
      </div>
      <div v-if="$slots.overlay" class="qr-overlay">
        <slot name="overlay" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.qr-scan {
  position: relative;
  padding: 10px;
}

/* 取景框四角：L 形描边 */
.qr-corner {
  position: absolute;
  width: 22px;
  height: 22px;
  border: 0 solid var(--rc-accent);
  transition: border-color 0.2s ease;
}

.qr-corner.is-tl { top: 0; left: 0; border-top-width: 2px; border-left-width: 2px; border-top-left-radius: 10px; }
.qr-corner.is-tr { top: 0; right: 0; border-top-width: 2px; border-right-width: 2px; border-top-right-radius: 10px; }
.qr-corner.is-bl { bottom: 0; left: 0; border-bottom-width: 2px; border-left-width: 2px; border-bottom-left-radius: 10px; }
.qr-corner.is-br { bottom: 0; right: 0; border-bottom-width: 2px; border-right-width: 2px; border-bottom-right-radius: 10px; }

.qr-scan.is-dimmed .qr-corner {
  border-color: var(--rc-border-highlight);
}

.qr-card {
  position: relative;
  padding: 12px;
  box-sizing: border-box;
  border-radius: 12px;
  background: var(--rc-qr-surface);
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.06),
    0 10px 28px -10px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}

.qr-card-content {
  position: relative;
  width: 100%;
  height: 100%;
}

.qr-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 16px;
  text-align: center;
  background: var(--rc-surface);
  color: var(--rc-text-secondary);
  font-size: 13px;
  animation: qr-overlay-in 0.2s ease;
}

@keyframes qr-overlay-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
