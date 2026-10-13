# Notification storyboard

Run `pnpm storyboard:notifications`, then open `.tmp/notifications-storyboard/index.html`
in a browser. The generated page is self-contained and makes no network requests.

`notifications-storyboard.tsx` renders the production `NotificationStack` and controller.
Nine fixed frames cover hidden, info, warning, error, Undo, pending, three alerts,
overflow and long content. Fixed frames pause automatic timers. Interactive controls
exercise entry/exit, Retry → Undo, dismissal, overflow, details and visible-time expiry
without changing real sessions or files. Reduced motion follows the browser preference.

This is a notification-specific development surface. The full component/state catalog
is tracked in [the Storybook issue](../docs/issues/[OPEN]-2026-10-13-storybook-interface-state-catalog.md).
Native Electron pointer routing requires separate desktop validation.
