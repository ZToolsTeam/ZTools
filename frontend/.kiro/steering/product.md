# Product Overview

ZTools Frontend is a Vue 3-based plugin marketplace and management interface for the ZTools desktop application. It runs in a CEF (Chromium Embedded Framework) environment within a Delphi host application.

## Core Features

- Plugin marketplace browsing and installation
- Local plugin management and favorites
- User authentication and profiles
- Feature request wall (wish wall)
- App and plugin update management
- Developer tools and diagnostics

## Runtime Environments

The application supports three modes:

1. **CEF Mode** (production): Full functionality within Delphi host with Native API access
2. **Browser Dev Mode**: Development in browser with Backend API only
3. **Mock Mode**: Standalone development with simulated data

## API Architecture

- **Backend API**: HTTP endpoints for marketplace, auth, updates, statistics
- **Native API**: CEF bridge to Delphi for system operations, local plugins, window control
- **Mock API**: Fallback test data when Backend/Native unavailable

All API calls must go through `src/api/apiserver.js` for unified access.
