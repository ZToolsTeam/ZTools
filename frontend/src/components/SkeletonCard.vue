<template>
  <div
    class="border animate-pulse"
    style="
      border-radius: var(--radius-xl);
      padding: var(--spacing-md);
      background-color: var(--rc-surface);
      border-color: var(--rc-border);
    "
  >
    <div class="flex items-center" style="gap: var(--spacing-md)">
      <div
        class="rounded"
        style="
          width: 48px;
          height: 48px;
          background-color: var(--rc-canvas);
        "
      ></div>
      <div
        class="flex-1"
        style="display: flex; flex-direction: column; gap: var(--spacing-sm)"
      >
        <div
          class="h-4 rounded"
          style="
            width: 50%;
            background-color: var(--rc-canvas);
          "
        ></div>
        <div
          class="h-3 rounded"
          style="
            width: 33%;
            background-color: var(--rc-canvas);
          "
        ></div>
      </div>
    </div>
  </div>
</template>
