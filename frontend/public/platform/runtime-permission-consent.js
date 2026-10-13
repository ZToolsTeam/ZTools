(() => {
  const bridge = window.ztoolsRuntimeCapabilityPrompt
  const root = document.querySelector('[data-testid="runtime-capability-prompt"]')
  const allow = document.querySelector('[data-testid="runtime-capability-allow"]')
  const deny = document.querySelector('[data-testid="runtime-capability-deny"]')
  const name = document.querySelector('[data-testid="runtime-capability-plugin-name"]')
  const id = document.querySelector('[data-testid="runtime-capability-plugin-id"]')
  const purpose = document.querySelector('[data-testid="runtime-capability-purpose"]')
  if (!bridge || !root || !allow || !deny || !name || !id || !purpose) return

  let answered = false
  const unsubscribe = bridge.onRequest(request => {
    name.textContent = request.pluginName
    id.textContent = request.pluginId
    purpose.textContent = request.purpose
  })
  const answer = async allowed => {
    if (answered) return
    answered = true
    allow.disabled = true
    deny.disabled = true
    try {
      await bridge.answer(allowed)
    } catch {
      // Main closes or times out the prompt if its one-shot response is no longer active.
    } finally {
      unsubscribe()
    }
  }
  allow.addEventListener('click', () => { void answer(true) })
  deny.addEventListener('click', () => { void answer(false) })
})()
