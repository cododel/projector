# Storybook: обозреваемый каталог компонентов и состояний Projector

**Date:** 2026-10-13
**Last reviewed:** 2026-10-13
**Priority:** TODO: оператором не задан
**Severity:** TODO: оценка не задана
**Status:** Open
**Scope affected:** renderer components, interface states, development catalog
**Probes:** `src/renderer/`, `dev/notifications-storyboard.tsx`, `package.json`
**Discovered via:** Operator request to retain the planned Storybook work

## Problem And Impact

Для solo-agent разработки оператору нужен единый обозреваемый каталог компонентов
и полного набора состояний интерфейса, позволяющий контролировать дизайн без
отдельного дизайнера. До этого этапа доступна была только раскадровка уведомлений.
Теперь Storybook 10.6.2 внедрён: первый этап включает уведомления и строки сессий;
полный каталог остаётся в процессе наполнения.

## Evidence And Current Boundary

- `dev/notifications-storyboard.tsx` использует реальные NotificationStack и controller;
  `pnpm storyboard:notifications` собирает автономную страницу с девятью состояниями
  и интерактивными переходами.
- Оператор сначала поручил внедрить общие уведомления. Storybook был согласован как
  отдельный следующий этап; при closeout оператор напомнил «и про storybook не забудь».
- Каталог должен показывать реальные компоненты и их состояния, а не независимые
  HTML-макеты, способные разойтись с приложением.

## Current Implementation And Remaining Work

Оператор 2026-10-13 поручил внедрить Storybook и начать полный каталог с уведомлений
и строк сессий. Первый этап реализован: `.storybook/`, `dev/stories/`, production CSS
и компоненты, локальные fixtures, Controls/Docs/Actions/Interactions/Accessibility,
совместные листы состояний и интерактивные сценарии. `dev/catalog.ts` включает карту
всех renderer TSX sources с явным различием included/planned/native boundaries.
Standalone notification storyboard сохранён и использует те же fixtures.

- Запуск: `pnpm storybook`; статическая сборка: `pnpm build:storybook`.
- Browser/a11y/interactions: `pnpm test:storybook`, Chromium с обычным и reduced motion.
- Визуальные регрессии: `pnpm test:storybook:visual`, локальные platform baselines.
- Правила пополнения и границы изоляции: [dev/README](../../dev/README.md).

Следующие компоненты перечислены в карте покрытия, без назначенного оператором
приоритета: menus/splits/resizers, dashboard, comment composer, settings, guide,
icons, notification access. Для document/browser/terminal/bootstrap нужны
явные локальные seams; не подменять native-поведение независимыми HTML-макетами.
Issue остаётся Open до наполнения полного каталога. Внедрение инфраструктуры не
означает покрытие всех состояний всех интерфейсов.

## Completion Criteria

- [x] Единая локальная команда запуска и статической сборки каталога документирована.
- [x] Навигация показывает компоненты, составные интерфейсы и карту их состояний.
- [x] Состояния используют production-компоненты, стили и детерминированные данные.
- [x] Для каждого включённого компонента перечислены применимые normal, hover, focus,
      selected, disabled, pending, empty, success/warning/error и длинное содержимое;
      неподдерживаемые варианты явно отмечены, покрытие не заявлено без инвентаря.
- [x] Можно просматривать переходы, keyboard и reduced motion, фиксировать визуальные
      регрессии; native-only поведение имеет отдельную границу проверки.
- [x] Каталог не пишет реальные session/project/profile данные и не запускает реальные
      Archive/Undo, процессы или модельные операции.
- [x] Документация позволяет агенту находить и обновлять состояния при изменении UI.

- [ ] Все реальные компоненты и составные интерфейсы из карты имеют обозреваемые
      stories применимых состояний; оставшиеся native-only границы явно подтверждены.

## Related

- [PRD](../../PRD.md)
- [Notification storyboard](../../dev/README.md)
- [Testing boundaries](../testing/TESTING.md)

## Expanded catalogue implementation

The approved full-UI plan replaces file-level included/planned flags with explicit
entities, reachable states, occurrence conditions and transitions. Renderer shell
and document presentation are shared with the App; browser fixtures stay isolated.
The overview distinguishes story presence, interactions, platform baselines and
executed results. Native surfaces have a separate Electron matrix, with missing
or physical/manual evidence retained explicitly. `pnpm test:catalog` is the separate
required UI gate alongside `pnpm check`. Final qualification is recorded in the
current task closeout; this entry does not infer native/physical verification.
