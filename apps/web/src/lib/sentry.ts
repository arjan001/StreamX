/**
 * Sentry error tracking configuration.
 *
 * This module initializes Sentry for the Streamix app. It captures errors
 * automatically, links them to APK versions via release tracking, and
 * includes user context (device model, platform) for easier debugging.
 *
 * To enable:
 * 1. Create a free account at https://sentry.io
 * 2. Create a new project for "Streamix" (JavaScript/React)
 * 3. Copy the DSN (Data Source Name) from the project settings
 * 4. Add it as a VITE_SENTRY_DSN environment variable
 *
 * The SDK is lightweight and only sends data when errors occur.
 * Free tier: 5,000 errors/month with 30-day retention.
 */

import * as Sentry from '@sentry/browser';
import { currentPlatform } from './platform';

/**
 * Initialize Sentry if a DSN is configured.
 * If no DSN is found, Sentry is silently disabled — no errors are thrown.
 */
export function initSentry(dsn: string | undefined, appVersion: string | undefined) {
  if (!dsn) {
    console.debug('[Sentry] No DSN configured — error tracking disabled');
    return;
  }

  const platform = currentPlatform();

  Sentry.init({
    dsn,
    environment: platform === 'android' ? 'android' : 'web',
    release: appVersion ? `streamix@${appVersion}` : undefined,
    dist: appVersion ? appVersion.split('+')[1] : undefined,

    // Performance monitoring — sample 10% of transactions to stay within free tier
    tracesSampleRate: 0.1,

    // Error sampling — capture all errors
    sampleRate: 1.0,

    // User context — helps identify which devices are affected
    initialScope: {
      tags: {
        platform,
      },
    },

    // Filter out common noise — these are expected and not actionable
    ignoreErrors: [
      // Network errors that happen during normal usage (e.g., user disconnects)
      'Network request failed',
      'Failed to fetch',
      'Load rejected',
      'ChunkLoadError',

      // Browser-specific noise
      'ResizeObserver loop limit exceeded',
      'Non-Error promise rejection captured',

      // Ad blockers and extensions
      'Cannot read properties of undefined',
    ],

    // Max breadcrumbs — keeps payloads small
    maxBreadcrumbs: 50,

    // Before sending — add any last-minute filtering
    beforeSend(event) {
      // Remove sensitive data from URLs
      if (event.request?.url) {
        event.request.url = event.request.url.replace(/password=[^&]*/, 'password=[REDACTED]');
      }
      return event;
    },
  });

  console.debug(`[Sentry] Initialized — release: ${appVersion}, platform: ${platform}`);
}

/**
 * Set the current user's context for error tracking.
 * This helps identify which user experienced an error.
 */
export function setSentryUser(userId: string, username: string) {
  Sentry.setUser({
    id: userId,
    username,
  });
}

/**
 * Clear the user context when logging out.
 */
export function clearSentryUser() {
  Sentry.setUser(null);
}

/**
 * Capture a custom error with context.
 * Use this for errors that you want to track explicitly.
 */
export function captureError(error: Error | string, context?: Record<string, string | number | boolean>) {
  const message = typeof error === 'string' ? error : error.message;
  Sentry.captureException(error, {
    tags: context,
    extra: { context },
  });
  console.error(`[Sentry] ${message}`, context || '');
}

/**
 * Capture a custom message (info/warning level).
 */
export function captureMessage(message: string, level: 'info' | 'warning' = 'info') {
  Sentry.captureMessage(message, level);
}
