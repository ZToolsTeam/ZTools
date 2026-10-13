import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useUpdateStore = defineStore('update', () => {
  // State
  const hasUpdate = ref(false)
  const isMandatory = ref(false)
  const versionInfo = ref({
    version: '',
    changelog: '',
    fileSize: 0,
    downloadUrl: '',
    checksum: ''
  })
  const error = ref(null)

  // Getters
  const isUpdateAvailable = computed(() => hasUpdate.value)
  const shouldShowMandatoryDialog = computed(
    () => hasUpdate.value && isMandatory.value
  )

  // Actions
  function setUpdateInfo(info) {
    hasUpdate.value = info.hasUpdate || false
    isMandatory.value = info.isMandatory || false
    versionInfo.value = info.versionInfo || {
      version: '',
      changelog: '',
      fileSize: 0,
      downloadUrl: '',
      checksum: ''
    }
  }

  function setError(errorMsg) {
    error.value = errorMsg
  }

  function reset() {
    hasUpdate.value = false
    isMandatory.value = false
    error.value = null
    versionInfo.value = {
      version: '',
      changelog: '',
      fileSize: 0,
      downloadUrl: '',
      checksum: ''
    }
  }

  return {
    // State
    hasUpdate,
    isMandatory,
    versionInfo,
    error,
    // Getters
    isUpdateAvailable,
    shouldShowMandatoryDialog,
    // Actions
    setUpdateInfo,
    setError,
    reset
  }
})
