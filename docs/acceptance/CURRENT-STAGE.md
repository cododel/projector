# Приёмка текущего этапа Blueprint

Текущий объём дополнен сессиями Codex, терминалами, рабочими пространствами и HTTP-runtime: AC-46–AC-52. База этого изменения — `e3b1a193af37531b2c5b82fd6d0dc5c4471feb72`; результаты ниже относятся к локальным изменениям поверх неё. Свежие `check` и `check:full` прошли; ручные границы перечислены отдельно. Чат, TSX, случаи, автоматическая доставка, управление worktree, VM, новые системные права, подпись релиза и npm bridge не входят. Linux/Windows не прошли отдельную приёмку.

Историческая матрица 32 сценариев ниже сохранена для базы `de23ab200388c312d0cf1aee0bdf8595423a5f30`. AC-08/09/13/16/17/21–25/37/41 относятся к следующему этапу, AC-29 — дополнительный Skills-транспорт. Исторические показатели, процент и green gates не подтверждают автоматически новый runtime и терминальный интерфейс.

Единица готовности — сценарий с применимыми требованиями и соответствующим доказательством. Число зелёных тестов не является процентом готовности. `Подтверждено` означает сочетание исходников и указанных проверок на заявленной границе; ограничения ниже остаются обязательными.

## Текущая матрица терминального этапа

Среда проверок: Blueprint `0.1.0-alpha.1`, Electron `44.7.0`, Node `24.20.0`, node-pty `1.1.0`, xterm `6.0.0`, Codex CLI `0.162.1`, macOS `27.0` (`26A428`). Переносимые библиотеки и loopback HTTP не доказывают совместимость Blueprint с другой ОС.

| AC | Требование и существующая реализация | Текущее доказательство | Статус / оставшаяся граница |
| --- | --- | --- | --- |
| AC-46 | Metadata discovery всех providers/source kinds и archived/non-archived; канонический cwd, отдельные checkout/worktree; внешний processState unknown | `tests/codex.test.ts`: protocol pagination, `useStateDbOnly`, `includeTurns=false`, отсутствие start/resume/repair, неверные ID; `tests/e2e/harness-workspaces.spec.ts`: реальные IPC/UI с controlled CLI fixture, два проекта и архивная сессия. Prerequisite probe установленного CLI отдельно проверил list/read | Подтверждено на protocol/UI boundary. Discovery не доказывает присутствие чужого процесса |
| AC-47 | Owned backend/TUI, exact thread.id нового запуска и выбранного Resume, неизменная originSession; Copy передаёт только сообщение выбранного saved state | `tests/codex.test.ts`: matching root response, wrong-ID rejection, exact fork Resume, запрет policy override; `tests/e2e/harness-workspaces.spec.ts`: actual UI current/historical Copy, выбранный saved state, target terminal focus, Copy only без блокировки UI, нулевой ввод/отсутствие turn/start/Resume, inactive restore и явный Resume. Настоящий TUI с текущим HTTP проверен в source/packaged probes; `codex.spec.ts` отдельно проверил модельное чтение всего состояния и вложения | Подтверждено для перечисленных автоматических границ. CLI fixture не заменяет настоящие probes; OS clipboard не подтверждён |
| AC-48 | Независимые session workspaces и нижние терминалы проекта; вложенные split, пропорции/фокус, повторное открытие view; общие приватные ответы/аннотации при независимых revision/scroll/details | `tests/application-workspace.test.ts`; `tests/e2e/terminals.spec.ts`; `tests/e2e/session-workspace-ui.spec.ts`: реальные xterm/PTY, UI splits и shared artifact work; `tests/e2e/removed-project-workspace.spec.ts`: remove/reopen сохраняет процессы и раскладки | Автоматические границы подтверждены. Синтетический фокус и ввод не доказывают физический desktop focus/clipboard |
| AC-49 | Закрытие view сохраняет PTY; renderer reconnect без запуска; сохранённый экран неактивен после Quit/crash; явный restart; Quit убирает только owned процессы | `tests/terminal.test.ts`, `tests/terminal-electron.test.ts`, `tests/terminal-storage.test.ts`, `tests/renderer-terminal-output.test.ts`: порядок/generation/replay, ошибки записи/cwd, inactive restore; `tests/e2e/terminals.spec.ts`: live PID после reload, Stop Cancel/kill, service crash/restart, current cd→split; `tests/e2e/terminal-delivery.spec.ts`: withheld ACKs и ограничение IPC; `tests/e2e/terminal-quit.spec.ts`: задержанная запись, зависший runtime и устойчивый дочерний процесс | Автоматические границы подтверждены. Контролируемые crash/FS faults не являются испытанием выключения питания |
| AC-50 | Dynamic `127.0.0.1` Streamable HTTP; атомарный private descriptor, token/instance/Host/Origin; operator/PTy только во внутреннем IPC; очередь и UNKNOWN_RESULT без повторной мутации | `tests/runtime-transport.test.ts`, `tests/bridge.test.ts`: реальный HTTP/stdio, stale instance, malformed descriptor, SSE/disconnect/EOF, payload limits, public allowlist и единая очередь; `tests/e2e/disconnection.spec.ts`: утрата operator acknowledgement после записи; `tests/e2e/packaged.spec.ts`: перемещённая unsigned `.app`, bundled helper без system Node и без внешней сети | Подтверждено на transport/IPC/packaged boundary. Токен ограничивает runtime API, а не доступ другого процесса того же пользователя к файлам |
| AC-51 | General/Terminal/Harnesses/Keyboard shortcuts; сохранение, conflicts/disable/reset; настройки не отправляют ввод в работающий терминал, модальные focus guards и composition guards | `tests/application-workspace.test.ts`, `tests/keyboard-shortcuts.test.ts`; `tests/e2e/session-workspace-ui.spec.ts`: запись реальных Electron shortcut events, conflict/dirty cancellation/remap, фактический terminal-service input=0 при Settings, Tab loop, viewport/paint order на 980 px; `tests/codex.test.ts` и `harness-workspaces.spec.ts`: observed MCP startup по exact launch/thread | Частично: физическая клавиатура, настоящий IME/OS-composition и OS clipboard требуют ручной проверки. MCP startup ready не означает непрерывное здоровье соединения или получение сообщения агентом |
| AC-52 | Миграция legacy вкладок в project Plans без дубликатов; прежние документы/saved states читаемы; независимые browser panes, beforeunload/cleanup и приватные записи | `tests/application-workspace.test.ts`: legacy document/home/browser metadata, revision/URL/selection и повтор миграции; `tests/e2e/workspace.spec.ts`, `planning.spec.ts`, `browser-state.spec.ts`, `document-area.spec.ts`: приватная работа, версия/снимок, restart и Save; `tests/e2e/browser-workspace-ownership.spec.ts`: разные native страницы для сессий и сохранность формы; `tests/e2e/native-pane-comment.spec.ts`: первый соседний click не достигает сайта, EACCES сохраняет editor/focus, повтор после успешной записи без replay; browser beforeunload/cleanup проверяются отдельно | Подтверждено для перечисленных metadata/readers/UI границ. Тест legacy migration проверяет модель вкладок, а не физическое обновление произвольного пользовательского профиля |

Предварительные реальные CLI/PTy probes и промежуточные source/packaged проверки описаны в [CODEX-COMPATIBILITY.md](../CODEX-COMPATIBILITY.md). Их нельзя складывать с fixture-тестом и объявлять неподтверждённую сквозную приёмку. Финальные результаты текущего снимка фиксируются отдельно ниже.

## Текущие ограничения и незакрытый контракт

- **UI-02 / AC-07: background show.** Требование не перехватывать проект, сессию, активную панель и ввод при агентном `show_artifact` не подтверждено. Исследование исходного HEAD установило существовавшее до этого изменения расхождение: public show выбирает workspace/план. Проверки Draft preview, сохранения старой привязки комментария, deferred navigation и защиты всех editing scopes не являются доказательством полного background-поведения. Этот контракт остаётся открытым; поведение не расширялось и требование не снималось.
- Hidden Playwright/Electron + настоящие PTY доказывают достигнутые границы логики, ввода и native-view geometry. Они не подтверждают физические клавиши, раскладку/IME, OS-composition, экранную композицию при hardware GPU, жесты или внешние мониторы. Ручной профиль ниже расширяется терминалом/TUI, переключением панелей и настройками; дополнительные Accessibility/Screen Recording permissions не требуются.
- Clipboard в `harness-workspaces.spec.ts` и модельном `codex.spec.ts` перехвачен, чтобы не менять буфер оператора. Проверены точный текст и отсутствие отправки/ввода; настоящее копирование, вставка Unicode и взаимодействие OS clipboard остаются ручной границей. Модель получает скопированный текст через явно сформированный следующий тестовый запрос, а не через автоматическую доставку Blueprint.
- Текущий renderer проверен при 1440 px и минимальных 980 px, с обоими и скрытыми сайдбарами, nested terminal/plan и нижним терминалом. Это layout evidence, не физическая приёмка IME или нативных системных кнопок. Промежуточный дефект Settings overlay/checkbox устранён и защищён проверкой paint order и размеров.
- Нагрузочные показатели прошлого этапа ниже исторические. На новом терминальном исходном снимке профиль AC-39 заново не квалифицирован; CPU/RAM/latency терминального сервиса и TUI из них не выводятся.

## Финальные gates текущего снимка

- `pnpm check`: **GREEN, exit 0** — typecheck/lint, 208 unit, две проверки hooks, 67 hidden E2E за 42.6 с и один ожидаемый opt-in пропуск сетевой модели. Аудит: 82 окна, 0 activation/show/focus. Журнал: `.tmp/tasks/harness-workspaces-20261011/check-handoff-final.log`; audit: `.tmp/e2e-window-audit-ZVN7J6/windows.jsonl`.
- `pnpm check:full`: **GREEN, exit 0** — те же static/unit/hooks, отдельная hidden guarantee (одно окно, 0 activation/show/focus) и 67 видимых E2E за 3.4 мин без пропусков. Журнал: `.tmp/tasks/harness-workspaces-20261011/check-full-handoff-final.log`. Development и перемещённая установленная unsigned `.app` входят в этот gate; свежие снимки документа/терминала визуально проверены.
- Реальная модель Codex после UI Save/Copy прочитала конкретный полный saved state и восемь частей screenshot attachment. Тест сравнил всё состояние и декодированный SHA-256/длину изображения с независимым чтением неизменяемого saved state, затем проверил совместимую Version 2 и сохранённый ответ Member. Вложение — 69 915 байт; отдельный комментарий сохранился в JSON. Тестовые события/сводка: `.tmp/tasks/harness-workspaces-20261011/final-model/`. Перехват OS clipboard не выдаётся за физическую вставку в TUI или автоматическую доставку.
- Настоящий owned Codex TUI с текущим HTTP-runtime: **квалифицирован** отдельно от модели, в source production и relocated package. Exact New/Resume IDs, настоящий guide.4 и MCP startup ready: [CODEX-COMPATIBILITY.md](../CODEX-COMPATIBILITY.md). Перед финальными gates устранена подтверждённая вложенная блокировка Copy; actual UI regression защищает current/historical state, Copy only, target focus и отсутствие terminal input/Resume.
- Физическая клавиатура/IME/OS clipboard: **не выполнена** ручная приёмка. Performance нового снимка: **не выполнена** отдельная квалификация.

Процент текущей готовности не пересчитан: исторический знаменатель 32 дополнен семью сценариями, имеется открытый UI-02/AC-07 контракт и незавершённые ручные/нагрузочные проверки. Локальная реализация и полные GREEN gates не объявляются готовностью 100%, коммитом, push или опубликованным релизом.

### Дополнение: Unicode в метаданных Codex

После интеграционного коммита `d3d44cf09d0a9344715f57ca3e44051332432988` обнаружено расхождение JSONL framing: Node 24 `readline` разделял корректный ответ по U+2028/U+2029 внутри preview. На реальном профиле исходный ответ был валидным JSON с семью U+2028; прежний reader давал `CODEX_PROTOCOL_INVALID_MESSAGE`. LF-only reader сохраняет UTF-8 между частями stdout и прежнюю валидацию/предел сообщений. Regression `tests/codex.test.ts` проверяет discover/read и отсутствие start/Resume, включая разрыв внутри UTF-8 символа.

Повтор полного read-only discovery установленного Codex прошёл: 4557 сессий, без ошибки. Свежий `pnpm check` после исправления: 210 unit, две проверки hooks, 67 hidden E2E за 41.5 с, один ожидаемый opt-in пропуск модели; 82 окна, 0 activation/show/focus. Журнал: `.tmp/tasks/codex-protocol-20261012/check.log`. Видимый `check:full` выше относится к предшествующему интеграционному снимку и после этого исправления не повторялся.

## Историческая матрица 32 сценариев

Следующие статусы отражают прежний отчёт, а не повторную приёмку нового runtime. Для AC-07 действует уточнение открытого контракта выше.

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

## Границы исторических доказательств

- Ошибки ENOSPC/EROFS/ENOENT и сбои до/после rename воспроизводятся на изолированных файлах через fault injection; это не испытание физического заполнения диска или выключения питания. Реальный отказ доступа в UI отдельно проверяет Retry Save A → Save B без публикации работы A.
- Сбой renderer проверяется полным видимым прогоном: `forcefullyCrashRenderer`, trusted recovery choice, восстановление подтверждённых ответов/аннотаций. Диалог выбора подменён в тесте; физическая работа оператора с диалогом не заявлена.
- Запросы camera/microphone/location проверены на реальных Electron handlers с доверенным отказом/разрешением. Наличие устройства, работа камеры и TCC не подтверждены и новых системных прав не запрашивали.
- `instructions.spec.ts` наблюдает инструкции в запросе установленного Codex к локальному провайдеру. Это доказательство доставки; следование модели правилам проверяет отдельный `codex.spec.ts`, не mock provider.
- Нагрузочный прогон использует настоящий production runtime/reader и UI с 50×10 документами/состояниями, 20 виджетами/аннотациями и тремя страницами. Подготовка большого fixture не является испытанием 500 последовательных авторских публикаций через MCP. Измерения на Apple M5 Pro, 18 CPU, 64 GB, macOS 27 не подтверждают машину 16 GB или физическую композицию скрытого окна. RSS — сумма процессов, с возможным повторным учётом shared pages.
- Быстрый `check` остаётся скрытым и исключает сетевой модельный тест. `check:full` включает отдельную гарантию hidden mode и полный применимый видимый функциональный набор с Codex без пропусков. Нагрузочная квалификация — отдельный `pnpm test:performance`, а не дополнительный запуск на каждом pre-push. Pre-commit не добавлен.

## Ручная приёмка без дополнительных прав

Перед заявлением 100% оператор должен пройти видимый изолированный dev/production профиль: Tab/Shift+Tab через выбор проекта/сессии/плана, виджет, Annotate, комментарий, Save и Approve; проверить читаемый фокус и статусы при увеличенном тексте; в каждом редакторе набрать реальный IME-комментарий, выполнить Enter/Shift+Enter/Escape и outside-click. Дополнительно проверить физический ввод/IME в shell и Codex TUI, переходы между split/нижним терминалом/браузером/Settings, сохранение ordinary input при хоткеях и копирование/ручную вставку Unicode без автоматического Enter. Синтетические composition events покрывают защиту логики, но не физический IME/OS-композицию.

## Исторический итог предыдущей проверки

- `pnpm check`: typecheck и lint; 128 unit-проверок, две проверки pre-push и 48 скрытых E2E прошли. Единственный намеренный пропуск — сетевой тест модели Codex. Аудит скрытого режима: 56 окон, 0 activation/show/focus.
- `pnpm check:full`: те же статические и unit-проверки, отдельный hidden-mode E2E и 48 видимых E2E, включая модельный Save-цикл Codex; пропусков нет. Exit 7 в журнале принадлежит намеренно дефектному fixture теста pre-push, который успешно проверяет блокировку push.
- Окончательная нагрузочная квалификация: 100 измерений каждого действия после прогрева; p95 открытия — 1335.852 мс (предел 2000), подтверждённого автосохранения — 541.927 мс (1000), реакции оболочки на переключение браузерных вкладок — 13.800 мс (300). Методика, дерево CPU/RAM и границы измерений: [PERFORMANCE.md](PERFORMANCE.md).

Прежний отчёт оценивал подтверждение как **30 из 32 сценариев — 93.75%**, оставляя AC-40 и AC-44 для ручной приёмки. Это историческая оценка указанной базы; она не является процентом текущего терминального этапа и не закрывает обнаруженное расхождение UI-02/AC-07.
