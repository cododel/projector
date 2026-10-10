# Приёмка текущего этапа Blueprint

База изменений: `de23ab200388c312d0cf1aee0bdf8595423a5f30`. Матрица охватывает 32 текущих сценария PRD; AC-08/09/13/16/17/21–25/37/41 относятся к следующему этапу, AC-29 — дополнительный Skills-транспорт. Чат, TSX, случаи, автоматическая доставка, VM, новые системные права, подпись релиза и npm bridge не входят.

Единица готовности — сценарий с применимыми требованиями и соответствующим доказательством. Число зелёных тестов не является процентом готовности. `Подтверждено` означает сочетание исходников и указанных проверок на заявленной границе; ограничения ниже остаются обязательными.

| AC | Требование / реализация | Проверяемое подтверждение | Статус |
| --- | --- | --- | --- |
| AC-01 | План без прототипа; читаемый документ и аннотации | guide.test.ts; planning.spec.ts | Подтверждено |
| AC-02 | Чистые данные, локальный цикл без внешней сети | packaged.spec.ts (external HTTP/HTTPS denied); dev.spec.ts | Подтверждено |
| AC-03 | Сверка с контрактами; утверждение не разрешает реализацию | guide.test.ts; store.test.ts; planning.spec.ts | Подтверждено |
| AC-04 | Оператор меняет ответы/комментарии, Save отдельно от Approve | planning.spec.ts; stage-completion.spec.ts | Подтверждено |
| AC-05 | Каноническая папка, отдельные checkout; перемещение/копия/удаление | project-lifecycle.test.ts; store.test.ts; stage-completion.spec.ts | Подтверждено |
| AC-06 | Две originSession; отдельные приватные и сохранённые состояния | saved-state.test.ts; workspace.spec.ts; planning.spec.ts | Подтверждено |
| AC-07 | Draft preview; публикация при открытой вкладке/комментарии | document.test.ts; refresh.spec.ts; workspace.spec.ts | Подтверждено |
| AC-10 | Индекс восстанавливается; приватная работа закрыта от MCP | store.test.ts; saved-state.test.ts; planning.spec.ts | Подтверждено |
| AC-11 | До/после manifest, повтор operationId, неизвестный результат | saved-state.test.ts; runtime-reliability.test.ts; disconnection.spec.ts | Подтверждено |
| AC-12 | Ошибки места/доступа/пути, сохранность ввода и Retry | runtime-reliability.test.ts; project-lifecycle.test.ts; stage-completion.spec.ts | Подтверждено на границе ошибок FS |
| AC-14 | JSON-значения, валидация и семантика виджетов | document.test.ts; store.test.ts | Подтверждено |
| AC-15 | Совместимые/новые/изменённые/удалённые ответы; defaults не подтверждение | store.test.ts; stage-completion.spec.ts; revision-summary.ts | Подтверждено |
| AC-18 | Точные цитаты/области; состояние/история/sticky/scroll/zoom | planning.spec.ts; browser.spec.ts; document-area.spec.ts | Подтверждено |
| AC-19 | Annotate по действию; изменения не меняют прежний снимок | planning.spec.ts; browser-state.spec.ts; saved-state.test.ts | Подтверждено |
| AC-20 | Save всего артефакта; MCP читает состояния/изображения, не черновик | saved-state.test.ts; planning.spec.ts; browser-state.spec.ts | Подтверждено |
| AC-26 | Утверждение конкретного состояния; append-only отзыв | store.test.ts; stage-completion.spec.ts | Подтверждено |
| AC-27 | Офлайн темы/references/version, единый UI/MCP источник | guide.test.ts; stage-completion.spec.ts; packaged.spec.ts | Подтверждено |
| AC-28 | Вводная ≤512, доставка отдельно от handshake | guide.test.ts; bridge.test.ts; instructions.spec.ts (Codex 0.162.1) | Подтверждено для указанного клиента |
| AC-30 | Чтение руководства не меняет валидацию/полномочия | guide.test.ts; store.test.ts | Подтверждено |
| AC-31 | Настройка MCP не меняет skills/hooks/AGENTS/чужую конфигурацию | mcp-setup.test.ts; bridge.test.ts; packaged.spec.ts | Подтверждено |
| AC-32 | Идемпотентность/конфликт; cursor для состояния и вложения | saved-state.test.ts; document-area.spec.ts | Подтверждено |
| AC-33 | Save/Approve/черновик недоступны виджетам и MCP | browser.spec.ts; planning.spec.ts | Подтверждено |
| AC-34 | Ошибка до запуска, runtime после закрытия окна, Quit | bridge.test.ts; packaged.spec.ts; runtime notice/menu | Подтверждено |
| AC-35 | Профили, stop/zoom/popup/download/permissions/clear | browser-completion.spec.ts; browser.spec.ts | Подтверждено на trusted Electron boundary |
| AC-36 | Изоляция страницы и запрет привилегированных схем/команд | browser-policy.test.ts; browser.spec.ts | Подтверждено |
| AC-38 | Точные версии и пределы утверждений | docs/CODEX-COMPATIBILITY.md; instructions.spec.ts; packaged.spec.ts | Подтверждено |
| AC-39 | Большой профиль, p95, дерево процессов и lifecycle | stage-performance.spec.ts; browser.spec.ts; workspace.spec.ts | Подтверждено; 100 действий каждого типа |
| AC-40 | Клавиатура, увеличенный текст, видимый фокус | stage-completion.spec.ts; browser-completion.spec.ts; comment-composer.spec.ts; GuideViewer.tsx | Частично: нужна ручная видимая приёмка |
| AC-42 | Чистый цикл MCP→Save→чтение без отдельного сервера | packaged.spec.ts; planning.spec.ts; codex.spec.ts | Подтверждено полным gate с Codex |
| AC-43 | Дерево, отдельные вкладки, toggles, закреплённая панель | workspace.spec.ts; document-area.spec.ts | Подтверждено |
| AC-44 | Размер поля, клавиши/IME guards, outside, write failure, повтор | comment-composer.spec.ts; browser.spec.ts; stage-completion.spec.ts | Частично: физический IME не проверен |
| AC-45 | Закрытие, beforeunload, повтор cleanup, восстановление | workspace.spec.ts; browser.spec.ts; browser-completion.spec.ts | Подтверждено |

## Границы доказательств

- Ошибки ENOSPC/EROFS/ENOENT и сбои до/после rename воспроизводятся на изолированных файлах через fault injection; это не испытание физического заполнения диска или выключения питания. Реальный отказ доступа в UI отдельно проверяет Retry Save A → Save B без публикации работы A.
- Сбой renderer проверяется полным видимым прогоном: `forcefullyCrashRenderer`, trusted recovery choice, восстановление подтверждённых ответов/аннотаций. Диалог выбора подменён в тесте; физическая работа оператора с диалогом не заявлена.
- Запросы camera/microphone/location проверены на реальных Electron handlers с доверенным отказом/разрешением. Наличие устройства, работа камеры и TCC не подтверждены и новых системных прав не запрашивали.
- `instructions.spec.ts` наблюдает инструкции в запросе установленного Codex к локальному провайдеру. Это доказательство доставки; следование модели правилам проверяет отдельный `codex.spec.ts`, не mock provider.
- Нагрузочный прогон использует настоящий production runtime/reader и UI с 50×10 документами/состояниями, 20 виджетами/аннотациями и тремя страницами. Подготовка большого fixture не является испытанием 500 последовательных авторских публикаций через MCP. Измерения на Apple M5 Pro, 18 CPU, 64 GB, macOS 27 не подтверждают машину 16 GB или физическую композицию скрытого окна. RSS — сумма процессов, с возможным повторным учётом shared pages.
- Быстрый `check` остаётся скрытым и исключает сетевой модельный тест. `check:full` включает отдельную гарантию hidden mode и полный применимый видимый функциональный набор с Codex без пропусков. Нагрузочная квалификация — отдельный `pnpm test:performance`, а не дополнительный запуск на каждом pre-push. Pre-commit не добавлен.

## Ручная приёмка без дополнительных прав

Перед заявлением 100% оператор должен пройти видимый изолированный dev/production профиль: Tab/Shift+Tab через выбор плана, виджет, Annotate, комментарий, Save и Approve; проверить читаемый фокус и статусы при увеличенном тексте; в каждом редакторе набрать реальный IME-комментарий, выполнить Enter/Shift+Enter/Escape и outside-click. Синтетические composition events покрывают защиту логики, но не физический IME/OS-композицию.

## Итог текущей проверки

- `pnpm check`: typecheck и lint; 128 unit-проверок, две проверки pre-push и 48 скрытых E2E прошли. Единственный намеренный пропуск — сетевой тест модели Codex. Аудит скрытого режима: 56 окон, 0 activation/show/focus.
- `pnpm check:full`: те же статические и unit-проверки, отдельный hidden-mode E2E и 48 видимых E2E, включая модельный Save-цикл Codex; пропусков нет. Exit 7 в журнале принадлежит намеренно дефектному fixture теста pre-push, который успешно проверяет блокировку push.
- Окончательная нагрузочная квалификация: 100 измерений каждого действия после прогрева; p95 открытия — 1335.852 мс (предел 2000), подтверждённого автосохранения — 541.927 мс (1000), реакции оболочки на переключение браузерных вкладок — 13.800 мс (300). Методика, дерево CPU/RAM и границы измерений: [PERFORMANCE.md](PERFORMANCE.md).

Полностью подтверждены **30 из 32 сценариев — 93.75%**. AC-40 и AC-44 частично подтверждены автоматическими проверками; для их закрытия требуется описанная выше ручная приёмка. Реализация применимого объёма завершена локально, но этап не объявляется готовым на 100% до этой проверки.
