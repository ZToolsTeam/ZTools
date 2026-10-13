<script setup>
import { ref, computed, onMounted } from 'vue'

const props = defineProps({
  items: Array,
  itemHeight: { type: Number, default: 80 },
  height: { type: Number, default: 600 }
})

const container = ref(null)
const scrollTop = ref(0)

const totalHeight = computed(
  () => (props.items?.length || 0) * props.itemHeight
)
const visibleCount = computed(
  () => Math.ceil(props.height / props.itemHeight) + 2
)
const start = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / props.itemHeight) - 1)
)
const end = computed(() =>
  Math.min(props.items?.length || 0, start.value + visibleCount.value)
)
const visibleItems = computed(() =>
  (props.items || []).slice(start.value, end.value)
)

const onScroll = () => {
  scrollTop.value = container.value?.scrollTop || 0
}
const itemTop = (index) => {
  return index * props.itemHeight
}

onMounted(() => {
  scrollTop.value = 0
})
</script>

<template>
  <div
    :style="{ height: height + 'px' }"
    class="relative overflow-auto"
    ref="container"
    @scroll="onScroll"
  >
    <div :style="{ height: totalHeight + 'px', position: 'relative' }">
      <div
        :style="{
          top: itemTop(start + i) + 'px'
        }"
        class="absolute left-0 right-0"
        v-for="(item, i) in visibleItems"
        :key="start + i"
      >
        <slot name="item" :item="item" :index="start + i" />
      </div>
    </div>
  </div>
</template>
