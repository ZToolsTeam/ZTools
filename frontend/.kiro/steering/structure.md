# Project Structure

## Root Layout

```
Frontend/
├── .kiro/                    # Kiro AI configuration
├── public/                   # Static assets (not processed by Vite)
│   ├── js/cef-ipc/          # CEF bridge module (builds to ztools-api.js)
│   └── sdk/                 # Plugin SDK files
├── src/                     # Source code
├── scripts/                 # Build and test scripts
├── devtools/                # Development utilities
├── examples/                # Usage examples
└── dist/                    # Build output (deploys to ../bin/WebResources)
```

## Source Directory (`src/`)

```
src/
├── api/                     # API layer (ALWAYS import from apiserver.js)
│   ├── apiserver.js        # ⭐ Unified API exports (use this!)
│   ├── auth.js             # Authentication endpoints
│   ├── plugins.js          # Plugin marketplace endpoints
│   ├── native.js           # CEF Native API wrapper
│   ├── update.js           # Update check endpoints
│   ├── statistics.js       # Analytics endpoints
│   ├── feature-requests.js # Feature request endpoints
│   └── libraries.js        # Dependency library endpoints
├── components/             # Reusable Vue components
├── composables/            # Composition API functions
│   ├── useToast.js        # Toast notification system
│   ├── useAppUpdate.js    # Update management
│   └── useZTools.js       # ZTools API wrapper
├── pages/                  # Route pages
│   ├── __tests__/         # Page tests (unit + property-based)
│   └── details-components/ # Plugin detail subcomponents
├── stores/                 # Pinia state stores
│   ├── plugins.js         # Plugin state
│   ├── user.js            # User/auth state
│   ├── theme.js           # Theme state
│   ├── update.js          # Update state
│   ├── ui.js              # UI state
│   ├── nav.js             # Navigation state
│   └── events.js          # Event monitoring
├── router/                 # Vue Router configuration
├── layouts/                # Layout components
├── assets/css/             # Global styles
├── config/                 # Configuration files
├── App.vue                 # Root component
└── main.js                 # Application entry point
```

## Key Conventions

### Vue Component Structure

Order: `<script setup>` → `<template>` → `<style>`

```vue
<script setup>
// Imports and logic
</script>

<template>
  <!-- Template -->
</template>

<style scoped>
/* Minimal custom styles */
</style>
```

### API Usage Pattern

```javascript
// ✅ ALWAYS import from apiserver.js
import { getMarketPlugins, openPlugin } from '@/api/apiserver'

// ❌ NEVER import from submodules directly
import { getMarketPlugins } from '@/api/plugins'
```

### Styling Priority

1. Ant Design Vue components (preferred)
2. Tailwind utility classes
3. Custom CSS in `<style>` (minimal, only when necessary)

### Test Files

- Unit tests: `*.spec.js`
- Property-based tests: `*.properties.spec.js`
- E2E tests: `*.integration.spec.js`
- Located in `__tests__/` directories

## CEF-IPC Module

`public/js/cef-ipc/` is a standalone module that:

- Builds to `public/sdk/ztools-api.js`
- Provides `window.ztools` API in CEF environment
- Has its own build script (`build.cjs`)
- Auto-rebuilds on file changes during dev

## Special Files

- `vite-plugin-cef-ipc-watch.js`: Custom Vite plugin for CEF-IPC hot reload
- `scripts/generate-version.cjs`: Post-build version file generator
- `scripts/mcp-e2e-test.cjs`: E2E test runner
